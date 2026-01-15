"""
Maintenance tasks for trip data.

This module provides Celery tasks for maintaining trip data quality:
- cleanup_stale_trips: Completes stale active trips
- validate_trips: Validates trip data and marks invalid records
- remap_unmatched_trips: Attempts to map-match trips that previously failed
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from celery import shared_task
from celery.utils.log import get_task_logger
from pydantic import ValidationError

from core.async_bridge import run_async_from_sync
from db.models import Trip
from live_tracking import cleanup_stale_trips_logic
from tasks.config import check_dependencies
from tasks.core import task_runner
from trip_service import TripService

logger = get_task_logger(__name__)


@task_runner
async def cleanup_stale_trips_async(_self) -> dict[str, Any]:
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


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    time_limit=1800,
    soft_time_limit=1700,
    name="tasks.cleanup_stale_trips",
)
def cleanup_stale_trips(_self, *_args, **_kwargs):
    """Celery task wrapper for completing stale active trips."""
    return run_async_from_sync(cleanup_stale_trips_async(_self))


@task_runner
async def validate_trips_async(_self) -> dict[str, Any]:
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


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.validate_trips",
)
def validate_trips(_self, *_args, **_kwargs):
    """Celery task wrapper for validating trip data."""
    return run_async_from_sync(validate_trips_async(_self))


@task_runner
async def remap_unmatched_trips_async(_self) -> dict[str, Any]:
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

    from config import require_mapbox_token

    mapbox_token = require_mapbox_token()

    trip_service = TripService(mapbox_token)
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


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.remap_unmatched_trips",
    queue="default",
)
def remap_unmatched_trips(_self, *_args, **_kwargs):
    """Celery task wrapper for remapping unmatched trips."""
    return run_async_from_sync(remap_unmatched_trips_async(_self))
