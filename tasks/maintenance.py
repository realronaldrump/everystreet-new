"""Maintenance tasks for trip data.

This module provides Celery tasks for maintaining trip data quality:
- cleanup_stale_trips: Archives stale live tracking trips
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
from pymongo import UpdateOne
from pymongo.errors import BulkWriteError, ConnectionFailure

from core.async_bridge import run_async_from_sync
from db import db_manager
from db.models import Trip
from live_tracking import cleanup_stale_trips_logic
from models import TripDataModel
from tasks.config import check_dependencies
from tasks.core import task_runner
from trip_service import TripService

logger = get_task_logger(__name__)


@task_runner
async def cleanup_stale_trips_async(_self) -> dict[str, Any]:
    """Async logic for cleaning up stale live tracking trips."""
    # Ensure we can access the database
    _ = db_manager.client
    logger.debug("Database client accessed for cleanup task.")

    live_collection = db_manager.get_collection("live_trips")

    if live_collection is None:
        logger.critical(
            "DB collection 'live_trips' could not be obtained in cleanup task!",
        )
        raise ConnectionFailure(
            "Could not get required collection for cleanup task.",
        )
    logger.debug(
        "Successfully obtained live_trips collection.",
    )

    cleanup_result = await cleanup_stale_trips_logic(
        live_collection=live_collection,
    )

    stale_archived_count = cleanup_result.get("stale_trips_archived", 0)
    old_removed_count = cleanup_result.get("old_archives_removed", 0)
    logger.info(
        "Cleanup logic completed: Archived %d stale live trips, "
        "removed %d old archives.",
        stale_archived_count,
        old_removed_count,
    )

    return {
        "status": "success",
        "message": (
            f"Cleaned up {stale_archived_count} stale trips, "
            f"removed {old_removed_count} old archives."
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
    """Celery task wrapper for cleaning up stale live trips."""
    return run_async_from_sync(cleanup_stale_trips_async(_self))


@task_runner
async def validate_trips_async(_self) -> dict[str, Any]:
    """Async logic for validating trip data and marking invalid records.

    This comprehensive validation task checks:
    1. Required fields (transactionId, startTime, endTime, gps)
    2. GPS data structure and coordinate validity
    3. Stationary trips (brief engine on/off without driving)
    """
    processed_count = 0
    modified_count = 0
    batch_size = 500

    query = {"invalid": {"$ne": True}}
    # Use Beanie count
    total_docs_to_process = await Trip.find(query).count()
    logger.info("Found %d trips to validate.", total_docs_to_process)

    if total_docs_to_process == 0:
        return {
            "status": "success",
            "message": "No trips found requiring validation.",
            "processed_count": 0,
            "modified_count": 0,
        }

    # Use Beanie find with projection manually if desired, but Beanie returns model instances.
    # To optimize memory, we can use specific projection or just load models if they are not huge.
    # The existing code projected specific fields: transactionId, startTime, endTime, gps, distance, maxSpeed, _id
    # We can use .project() or just iterate. Given batch processing, loading full objects is okay,
    # or we can use keys.
    # But to use TripDataModel validation, we need a dictionary. Beanie objects can be dumped.
    # Let's use projection to raw dicts for performance and compatibility with TripDataModel.

    cursor = (
        Trip.get_motor_collection()
        .find(
            query,
            {
                "transactionId": 1,
                "startTime": 1,
                "endTime": 1,
                "gps": 1,
                "distance": 1,
                "maxSpeed": 1,
                "_id": 1,
            },
        )
        .batch_size(batch_size)
    )

    batch_updates = []
    trips_updated_count = 0

    # We iterate the motor cursor for efficiency in this batch job
    async for trip in cursor:
        processed_count += 1

        # First check: required data validation using Pydantic
        valid = True
        message = None

        try:
            # TripDataModel validation covers required fields, types, and GPS structure
            model = TripDataModel(**trip)

            # Second check: functional/semantic validation (stationary logic)
            valid, message = model.validate_meaningful()

        except ValidationError as e:
            valid = False
            # Simplify error message
            message = str(e)
        except Exception as e:
            valid = False
            message = f"Unexpected error during validation: {e}"

        if not valid:
            # Mark as invalid in both collections (if multiple exist, otherwise just trips)
            batch_updates.append(
                UpdateOne(
                    {"_id": trip["_id"]},
                    {
                        "$set": {
                            "invalid": True,
                            "validation_message": message or "Invalid data detected",
                            "validated_at": datetime.now(UTC),
                        },
                    },
                ),
            )
            modified_count += 1

        if len(batch_updates) >= batch_size:
            if batch_updates:
                try:
                    # Using raw collection for bulk write updates is standard/efficient
                    trips_coll = Trip.get_motor_collection()
                    result = await trips_coll.bulk_write(
                        batch_updates,
                        ordered=False,
                    )
                    logger.info(
                        "Executed validation batch: Matched=%d, Modified=%d",
                        result.matched_count,
                        result.modified_count,
                    )
                except BulkWriteError as bwe:
                    logger.error(
                        "Bulk write error during validation: %s",
                        bwe.details,
                    )
                except Exception as bulk_err:
                    logger.error(
                        "Error executing validation batch: %s",
                        bulk_err,
                    )
            batch_updates = []
            logger.info(
                "Processed %d/%d trips for validation.",
                processed_count,
                total_docs_to_process,
            )
            await asyncio.sleep(0.1)

    if batch_updates:
        try:
            trips_coll = Trip.get_motor_collection()
            result = await trips_coll.bulk_write(batch_updates, ordered=False)
            logger.info(
                "Executed final validation batch: Matched=%d, Modified=%d",
                result.matched_count,
                result.modified_count,
            )
        except BulkWriteError as bwe:
            logger.error(
                "Bulk write error during final validation batch: %s",
                bwe.details,
            )
        except Exception as bulk_err:
            logger.error("Error executing final validation batch: %s", bulk_err)

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

    from config import get_mapbox_token

    mapbox_token = get_mapbox_token()
    if not mapbox_token:
        logger.warning("Mapbox token not configured, cannot perform map matching.")
        raise ValueError(
            "Mapbox token is not configured. Please set it in the profile page."
        )

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
