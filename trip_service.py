"""Centralized Trip Service.

This module provides a unified TripService class that consolidates all trip
processing logic, eliminating duplications across the codebase. It wraps
TripProcessor and provides batch processing, validation, geocoding, and
map matching capabilities for both Bouncie and uploaded trips.
"""

import asyncio
import json
import logging
import os
import time
from collections.abc import Callable
from functools import wraps
from typing import Any

from fastapi import HTTPException, status
from pymongo.errors import DuplicateKeyError

from db import (
    find_with_retry,
    get_trip_by_id,
    matched_trips_collection,
    trips_collection,
)
from trip_processor import TripProcessor, TripState
from utils import haversine, validate_trip_data

logger = logging.getLogger(__name__)


class ProcessingOptions:
    """Configuration for trip processing options."""

    def __init__(
        self,
        validate: bool = True,
        geocode: bool = True,
        map_match: bool = False,
        validate_only: bool = False,
        geocode_only: bool = False,
    ):
        self.validate = validate
        self.geocode = geocode
        self.map_match = map_match
        self.validate_only = validate_only
        self.geocode_only = geocode_only


class BatchProcessingResult:
    """Result container for batch processing operations."""

    def __init__(self):
        self.total = 0
        self.validated = 0
        self.geocoded = 0
        self.map_matched = 0
        self.failed = 0
        self.skipped = 0
        self.errors = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "validated": self.validated,
            "geocoded": self.geocoded,
            "map_matched": self.map_matched,
            "failed": self.failed,
            "skipped": self.skipped,
            "errors": self.errors,
        }


def with_comprehensive_handling(func: Callable) -> Callable:
    """Decorator for comprehensive error handling and logging."""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        start_time = time.time()
        try:
            result = await func(*args, **kwargs)
            duration = time.time() - start_time
            logger.info("Successfully completed %s in %.2fs", func.__name__, duration)
            return result
        except HTTPException:
            raise
        except DuplicateKeyError as e:
            logger.warning("Duplicate key error in %s: %s", func.__name__, e)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Trip already exists"
            )
        except Exception as e:
            duration = time.time() - start_time
            logger.exception(
                "Error in %s after %.2fs: %s", func.__name__, duration, str(e)
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Processing error: {str(e)}",
            )

    return wrapper


def with_db_retry(func: Callable) -> Callable:
    """Decorator for database operations with retry logic."""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        max_retries = 3
        for attempt in range(max_retries):
            try:
                return await func(*args, **kwargs)
            except Exception as e:
                if attempt == max_retries - 1:
                    logger.error(
                        "Database operation %s failed after %d retries: %s",
                        func.__name__,
                        max_retries,
                        str(e),
                    )
                    raise
                logger.warning(
                    "Database operation %s failed (attempt %d/%d), retrying: %s",
                    func.__name__,
                    attempt + 1,
                    max_retries,
                    str(e),
                )
                await asyncio.sleep(1.0 * (attempt + 1))

    return wrapper


def with_progress_tracking(progress_key: str = None):
    """Decorator for progress tracking updates."""

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # Extract progress tracker from kwargs if available
            progress_tracker = kwargs.get("progress_tracker")
            if progress_tracker and progress_key:
                progress_tracker[progress_key]["status"] = "running"
                progress_tracker[progress_key]["message"] = f"Starting {func.__name__}"

            try:
                result = await func(*args, **kwargs)
                if progress_tracker and progress_key:
                    progress_tracker[progress_key]["status"] = "completed"
                    progress_tracker[progress_key][
                        "message"
                    ] = f"Completed {func.__name__}"
                return result
            except Exception as e:
                if progress_tracker and progress_key:
                    progress_tracker[progress_key]["status"] = "failed"
                    progress_tracker[progress_key][
                        "message"
                    ] = f"Failed {func.__name__}: {str(e)}"
                raise

        return wrapper

    return decorator


