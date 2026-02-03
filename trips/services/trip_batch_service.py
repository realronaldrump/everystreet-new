import asyncio
import logging
import time
from collections.abc import Callable
from functools import wraps
from typing import Any

from beanie.operators import In
from fastapi import HTTPException, status
from pydantic import ValidationError

from admin.services.admin_service import AdminService
from config import require_nominatim_reverse_url, require_valhalla_trace_route_url
from core.bouncie_normalization import normalize_rest_trip_payload
from core.date_utils import get_current_utc_time
from db.models import Trip
from trips.models import TripProcessingProjection, TripStatusProjection
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


class BatchProcessingResult:
    """Result container for batch processing operations."""

    def __init__(self) -> None:
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
        require_valhalla_trace_route_url()
        require_nominatim_reverse_url()
        self._pipeline = TripPipeline()

    @with_comprehensive_handling
    async def get_trip_by_id(self, trip_id: str) -> Trip | None:
        """Retrieve a trip by its ID."""
        return await Trip.find_one(Trip.transactionId == trip_id)

    async def _merge_existing_trip(
        self,
        existing_trip: Trip,
        trip_data: dict[str, Any],
        source: str,
    ) -> bool:
        try:
            validated = Trip(**trip_data)
            incoming = validated.model_dump(exclude_unset=True)
        except ValidationError as exc:
            logger.warning(
                "Skipping merge for trip %s due to validation error: %s",
                trip_data.get("transactionId", "unknown"),
                exc,
            )
            return False

        incoming["source"] = source
        incoming["saved_at"] = get_current_utc_time()
        self._pipeline._merge_trip_fields(
            existing_trip,
            incoming,
            mark_processed=False,
            processing_state=None,
        )
        await existing_trip.save()
        return True

    @with_comprehensive_handling
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
    async def process_batch_trips(
        self,
        query: dict[str, Any],
        options: ProcessingOptions,
        limit: int = 100,
        progress_tracker: dict | None = None,
    ) -> BatchProcessingResult:
        """Process multiple trips in batch with configurable options."""
        result = BatchProcessingResult()

        # Ensure reasonable limit
        limit = min(limit, 500)

        # Find trips matching query
        trips = (
            await Trip.find(query)
            .project(TripProcessingProjection)
            .limit(limit)
            .to_list()
        )
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
                    trip,
                    options,
                    trip.get("source", "unknown"),
                )

                # Update counters based on processing result
                processing_status = trip_result.get("processing_status", {})
                state = processing_status.get("state")

                if state == "validated":
                    result.validated += 1
                elif state == "geocoded":
                    result.geocoded += 1
                elif state in {"map_matched", "completed"}:
                    result.map_matched += 1
                elif state == "failed":
                    result.failed += 1

            except Exception as e:
                result.failed += 1
                result.errors.append(
                    {"trip_id": trip.get("transactionId", "unknown"), "error": str(e)},
                )
                logger.exception(
                    "Error processing trip %s",
                    trip.get("transactionId"),
                )

        return result

    @with_comprehensive_handling
    async def process_bouncie_trips(
        self,
        trips_data: list[dict[str, Any]],
        do_map_match: bool = False,
        progress_tracker: dict | None = None,
    ) -> list[str]:
        """
        Process multiple Bouncie trips.

        Returns a list of transactionIds that were successfully saved
        (not ObjectIds).
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
            app_settings = await AdminService.get_persisted_app_settings()
            geocode_enabled = app_settings.model_dump().get(
                "geocodeTripsOnFetch",
                True,
            )

            # Deduplicate inputs by transactionId
            unique_trips: list[dict[str, Any]] = []
            seen_incoming: set[str] = set()
            for t in trips_data:
                if not isinstance(t, dict):
                    continue
                normalized_trip = normalize_rest_trip_payload(t)
                tx = normalized_trip.get("transactionId")
                if not tx or tx in seen_incoming:
                    continue
                seen_incoming.add(tx)
                unique_trips.append(normalized_trip)

            trips_to_handle = []
            existing_by_id: dict[str, Any] = {}
            if unique_trips:
                incoming_ids = [
                    t.get("transactionId")
                    for t in unique_trips
                    if t.get("transactionId")
                ]

                # Query existing trips to check their status using Beanie
                existing_docs = (
                    await Trip.find(In(Trip.transactionId, incoming_ids))
                    .project(TripStatusProjection)
                    .to_list()
                )

                for d in existing_docs:
                    d_dict = d.model_dump() if hasattr(d, "model_dump") else dict(d)
                    transaction_id = d_dict.get("transactionId")
                    if isinstance(transaction_id, str) and transaction_id:
                        existing_by_id[transaction_id] = d_dict

                for trip in unique_trips:
                    transaction_id = trip.get("transactionId")
                    if not transaction_id:
                        continue
                    if not trip.get("endTime"):
                        logger.debug(
                            "Skipping trip %s because 'endTime' is missing",
                            transaction_id,
                        )
                        continue
                    trips_to_handle.append(trip)

            skipped_count = len(seen_incoming) - len(trips_to_handle)
            logger.info(
                "Processing Bouncie trips: Total incoming=%d, Unique=%d, To Handle=%d, Skipped=%d (duplicates/missing endTime)",
                len(trips_data),
                len(seen_incoming),
                len(trips_to_handle),
                skipped_count,
            )
            if progress_section is not None:
                progress_section["message"] = (
                    f"Starting trip processing "
                    f"(skipped {skipped_count} duplicate/incomplete trips)"
                )

            processed_count = 0
            merged_count = 0
            for index, trip in enumerate(trips_to_handle):
                if progress_section is not None and trips_data:
                    progress_section["progress"] = int(
                        (index / max(1, len(trips_to_handle))) * 100,
                    )
                    progress_section["message"] = "Processing trips..."

                transaction_id = trip.get("transactionId", "unknown")
                existing_trip = existing_by_id.get(transaction_id)
                existing_status = existing_trip.get("status") if existing_trip else None
                existing_processing_state = (
                    existing_trip.get("processing_state") if existing_trip else None
                )
                existing_processed = (
                    existing_status == "processed"
                    or existing_processing_state in {"completed", "map_matched"}
                )
                needs_processing = (
                    not existing_trip
                    or not existing_processed
                    or (do_map_match and not existing_trip.get("matchedGps"))
                )

                if needs_processing:
                    try:
                        options = ProcessingOptions(
                            validate=True,
                            geocode=geocode_enabled,
                            map_match=do_map_match,
                        )

                        result = await self.process_single_trip(
                            trip,
                            options,
                            source="bouncie",
                            do_coverage=True,
                        )
                    except Exception:
                        logger.exception(
                            "Failed to process Bouncie trip %s",
                            transaction_id,
                        )
                    else:
                        if result.get("saved_id"):
                            processed_trip_ids.append(transaction_id)
                            processed_count += 1
                else:
                    if not existing_trip:
                        continue
                    existing_doc = await Trip.find_one(
                        Trip.transactionId == transaction_id,
                    )
                    if not existing_doc:
                        continue
                    merged = await self._merge_existing_trip(
                        existing_doc,
                        trip,
                        source="bouncie",
                    )
                    if merged:
                        processed_trip_ids.append(transaction_id)
                        merged_count += 1
            logger.info(
                "Bouncie trips handled: processed=%d, merged=%d, skipped=%d",
                processed_count,
                merged_count,
                skipped_count,
            )
        except Exception as exc:
            if progress_section is not None:
                progress_section["status"] = "failed"
                progress_section["message"] = f"Failed to process trips: {exc}"
            raise
        else:
            return processed_trip_ids
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
        trip_ids: list[str] | None = None,
        query: dict[str, Any] | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Remap trips using map matching."""
        if not trip_ids and not query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Either trip_ids or query must be provided",
            )

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
                batch_query,
                options,
                limit=len(trip_ids),
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
