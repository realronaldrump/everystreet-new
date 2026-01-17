"""
Maintenance tasks for trip data.

This module provides ARQ jobs for maintaining trip data quality:
- cleanup_stale_trips: Completes stale active trips
- validate_trips: Validates trip data and marks invalid records
- remap_unmatched_trips: Attempts to map-match trips that previously failed
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import logging
from pydantic import ValidationError

from db.models import Trip
from live_tracking import cleanup_stale_trips_logic
from tasks.config import check_dependencies
from tasks.ops import run_task_with_history
from trip_service import TripService

logger = logging.getLogger(__name__)


async def _cleanup_stale_trips_logic() -> dict[str, Any]:
    """Async logic for completing stale active trips."""

    cleanup_result = await cleanup_stale_trips_logic()

    stale_completed_count = cleanup_result.get("stale_trips_archived", 0)
    old_removed_count = cleanup_result.get("old_archives_removed", 0)
    logger.info(
        "Cleanup logic completed: Completed %d stale active trips, "
        "removed %d old trips.",
        stale_completed_count,
        old_removed_count,
    )

    return {
        "status": "success",
        "message": (
            f"Completed {stale_completed_count} stale trips, "
            f"removed {old_removed_count} old trips."
        ),
        "details": cleanup_result,
    }


async def cleanup_stale_trips(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    """ARQ job for completing stale active trips."""
    return await run_task_with_history(
        ctx,
        "cleanup_stale_trips",
        _cleanup_stale_trips_logic,
        manual_run=manual_run,
    )


async def _validate_trips_logic() -> dict[str, Any]:
    """
    Async logic for validating trip data and marking invalid records.

    This comprehensive validation task checks:
    1. Required fields (transactionId, startTime, endTime, gps)
    2. GPS data structure and coordinate validity
    3. Stationary trips (brief engine on/off without driving)
    """
    processed_count = 0
    modified_count = 0

    query = {"invalid": {"$ne": True}}

    total_docs_to_process = await Trip.find(query).count()
    logger.info("Found %d trips to validate.", total_docs_to_process)

    if total_docs_to_process == 0:
        return {
            "status": "success",
            "message": "No trips found requiring validation.",
            "processed_count": 0,
            "modified_count": 0,
        }

    # Beanie iteration
    # Iterate using Beanie cursor
    # Note: Trip.find(query) returns a FindMany object which is async iterable

    async for trip in Trip.find(query):
        processed_count += 1

        try:
            # Trip document is already a Pydantic model (Beanie Document)
            # and now contains the validation logic from TripDataModel.
            valid, message = trip.validate_meaningful()
        except ValidationError as e:
            valid = False
            message = str(e)
        except Exception as e:
            valid = False
            message = f"Unexpected error during validation: {e}"

        if not valid:
            # Mark as invalid
            try:
                trip.invalid = True
                trip.validation_message = message or "Invalid data detected"
                trip.validated_at = datetime.now(UTC)

                await trip.save()
                modified_count += 1
            except Exception as save_err:
                logger.exception(
                    "Failed to save invalid trip %s: %s",
                    trip.id,
                    save_err,
                )

        if processed_count % 500 == 0:
            logger.info(
                "Processed %d/%d trips for validation.",
                processed_count,
                total_docs_to_process,
            )
            # Yield to event loop
            await asyncio.sleep(0.01)

    return {
        "status": "success",
        "message": (
            f"Processed {processed_count} trips, marked {modified_count} as invalid"
        ),
        "processed_count": processed_count,
        "modified_count": modified_count,
    }


async def validate_trips(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    """ARQ job for validating trip data."""
    return await run_task_with_history(
        ctx,
        "validate_trips",
        _validate_trips_logic,
        manual_run=manual_run,
    )


async def _remap_unmatched_trips_logic() -> dict[str, Any]:
    """Async logic for attempting to map-match trips that previously failed."""
    remap_count = 0
    failed_count = 0
    limit = 50

    # Check dependencies first
    dependency_check = await check_dependencies("remap_unmatched_trips")
    if not dependency_check["can_run"]:
        reason = dependency_check.get("reason", "Unknown reason")
        logger.info("Deferring remap_unmatched_trips: %s", reason)
        return {
            "status": "deferred",
            "message": reason,
        }

    # Get already matched trip IDs
    logger.info("Checking for unmatched trips (matchedGps is None).")

    query = {"matchedGps": None, "invalid": {"$ne": True}}
    # Use Beanie find with limit
    trips_to_process = await Trip.find(query).limit(limit).to_list()

    logger.info(
        "Found %d trips to attempt remapping (limit %d).",
        len(trips_to_process),
        limit,
    )

    trip_service = TripService()
    # Beanie trips are objects, access attribute directly
    trip_ids = [trip.transactionId for trip in trips_to_process if trip.transactionId]

    result = await trip_service.remap_trips(trip_ids=trip_ids, limit=len(trip_ids))

    remap_count = result["map_matched"]
    failed_count = result["failed"]

    logger.info(
        "Remapping attempt finished. Succeeded: %d, Failed: %d",
        remap_count,
        failed_count,
    )

    return {
        "status": "success",
        "remapped_count": remap_count,
        "failed_count": failed_count,
        "message": (
            f"Attempted remapping for {len(trips_to_process)} trips. "
            f"Succeeded: {remap_count}, Failed: {failed_count}"
        ),
    }


async def remap_unmatched_trips(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    """ARQ job for remapping unmatched trips."""
    return await run_task_with_history(
        ctx,
        "remap_unmatched_trips",
        _remap_unmatched_trips_logic,
        manual_run=manual_run,
    )