class TripService:
    """Centralized service for all trip processing operations."""

    def __init__(self, mapbox_token: str = None):
        self.mapbox_token = mapbox_token or os.getenv("MAPBOX_ACCESS_TOKEN", "")
        self._init_collections()

    def _init_collections(self):
        """Initialize database collections."""
        self.trips_collection = trips_collection
        self.matched_trips_collection = matched_trips_collection

    @staticmethod
    def standardize_gps_data(gps_input: Any, transaction_id: str) -> dict | None:
        """Standardize GPS data into consistent GeoJSON format."""
        processed_coords = []

        if isinstance(gps_input, str):
            try:
                gps_data = json.loads(gps_input)
            except json.JSONDecodeError:
                logger.warning(
                    "Trip %s: Invalid JSON string in GPS data",
                    transaction_id,
                )
                return None
        elif isinstance(gps_input, (list, dict)):
            gps_data = gps_input
        else:
            logger.warning(
                "Trip %s: GPS data is of unexpected type: %s",
                transaction_id,
                type(gps_input).__name__,
            )
            return None

        if isinstance(gps_data, list):
            raw_coords = gps_data
        elif isinstance(gps_data, dict):
            if (
                gps_data.get("type") in ["Point", "LineString"]
                and "coordinates" in gps_data
            ):
                raw_coords = gps_data.get("coordinates")
                if gps_data["type"] == "Point":
                    if (
                        isinstance(raw_coords, list)
                        and len(raw_coords) == 2
                        and all(isinstance(c, (int, float)) for c in raw_coords)
                    ):
                        raw_coords = [raw_coords]
                    else:
                        logger.warning(
                            "Trip %s: GPS data (dict, Point) has invalid coordinates",
                            transaction_id,
                        )
                        return None
            else:
                logger.warning(
                    "Trip %s: GPS data (dict) is not a valid GeoJSON Point or LineString",
                    transaction_id,
                )
                return None
        else:
            logger.warning(
                "Trip %s: GPS data structure not recognized",
                transaction_id,
            )
            return None

        # Process coordinates
        for coord_pair in raw_coords:
            if (
                isinstance(coord_pair, list)
                and len(coord_pair) >= 2
                and all(isinstance(c, (int, float)) for c in coord_pair[:2])
            ):
                lon, lat = coord_pair[0], coord_pair[1]
                if -180 <= lon <= 180 and -90 <= lat <= 90:
                    processed_coords.append([lon, lat])
                else:
                    logger.warning(
                        "Trip %s: Coordinate out of bounds: [%s, %s]",
                        transaction_id,
                        lon,
                        lat,
                    )

        if not processed_coords:
            logger.warning("Trip %s: No valid coordinates found", transaction_id)
            return None

        # Deduplicate consecutive identical coordinates
        unique_coords = []
        for coord in processed_coords:
            if not unique_coords or coord != unique_coords[-1]:
                unique_coords.append(coord)

        # Return appropriate GeoJSON based on coordinate count
        if len(unique_coords) == 1:
            return {
                "type": "Point",
                "coordinates": unique_coords[0],
            }
        else:
            return {
                "type": "LineString",
                "coordinates": unique_coords,
            }

    @staticmethod
    def calculate_trip_distance(coordinates: list[list[float]]) -> float:
        """Calculate total distance of a trip in miles."""
        if len(coordinates) < 2:
            return 0.0

        total_distance_meters = 0.0
        for i in range(len(coordinates) - 1):
            lon1, lat1 = coordinates[i]
            lon2, lat2 = coordinates[i + 1]
            total_distance_meters += haversine(lon1, lat1, lon2, lat2, unit="meters")

        return total_distance_meters * 0.000621371  # Convert to miles

    @staticmethod
    def validate_trip_structure(trip_data: dict[str, Any]) -> tuple[bool, str | None]:
        """Validate trip data structure and required fields."""
        return validate_trip_data(trip_data)

    @with_comprehensive_handling
    @with_db_retry
    async def get_trip_by_id(self, trip_id: str) -> dict[str, Any] | None:
        """Retrieve a trip by its ID."""
        return await get_trip_by_id(trip_id, self.trips_collection)

    @with_comprehensive_handling
    async def process_single_trip(
        self,
        trip_data: dict[str, Any],
        options: ProcessingOptions,
        source: str = "api",
    ) -> dict[str, Any]:
        """Process a single trip with specified options."""
        processor = TripProcessor(
            mapbox_token=self.mapbox_token,
            source=source,
        )
        processor.set_trip_data(trip_data)

        if options.validate_only:
            await processor.validate()
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "is_valid": processing_status["state"] == TripState.VALIDATED.value,
            }

        if options.geocode_only:
            await processor.validate()
            if processor.state == TripState.VALIDATED:
                await processor.process_basic()
                if processor.state == TripState.PROCESSED:
                    await processor.geocode()

            saved_id = await processor.save()
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "geocoded": processing_status["state"] == TripState.GEOCODED.value,
                "saved_id": saved_id,
            }

        # Full processing
        await processor.process(do_map_match=options.map_match)
        saved_id = await processor.save(map_match_result=options.map_match)
        processing_status = processor.get_processing_status()

        return {
            "status": "success",
            "processing_status": processing_status,
            "completed": processing_status["state"] == TripState.COMPLETED.value,
            "saved_id": saved_id,
        }

    @with_comprehensive_handling
    async def process_batch_trips(
        self,
        query: dict[str, Any],
        options: ProcessingOptions,
        limit: int = 100,
        progress_tracker: dict = None,
    ) -> BatchProcessingResult:
        """Process multiple trips in batch with configurable options."""
        result = BatchProcessingResult()

        # Ensure reasonable limit
        limit = min(limit, 500)

        # Find trips matching query
        trips = await find_with_retry(self.trips_collection, query, limit=limit)
        if not trips:
            return result

        result.total = len(trips)

        for i, trip in enumerate(trips):
            if progress_tracker:
                progress = int((i / len(trips)) * 100)
                progress_tracker["progress"] = progress
                progress_tracker["message"] = f"Processing trip {i + 1} of {len(trips)}"

            try:
                trip_result = await self.process_single_trip(
                    trip, options, trip.get("source", "unknown")
                )

                # Update counters based on processing result
                processing_status = trip_result.get("processing_status", {})
                state = processing_status.get("state")

                if state == TripState.VALIDATED.value:
                    result.validated += 1
                elif state == TripState.GEOCODED.value:
                    result.geocoded += 1
                elif (
                    state == TripState.MAP_MATCHED.value
                    or state == TripState.COMPLETED.value
                ):
                    result.map_matched += 1
                elif state == TripState.FAILED.value:
                    result.failed += 1

            except Exception as e:
                result.failed += 1
                result.errors.append(
                    {"trip_id": trip.get("transactionId", "unknown"), "error": str(e)}
                )
                logger.error(
                    "Error processing trip %s: %s",
                    trip.get("transactionId"),
                    str(e),
                )

        return result

    @with_comprehensive_handling
    async def process_uploaded_trip(
        self,
        trip_data: dict[str, Any],
        source: str = "upload",
    ) -> str | None:
        """Process and store an uploaded trip."""
        # Standardize GPS data if needed
        gps_data = trip_data.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
                trip_data["gps"] = gps_data
            except json.JSONDecodeError:
                transaction_id = trip_data.get("transactionId", "unknown")
                logger.warning("Invalid GPS data for trip %s", transaction_id)
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid GPS JSON for trip {transaction_id}",
                )

        # Process with TripProcessor
        processor = TripProcessor(
            mapbox_token=self.mapbox_token,
            source=source,
        )
        processor.set_trip_data(trip_data)
        await processor.process(do_map_match=False)
        return await processor.save()

    @with_comprehensive_handling
    @with_progress_tracking("fetch_and_store_trips")
    async def process_bouncie_trips(
        self,
        trips_data: list[dict[str, Any]],
        do_map_match: bool = False,
        progress_tracker: dict = None,
    ) -> list[str]:
        """Process multiple Bouncie trips."""
        processed_trip_ids = []

        for i, trip in enumerate(trips_data):
            if progress_tracker:
                progress = int((i / len(trips_data)) * 100)
                progress_tracker["fetch_and_store_trips"]["progress"] = progress
                progress_tracker["fetch_and_store_trips"][
                    "message"
                ] = f"Processing trip {i + 1} of {len(trips_data)}"

            transaction_id = trip.get("transactionId", "unknown")

            if not trip.get("endTime"):
                logger.warning(
                    "Skipping trip %s because 'endTime' is missing",
                    transaction_id,
                )
                continue

            try:
                options = ProcessingOptions(
                    validate=True,
                    geocode=True,
                    map_match=do_map_match,
                )

                result = await self.process_single_trip(trip, options, source="api")

                if result.get("saved_id"):
                    processed_trip_ids.append(result["saved_id"])

            except Exception as e:
                logger.error(
                    "Failed to process Bouncie trip %s: %s",
                    transaction_id,
                    str(e),
                )

        return processed_trip_ids

    @with_comprehensive_handling
    async def remap_trips(
        self,
        trip_ids: list[str] = None,
        query: dict[str, Any] = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Remap trips using map matching."""
        if trip_ids:
            trips = []
            for trip_id in trip_ids:
                trip = await self.get_trip_by_id(trip_id)
                if trip:
                    trips.append(trip)
        elif query:
            trips = await find_with_retry(self.trips_collection, query, limit=limit)
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Either trip_ids or query must be provided",
            )

        options = ProcessingOptions(
            validate=False,
            geocode=False,
            map_match=True,
        )

        result = await self.process_batch_trips({}, options, limit=len(trips))
        return result.to_dict()

    @with_comprehensive_handling
    async def refresh_geocoding(
        self,
        trip_ids: list[str],
    ) -> dict[str, Any]:
        """Refresh geocoding for specified trips."""
        results = {
            "total": len(trip_ids),
            "updated": 0,
            "failed": 0,
            "errors": [],
        }

        for trip_id in trip_ids:
            try:
                trip = await self.get_trip_by_id(trip_id)
                if not trip:
                    results["failed"] += 1
                    results["errors"].append(f"Trip {trip_id} not found")
                    continue

                options = ProcessingOptions(
                    validate=False,
                    geocode=True,
                    map_match=False,
                )

                await self.process_single_trip(
                    trip, options, trip.get("source", "unknown")
                )
                results["updated"] += 1

            except Exception as e:
                results["failed"] += 1
                results["errors"].append(f"Trip {trip_id}: {str(e)}")
                logger.error(
                    "Error refreshing geocoding for trip %s: %s", trip_id, str(e)
                )

        return results
