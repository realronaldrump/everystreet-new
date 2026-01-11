import asyncio
import json
import logging
import time
from collections.abc import Callable
from functools import wraps
from typing import Any

from fastapi import HTTPException, status
from pymongo.errors import DuplicateKeyError

from admin_api import get_persisted_app_settings
from config import get_mapbox_token
from db.models import Trip
from trip_processor import TripProcessor, TripState

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
            # Reduce log noise for very hot paths
            if func.__name__ in ("process_single_trip",):
                logger.debug(
                    "Successfully completed %s in %.2fs", func.__name__, duration
                )
            else:
                logger.info(
                    "Successfully completed %s in %.2fs", func.__name__, duration
                )
            return result
        except DuplicateKeyError as e:
            logger.warning("Duplicate key error in %s: %s", func.__name__, e)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Trip already exists"
            )
        except Exception as e:
            duration = time.time() - start_time
            logger.exception("Error in %s after %.2fs: %s", func.__name__, duration, e)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Processing error: {str(e)}",
            )

    return wrapper


class TripService:
    """Centralized service for all trip processing operations."""

    def __init__(self, mapbox_token: str = None):
        self.mapbox_token = mapbox_token or get_mapbox_token()

    @with_comprehensive_handling
    async def get_trip_by_id(self, trip_id: str) -> dict[str, Any] | None:
        """Retrieve a trip by its ID."""
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if trip:
            return trip.model_dump()
        return None

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

        # Optimized configurable pipeline
        await processor.validate()

        if processor.state != TripState.VALIDATED:
            saved_id = await processor.save(_map_match_result=False)
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "completed": processing_status["state"] == TripState.COMPLETED.value,
                "saved_id": saved_id,
            }

        await processor.process_basic()
        if processor.state == TripState.FAILED:
            saved_id = await processor.save(_map_match_result=False)
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "completed": processing_status["state"] == TripState.COMPLETED.value,
                "saved_id": saved_id,
            }

        if options.geocode:
            await processor.geocode()
            if processor.state == TripState.FAILED:
                saved_id = await processor.save(_map_match_result=False)
                processing_status = processor.get_processing_status()
                return {
                    "status": "success",
                    "processing_status": processing_status,
                    "completed": processing_status["state"]
                    == TripState.COMPLETED.value,
                    "saved_id": saved_id,
                }

        if options.map_match:
            await processor.map_match()

        saved_id = await processor.save(_map_match_result=options.map_match)
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
        trips = await Trip.find(query).limit(limit).to_list()
        if not trips:
            return result

        result.total = len(trips)

        for i, trip_model in enumerate(trips):
            trip = trip_model.model_dump()
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
                elif state in {TripState.MAP_MATCHED.value, TripState.COMPLETED.value}:
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
    async def process_bouncie_trips(
        self,
        trips_data: list[dict[str, Any]],
        do_map_match: bool = False,
        progress_tracker: dict = None,
    ) -> list[str]:
        """Process multiple Bouncie trips.

        Returns a list of transactionIds that were successfully saved (not ObjectIds).
        """
        processed_trip_ids: list[str] = []
        progress_section = None

        if progress_tracker:
            progress_section = progress_tracker.get("fetch_and_store_trips")
            if progress_section is not None:
                progress_section.setdefault("progress", 0)
                progress_section["status"] = "running"
                progress_section["message"] = "Starting trip processing"

        try:
            # Get app settings to check geocoding preference
            app_settings = await get_persisted_app_settings()
            geocode_enabled = app_settings.get("geocodeTripsOnFetch", True)

            # Pre-skip duplicates already present in DB and deduplicate inputs
            unique_trips: list[dict[str, Any]] = []
            seen_incoming: set[str] = set()
            for t in trips_data:
                tx = t.get("transactionId")
                if not tx or tx in seen_incoming:
                    continue
                seen_incoming.add(tx)
                unique_trips.append(t)

            trips_to_process = []
            if unique_trips:
                incoming_ids = [
                    t.get("transactionId")
                    for t in unique_trips
                    if t.get("transactionId")
                ]

                # Query existing trips to check their status using Beanie
                existing_docs = (
                    await Trip.find(Trip.transactionId.in_(incoming_ids))
                    .project(Trip.transactionId, Trip.matchedGps)
                    .to_list()
                )

                existing_by_id = {}
                for d in existing_docs:
                    d_dict = d.model_dump() if hasattr(d, "model_dump") else dict(d)
                    existing_by_id[d_dict.get("transactionId")] = d_dict

                # Determine which trips need processing
                for trip in unique_trips:
                    transaction_id = trip.get("transactionId")
                    if not transaction_id:
                        continue

                    existing_trip = existing_by_id.get(transaction_id)

                    if not existing_trip:
                        # New trip - always process
                        trips_to_process.append(trip)
                    elif do_map_match and not existing_trip.get("matchedGps"):
                        # Map matching requested and missing - process
                        trips_to_process.append(trip)

            skipped_count = len(seen_incoming) - len(trips_to_process)
            logger.info(
                "Processing Bouncie trips: Total incoming=%d, Unique=%d, To Process=%d, Skipped=%d (existing/duplicates)",
                len(trips_data),
                len(seen_incoming),
                len(trips_to_process),
                skipped_count,
            )
            if progress_section is not None:
                progress_section["message"] = (
                    f"Starting trip processing "
                    f"(skipped {skipped_count} existing/duplicate trips)"
                )

            for index, trip in enumerate(trips_to_process):
                if progress_section is not None and trips_data:
                    progress_section["progress"] = int(
                        (index / max(1, len(trips_to_process))) * 100
                    )
                    progress_section["message"] = "Processing trips..."

                transaction_id = trip.get("transactionId", "unknown")

                if not trip.get("endTime"):
                    logger.debug(
                        "Skipping trip %s because 'endTime' is missing",
                        transaction_id,
                    )
                    continue

                try:
                    options = ProcessingOptions(
                        validate=True,
                        geocode=geocode_enabled,
                        map_match=do_map_match,
                    )

                    result = await self.process_single_trip(
                        trip,
                        options,
                        source="api",
                    )

                    if result.get("saved_id"):
                        processed_trip_ids.append(transaction_id)

                except Exception as trip_error:
                    logger.error(
                        "Failed to process Bouncie trip %s: %s",
                        transaction_id,
                        str(trip_error),
                    )

            return processed_trip_ids
        except Exception as exc:
            if progress_section is not None:
                progress_section["status"] = "failed"
                progress_section["message"] = f"Failed to process trips: {exc}"
            raise
        finally:
            if (
                progress_section is not None
                and progress_section.get("status") != "failed"
            ):
                progress_section["status"] = "completed"
                progress_section["progress"] = 100
                progress_section["message"] = "Completed trip processing"

    @with_comprehensive_handling
    async def remap_trips(
        self,
        trip_ids: list[str] = None,
        query: dict[str, Any] = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Remap trips using map matching."""
        trips = []
        if trip_ids:
            for trip_id in trip_ids:
                trip = await self.get_trip_by_id(trip_id)
                if trip:
                    trips.append(trip)
        elif query:
            # Beanie find with query
            trip_models = await Trip.find(query).limit(limit).to_list()
            trips = [t.model_dump() for t in trip_models]
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Either trip_ids or query must be provided",
            )

        # process_batch_trips expects dict query, but here we already fetched the trips
        # actually process_batch_trips takes a query, NOT a list of trips.
        # So we should call process_single_trip in a loop here, OR reuse process_batch_trips logic.

        # But wait, original code did:
        # result = await self.process_batch_trips({}, options, limit=len(trips))
        # That {} query is WRONG if we wanted to process specific trips.
        # process_batch_trips uses "find_with_retry(..., query)".

        # We need to adapt logic. process_batch_trips is designed to find by query.
        # But if we have specific IDs, constructing a query is better.

        options = ProcessingOptions(
            validate=False,
            geocode=False,
            map_match=True,
        )

        # If we have trip_ids, we can pass a query to process_batch_trips
        if trip_ids:
            batch_query = {"transactionId": {"$in": trip_ids}}
            result = await self.process_batch_trips(
                batch_query, options, limit=len(trip_ids)
            )
            return result.to_dict()
        if query:
            # Just pass the query
            result = await self.process_batch_trips(query, options, limit=limit)
            return result.to_dict()

        # If we reached here (shouldn't happen due to check above)
        return BatchProcessingResult().to_dict()

    @with_comprehensive_handling
    async def refresh_geocoding(
        self,
        trip_ids: list[str],
        skip_if_exists: bool = True,
        progress_callback: callable = None,
    ) -> dict[str, Any]:
        """Refresh geocoding for specified trips."""
        results = {
            "total": len(trip_ids),
            "updated": 0,
            "skipped": 0,
            "failed": 0,
            "errors": [],
        }

        for idx, trip_id in enumerate(trip_ids):
            try:
                if progress_callback:
                    if asyncio.iscoroutinefunction(progress_callback):
                        await progress_callback(idx + 1, len(trip_ids), trip_id)
                    else:
                        progress_callback(idx + 1, len(trip_ids), trip_id)

                trip = await self.get_trip_by_id(trip_id)
                if not trip:
                    results["failed"] += 1
                    results["errors"].append(f"Trip {trip_id} not found")
                    continue

                # Skip if addresses already exist and skip_if_exists is True
                if skip_if_exists:
                    has_start = bool(
                        trip.get("startLocation")
                        and trip.get("startLocation").get("formatted_address")
                    )
                    has_destination = bool(
                        trip.get("destination")
                        and trip.get("destination").get("formatted_address")
                    )
                    if has_start and has_destination:
                        results["skipped"] += 1
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
