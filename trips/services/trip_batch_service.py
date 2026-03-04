import asyncio
import logging
import time
from collections.abc import Callable
from functools import wraps
from typing import Any

from fastapi import HTTPException, status

from db.models import Trip
from trips.pipeline import TripPipeline

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
    ) -> None:
        self.validate = validate
        self.geocode = geocode
        self.map_match = map_match
        self.validate_only = validate_only
        self.geocode_only = geocode_only


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
                    "Successfully completed %s in %.2fs",
                    func.__name__,
                    duration,
                )
            else:
                logger.info(
                    "Successfully completed %s in %.2fs",
                    func.__name__,
                    duration,
                )
        except Exception as e:
            duration = time.time() - start_time
            if e.__class__.__name__ == "DuplicateKeyError":
                logger.warning("Duplicate key error in %s: %s", func.__name__, e)
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Trip already exists",
                )
            logger.exception("Error in %s after %.2fs", func.__name__, duration)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Processing error",
            )
        else:
            return result

    return wrapper


class TripService:
    """Centralized service for all trip processing operations."""

    def __init__(self) -> None:
        self._pipeline = TripPipeline()

    @with_comprehensive_handling
    async def get_trip_by_id(self, trip_id: str) -> Trip | None:
        """Retrieve a trip by its ID."""
        return await Trip.find_one(Trip.transactionId == trip_id)

    async def process_single_trip(
        self,
        trip_data: dict[str, Any],
        options: ProcessingOptions,
        source: str = "api",
        *,
        do_coverage: bool = False,
    ) -> dict[str, Any]:
        """Process a single trip with specified options."""
        if options.validate_only:
            validation = await self._pipeline.validate_raw_trip(trip_data)
            processing_status = validation.get("processing_status", {})
            return {
                "status": "success",
                "processing_status": processing_status,
                "is_valid": processing_status.get("state") == "validated",
            }

        if options.geocode_only:
            trip = await self._pipeline.process_raw_trip(
                trip_data,
                source=source,
                do_map_match=False,
                do_geocode=True,
                do_coverage=do_coverage,
            )
            processing_status = {
                "state": (
                    getattr(trip, "processing_state", "completed") if trip else "failed"
                ),
                "history": getattr(trip, "processing_history", []) if trip else [],
                "errors": {},
                "transaction_id": trip_data.get("transactionId", "unknown"),
            }
            return {
                "status": "success",
                "processing_status": processing_status,
                "geocoded": bool(trip and getattr(trip, "geocoded_at", None)),
                "saved_id": str(trip.id) if trip else None,
            }

        trip = await self._pipeline.process_raw_trip(
            trip_data,
            source=source,
            do_map_match=options.map_match,
            do_geocode=options.geocode,
            do_coverage=do_coverage,
        )
        processing_status = {
            "state": (
                getattr(trip, "processing_state", "completed") if trip else "failed"
            ),
            "history": getattr(trip, "processing_history", []) if trip else [],
            "errors": {},
            "transaction_id": trip_data.get("transactionId", "unknown"),
        }

        return {
            "status": "success",
            "processing_status": processing_status,
            "completed": processing_status.get("state") in {"completed", "map_matched"},
            "saved_id": str(trip.id) if trip else None,
        }

    @with_comprehensive_handling
    async def refresh_geocoding(
        self,
        trip_ids: list[str],
        skip_if_exists: bool = True,
        progress_callback: Callable | None = None,
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
                    # Trip is a Beanie model now
                    start_loc = getattr(trip, "startLocation", None)
                    dest_loc = getattr(trip, "destination", None)

                    has_start = bool(
                        start_loc
                        and isinstance(start_loc, dict)
                        and start_loc.get("formatted_address"),
                    )
                    has_destination = bool(
                        dest_loc
                        and isinstance(dest_loc, dict)
                        and dest_loc.get("formatted_address"),
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
                    trip.model_dump(),
                    options,
                    getattr(trip, "source", "unknown"),
                )
                results["updated"] += 1

            except Exception as e:
                results["failed"] += 1
                results["errors"].append(f"Trip {trip_id}: {e!s}")
                logger.exception(
                    "Error refreshing geocoding for trip %s",
                    trip_id,
                )

        return results
