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
from trips.models import TripStatusProjection
from trips.pipeline import TripPipeline
from trips.services.trip_ingest_issue_service import TripIngestIssueService

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


def is_duplicate_trip_error(exc: Exception) -> bool:
    if exc.__class__.__name__ == "DuplicateKeyError":
        return True
    if isinstance(exc, HTTPException) and exc.status_code == status.HTTP_409_CONFLICT:
        detail = str(getattr(exc, "detail", "") or "").lower()
        return "already exists" in detail or "duplicate" in detail
    msg = str(exc).lower()
    return "duplicate key" in msg or "e11000" in msg


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

    @staticmethod
    def _has_full_location_data(existing_trip: dict[str, Any] | None) -> bool:
        if not isinstance(existing_trip, dict):
            return False
        return TripPipeline._has_meaningful_location(
            existing_trip.get("startLocation"),
        ) and TripPipeline._has_meaningful_location(existing_trip.get("destination"))

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
        self._pipeline.sanitize_trip_document_geospatial_fields(existing_trip)
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
            geocode_enabled = bool(
                app_settings.model_dump().get("geocodeTripsOnFetch", True),
            )

            # Deduplicate inputs by transactionId
            unique_trips: list[dict[str, Any]] = []
            seen_incoming: set[str] = set()
            for t in trips_data:
                if not isinstance(t, dict):
                    continue
                raw_tx = str(t.get("transactionId") or "").strip()
                if not raw_tx or raw_tx in seen_incoming:
                    continue
                seen_incoming.add(raw_tx)
                normalized_trip = normalize_rest_trip_payload(t)
                tx = normalized_trip.get("transactionId")
                if not tx:
                    continue
                unique_trips.append(normalized_trip)

            trips_to_handle = []
            existing_by_id: dict[str, Any] = {}
            existing_docs_by_id: dict[str, Trip] = {}
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

                if existing_by_id:
                    existing_docs_full = await Trip.find(
                        In(Trip.transactionId, list(existing_by_id.keys())),
                    ).to_list()
                    for existing_doc in existing_docs_full:
                        tx = str(
                            getattr(existing_doc, "transactionId", "") or "",
                        ).strip()
                        if tx:
                            existing_docs_by_id[tx] = existing_doc

                for trip in unique_trips:
                    transaction_id = trip.get("transactionId")
                    if not transaction_id:
                        continue
                    if not trip.get("endTime"):
                        logger.debug(
                            "Skipping trip %s because 'endTime' is missing",
                            transaction_id,
                        )
                        await TripIngestIssueService.record_issue(
                            issue_type="validation_failed",
                            message="Missing endTime",
                            source="bouncie",
                            transaction_id=str(transaction_id),
                            imei=str(trip.get("imei") or "") or None,
                            details={
                                "transactionId": transaction_id,
                                "imei": trip.get("imei"),
                                "reason": "Missing endTime",
                            },
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
                existing_source = (
                    str(existing_trip.get("source") or "").strip().lower()
                    if existing_trip
                    else ""
                )
                needs_source_reconciliation = bool(
                    existing_trip and existing_source != "bouncie",
                )
                needs_geocode_repair = bool(
                    geocode_enabled
                    and existing_trip
                    and not self._has_full_location_data(existing_trip),
                )
                needs_processing = (
                    not existing_trip
                    or not existing_processed
                    or needs_source_reconciliation
                    or needs_geocode_repair
                    or (do_map_match and not existing_trip.get("matchedGps"))
                )

                if needs_processing:
                    validation = await self._pipeline.validate_raw_trip_with_basic(trip)
                    if not validation.get("success"):
                        reason = (
                            (validation.get("processing_status") or {})
                            .get("errors", {})
                            .get("validation")
                        )
                        await TripIngestIssueService.record_issue(
                            issue_type="validation_failed",
                            message=str(reason),
                            source="bouncie",
                            transaction_id=str(transaction_id),
                            imei=str(trip.get("imei") or "") or None,
                            details={
                                "transactionId": transaction_id,
                                "imei": trip.get("imei"),
                                "reason": reason,
                            },
                        )
                        continue

                    try:
                        processing_status = validation.get("processing_status") or {}
                        validated_trip_data = validation.get("processed_data")
                        if not isinstance(validated_trip_data, dict):
                            validated_trip_data = None
                        saved = await self._pipeline.process_raw_trip(
                            trip,
                            source="bouncie",
                            do_map_match=do_map_match,
                            do_geocode=geocode_enabled,
                            do_coverage=True,
                            prevalidated_data=validated_trip_data,
                            prevalidated_history=processing_status.get("history"),
                            prevalidated_state=processing_status.get("state"),
                        )
                    except Exception as exc:
                        if is_duplicate_trip_error(exc):
                            existing_doc_after_race = await Trip.find_one(
                                Trip.transactionId == transaction_id,
                            )
                            if existing_doc_after_race:
                                existing_source = (
                                    str(
                                        getattr(existing_doc_after_race, "source", "")
                                        or "",
                                    )
                                    .strip()
                                    .lower()
                                )
                                if existing_source == "bouncie":
                                    processed_trip_ids.append(transaction_id)
                                    merged_count += 1
                                    logger.info(
                                        "Trip %s already inserted concurrently; treating as idempotent success.",
                                        transaction_id,
                                    )
                                    continue
                                merged = await self._merge_existing_trip(
                                    existing_doc_after_race,
                                    trip,
                                    source="bouncie",
                                )
                                if merged:
                                    processed_trip_ids.append(transaction_id)
                                    merged_count += 1
                                    logger.info(
                                        "Trip %s merged after duplicate race with existing non-bouncie row.",
                                        transaction_id,
                                    )
                                    continue
                        logger.exception(
                            "Failed to process Bouncie trip %s",
                            transaction_id,
                        )
                        await TripIngestIssueService.record_issue(
                            issue_type="process_error",
                            message=str(exc),
                            source="bouncie",
                            transaction_id=str(transaction_id),
                            imei=str(trip.get("imei") or "") or None,
                            details={
                                "transactionId": transaction_id,
                                "imei": trip.get("imei"),
                                "error": str(exc),
                                "duplicate_race": is_duplicate_trip_error(exc),
                            },
                        )
                    else:
                        if saved and getattr(saved, "id", None):
                            processed_trip_ids.append(transaction_id)
                            processed_count += 1
                        else:
                            await TripIngestIssueService.record_issue(
                                issue_type="process_error",
                                message="Trip processing returned no saved record",
                                source="bouncie",
                                transaction_id=str(transaction_id),
                                imei=str(trip.get("imei") or "") or None,
                                details={
                                    "transactionId": transaction_id,
                                    "imei": trip.get("imei"),
                                },
                            )
                else:
                    if not existing_trip:
                        continue
                    existing_doc = existing_docs_by_id.get(str(transaction_id))
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
            if is_duplicate_trip_error(exc):
                logger.info(
                    "Duplicate race bubbled out of batch processing; returning partial processed ids.",
                )
                return processed_trip_ids
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
