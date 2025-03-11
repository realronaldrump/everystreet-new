"""
Background tasks implementation using Celery.

This module provides task definitions for all background tasks performed by the
application, replacing the previous APScheduler-based implementation.
"""

import os
import logging
import time
import json
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional, Union
from enum import Enum
import uuid
from functools import wraps

# Try to import psutil for memory monitoring, but make it optional
try:
    import psutil

    HAVE_PSUTIL = True
except ImportError:
    HAVE_PSUTIL = False

from bson import ObjectId
from celery import shared_task, group, chain, chord
from celery.signals import task_prerun, task_postrun, task_failure
from celery.utils.log import get_task_logger
from pymongo import UpdateOne

# Import Celery app
from celery_app import app

# Local module imports
from db import (
    db,
    db_manager,
    find_one_with_retry,
    find_with_retry,
    update_one_with_retry,
    replace_one_with_retry,
    count_documents_with_retry,
    trips_collection,
    matched_trips_collection,
    streets_collection,
    coverage_metadata_collection,
    task_history_collection,
    progress_collection,
)
from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from preprocess_streets import preprocess_streets as async_preprocess_streets
from street_coverage_calculation import update_coverage_for_all_locations
from utils import validate_trip_data
from trip_processor import TripProcessor, TripState
from live_tracking import cleanup_stale_trips

# Set up task-specific logger
logger = get_task_logger(__name__)

# Memory thresholds for task management
MEMORY_WARN_THRESHOLD = 70.0
MEMORY_CRITICAL_THRESHOLD = 85.0

# Task priorities for UI display


class TaskPriority(Enum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3


# Task status enums (for API consistency with previous implementation)


class TaskStatus(Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    PAUSED = "PAUSED"
    PENDING = "PENDING"


# Task metadata for UI display and configuration
TASK_METADATA = {
    "periodic_fetch_trips": {
        "display_name": "Periodic Trip Fetch",
        "default_interval_minutes": int(
            os.environ.get("TRIP_FETCH_INTERVAL_MINUTES", "60")
        ),
        "priority": TaskPriority.HIGH,
        "dependencies": [],
        "description": "Fetches trips from the Bouncie API periodically",
    },
    "preprocess_streets": {
        "display_name": "Preprocess Streets",
        "default_interval_minutes": 1440,
        "priority": TaskPriority.LOW,
        "dependencies": [],
        "description": "Preprocess street data for coverage calculation",
    },
    "update_coverage_for_all_locations": {
        "display_name": "Update Coverage (All Locations)",
        "default_interval_minutes": 60,
        "priority": TaskPriority.MEDIUM,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Updates street coverage calculations for all locations",
    },
    "cleanup_stale_trips": {
        "display_name": "Cleanup Stale Trips",
        "default_interval_minutes": 60,
        "priority": TaskPriority.LOW,
        "dependencies": [],
        "description": "Archives trips that haven't been updated recently",
    },
    "cleanup_invalid_trips": {
        "display_name": "Cleanup Invalid Trips",
        "default_interval_minutes": 1440,
        "priority": TaskPriority.LOW,
        "dependencies": [],
        "description": "Identifies and marks invalid trip records",
    },
    "update_geocoding": {
        "display_name": "Update Geocoding",
        "default_interval_minutes": 720,
        "priority": TaskPriority.LOW,
        "dependencies": [],
        "description": "Updates reverse geocoding for trips missing location data",
    },
    "remap_unmatched_trips": {
        "display_name": "Remap Unmatched Trips",
        "default_interval_minutes": 360,
        "priority": TaskPriority.MEDIUM,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Attempts to map-match trips that previously failed",
    },
    "validate_trip_data": {
        "display_name": "Validate Trip Data",
        "default_interval_minutes": 720,
        "priority": TaskPriority.LOW,
        "dependencies": [],
        "description": "Validates and corrects trip data inconsistencies",
    },
}

# Singleton event loop for async operations
_EVENT_LOOP = None


def get_event_loop():
    """Get or create the global event loop."""
    global _EVENT_LOOP
    if _EVENT_LOOP is None or _EVENT_LOOP.is_closed():
        _EVENT_LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_EVENT_LOOP)
    return _EVENT_LOOP


def run_async(coro):
    """Run an async coroutine from a sync context safely."""
    loop = get_event_loop()
    return loop.run_until_complete(coro)


# Task hooks for tracking task execution in MongoDB


@task_prerun.connect
def task_started(task_id=None, task=None, *args, **kwargs):
    """Record when a task starts running."""
    task_name = task.name.split(".")[-1] if task and task.name else "unknown"

    try:
        # Run synchronously to avoid issues with task execution
        update_data = {
            "task_id": task_name,
            "status": TaskStatus.RUNNING.value,
            "timestamp": datetime.now(timezone.utc),
            "start_time": datetime.now(timezone.utc),
        }

        # Store task start information in MongoDB (async)
        run_async(
            update_one_with_retry(
                task_history_collection,
                {"_id": str(task_id)},
                {"$set": update_data},
                upsert=True,
            )
        )

        # Update task config status (async)
        run_async(
            update_task_config(
                task_name,
                {
                    "status": TaskStatus.RUNNING.value,
                    "start_time": datetime.now(timezone.utc),
                    "last_updated": datetime.now(timezone.utc),
                },
            )
        )

        logger.info(f"Task {task_name} ({task_id}) started")
    except Exception as e:
        logger.error(f"Error recording task start: {str(e)}")


@task_postrun.connect
def task_finished(task_id=None, task=None, retval=None, state=None, *args, **kwargs):
    """Record when a task finishes running."""
    if not task:
        return

    task_name = task.name.split(".")[-1] if task and task.name else "unknown"

    try:
        # Get task info from MongoDB (need to run synchronously)
        task_info = run_async(
            find_one_with_retry(task_history_collection, {"_id": str(task_id)})
        )

        start_time = task_info.get("start_time") if task_info else None
        runtime = None
        if start_time:
            end_time = datetime.now(timezone.utc)
            runtime = (end_time - start_time).total_seconds() * 1000  # Convert to ms

        # Update task history
        status = (
            TaskStatus.COMPLETED.value
            if state == "SUCCESS"
            else TaskStatus.FAILED.value
        )

        run_async(
            update_one_with_retry(
                task_history_collection,
                {"_id": str(task_id)},
                {
                    "$set": {
                        "status": status,
                        "end_time": datetime.now(timezone.utc),
                        "runtime": runtime,
                        "result": state == "SUCCESS",
                    }
                },
                upsert=True,
            )
        )

        # Calculate next run time based on schedule
        next_run = None
        # Find the task entry in the beat schedule
        for schedule_name, schedule_entry in app.conf.beat_schedule.items():
            if (
                schedule_name.startswith(task_name)
                or schedule_entry.get("task") == f"tasks.{task_name}"
            ):
                schedule = schedule_entry.get("schedule")
                if hasattr(schedule, "seconds"):  # timedelta object
                    next_run = datetime.now(timezone.utc) + schedule
                    break

        # Update task config
        run_async(
            update_task_config(
                task_name,
                {
                    "status": status,
                    "last_run": datetime.now(timezone.utc),
                    "next_run": next_run,
                    "end_time": datetime.now(timezone.utc),
                    "last_updated": datetime.now(timezone.utc),
                },
            )
        )

        logger.info(f"Task {task_name} ({task_id}) finished with status {status}")

    except Exception as e:
        logger.error(f"Error recording task completion: {str(e)}")


@task_failure.connect
def task_failed(task_id=None, task=None, exception=None, *args, **kwargs):
    """Record when a task fails."""
    if not task:
        return

    task_name = task.name.split(".")[-1] if task.name else "unknown"

    try:
        error_msg = str(exception) if exception else "Unknown error"

        # Update task history with error
        run_async(
            update_one_with_retry(
                task_history_collection,
                {"_id": str(task_id)},
                {
                    "$set": {
                        "status": TaskStatus.FAILED.value,
                        "error": error_msg,
                        "end_time": datetime.now(timezone.utc),
                    }
                },
                upsert=True,
            )
        )

        # Update task config
        run_async(
            update_task_config(
                task_name,
                {
                    "status": TaskStatus.FAILED.value,
                    "last_error": error_msg,
                    "end_time": datetime.now(timezone.utc),
                    "last_updated": datetime.now(timezone.utc),
                },
            )
        )

        logger.error(f"Task {task_name} ({task_id}) failed: {error_msg}")

    except Exception as e:
        logger.error(f"Error recording task failure: {str(e)}")


# Task configuration helpers


async def update_task_config(task_id: str, updates: Dict[str, Any]) -> None:
    """Update the configuration for a specific task."""
    update_dict = {f"tasks.{task_id}.{k}": v for k, v in updates.items()}
    try:
        await update_one_with_retry(
            db["task_config"],
            {"_id": "global_background_task_config"},
            {"$set": update_dict},
            upsert=True,
        )
    except Exception as e:
        logger.error(f"Error updating task config for {task_id}: {str(e)}")


async def get_task_config() -> Dict[str, Any]:
    """Get the current task configuration."""
    try:
        cfg = await find_one_with_retry(
            db["task_config"], {"_id": "global_background_task_config"}
        )

        if not cfg:
            # Create default config if not exists
            cfg = {
                "_id": "global_background_task_config",
                "disabled": False,
                "tasks": {
                    t_id: {
                        "enabled": True,
                        "interval_minutes": t_def["default_interval_minutes"],
                        "status": TaskStatus.IDLE.value,
                    }
                    for t_id, t_def in TASK_METADATA.items()
                },
            }
            await update_one_with_retry(
                db["task_config"],
                {"_id": "global_background_task_config"},
                {"$set": cfg},
                upsert=True,
            )

        return cfg
    except Exception as e:
        logger.error(f"Error getting task config: {str(e)}")
        # Return default config if error occurs
        return {
            "_id": "global_background_task_config",
            "disabled": False,
            "tasks": {
                t_id: {
                    "enabled": True,
                    "interval_minutes": t_def["default_interval_minutes"],
                    "status": TaskStatus.IDLE.value,
                }
                for t_id, t_def in TASK_METADATA.items()
            },
        }


async def check_dependencies(task_id: str) -> bool:
    """Check if all dependencies for a task are satisfied."""
    try:
        if task_id not in TASK_METADATA:
            return True

        dependencies = TASK_METADATA[task_id]["dependencies"]
        if not dependencies:
            return True

        # Get current task statuses
        config = await get_task_config()
        tasks_config = config.get("tasks", {})

        for dependency_id in dependencies:
            if dependency_id not in tasks_config:
                logger.warning(
                    f"Dependency {dependency_id} for task {task_id} not found in config"
                )
                return False

            dep_status = tasks_config[dependency_id].get("status")
            if dep_status == TaskStatus.RUNNING.value:
                logger.info(
                    f"Task {task_id} waiting for dependency {dependency_id} to complete"
                )
                return False

            # Check if the dependency has ever completed successfully
            dep_history = await find_with_retry(
                task_history_collection,
                {"task_id": dependency_id, "status": TaskStatus.COMPLETED.value},
                sort=[("timestamp", -1)],
                limit=1,
            )

            if not dep_history:
                logger.info(
                    f"Dependency {dependency_id} for task {task_id} has never completed successfully"
                )
                return False

        return True
    except Exception as e:
        logger.error(f"Error checking dependencies for {task_id}: {str(e)}")
        return False


async def check_memory_usage() -> bool:
    """
    Check system memory usage and return True if memory usage is high.
    """
    if not HAVE_PSUTIL:
        return False

    try:
        # Check memory usage
        process = psutil.Process()
        memory_info = process.memory_info()
        memory_percent = process.memory_percent()

        logger.info(
            f"Memory usage: {memory_info.rss / (1024 * 1024):.2f} MB "
            f"({memory_percent:.2f}% of system memory)"
        )

        if memory_percent > MEMORY_CRITICAL_THRESHOLD:
            # Critical memory usage
            logger.warning(
                f"Critical memory usage ({memory_percent:.2f}%) - "
                "waiting for memory to be freed"
            )
            # Force garbage collection
            import gc

            gc.collect()
            # Let MongoDB connections be cleaned up
            await db_manager.handle_memory_error()
            return True

        elif memory_percent > MEMORY_WARN_THRESHOLD:
            # High memory usage
            logger.warning(
                f"High memory usage ({memory_percent:.2f}%) - "
                "proceeding with caution"
            )
            return True

        return False
    except Exception as e:
        logger.error(f"Error checking memory usage: {str(e)}")
        return False


# Decorator for better async task handling
def async_task_wrapper(func):
    """Decorator to handle async tasks more robustly."""

    @wraps(func)
    def wrapped_task(*args, **kwargs):
        try:
            # For async functions, use run_async to execute them
            if asyncio.iscoroutinefunction(func):
                return run_async(func(*args, **kwargs))
            else:
                return func(*args, **kwargs)
        except Exception as e:
            logger.exception(f"Error in task {func.__name__}: {str(e)}")
            raise

    return wrapped_task


# Core Task Implementations


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    time_limit=3600,
    soft_time_limit=3300,
    name="tasks.periodic_fetch_trips",
    queue="high_priority",
)
def periodic_fetch_trips(self) -> Dict[str, Any]:
    """
    Fetch trips from the Bouncie API periodically.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Check memory usage first
        high_memory = await check_memory_usage()
        if high_memory:
            logger.warning(
                "Memory usage is high before periodic fetch - proceeding with caution"
            )

        # Last successful fetch time is saved in task config
        task_config = await db.task_config.find_one({"task_id": "periodic_fetch_trips"})

        now_utc = datetime.now(timezone.utc)

        if task_config and "last_success_time" in task_config:
            start_date = task_config["last_success_time"]
            # Don't go back more than 24 hours to avoid excessive data
            min_start_date = now_utc - timedelta(hours=24)
            start_date = max(start_date, min_start_date)
        else:
            # Default to 3 hours ago if no previous state
            start_date = now_utc - timedelta(hours=3)

        logger.info(f"Periodic fetch: from {start_date} to {now_utc}")

        try:
            # Fetch trips in the date range
            await fetch_bouncie_trips_in_range(start_date, now_utc, do_map_match=True)

            # Update the last success time
            await db.task_config.update_one(
                {"task_id": "periodic_fetch_trips"},
                {"$set": {"last_success_time": now_utc}},
                upsert=True,
            )

            return {"status": "success", "message": "Trips fetched successfully"}
        except Exception as e:
            error_msg = f"Error in periodic fetch: {str(e)}"
            logger.error(error_msg)
            # If we have memory issues, try to recover
            if "Cannot allocate memory" in str(e):
                await db_manager.handle_memory_error()
            raise self.retry(exc=e, countdown=60)

    try:
        return _execute()
    except Exception as e:
        logger.exception(f"Error executing periodic_fetch_trips: {str(e)}")
        raise


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.preprocess_streets",
    queue="low_priority",
)
def preprocess_streets(self) -> Dict[str, Any]:
    """
    Preprocess street data for coverage calculation.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Check dependencies
        if not await check_dependencies("preprocess_streets"):
            return {"status": "deferred", "message": "Dependencies not satisfied"}

        processing_areas = (
            await db["coverage_metadata"]
            .find({"status": "processing"})
            .to_list(length=None)
        )

        processed_count = 0
        error_count = 0

        for area in processing_areas:
            try:
                await async_preprocess_streets(area["location"])
                processed_count += 1
            except Exception as e:
                error_count += 1
                logger.error(
                    f"Error preprocessing streets for {
                        area['location'].get('display_name')}: {
                        str(e)}"
                )
                await db["coverage_metadata"].update_one(
                    {"_id": area["_id"]},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": str(e),
                            "last_updated": datetime.now(timezone.utc),
                        }
                    },
                )

        return {
            "status": "success",
            "processed_count": processed_count,
            "error_count": error_count,
            "message": f"Processed {processed_count} areas, {error_count} errors",
        }

    try:
        return _execute()
    except Exception as e:
        logger.exception(f"Error executing preprocess_streets: {str(e)}")
        raise


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.update_coverage_for_all_locations",
    queue="default",
)
def update_coverage_for_all_locations_task(self) -> Dict[str, Any]:
    """
    Update street coverage calculations for all locations.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Check dependencies
        if not await check_dependencies("update_coverage_for_all_locations"):
            return {"status": "deferred", "message": "Dependencies not satisfied"}

        # Check memory
        if await check_memory_usage():
            logger.warning("Memory usage is high, deferring coverage update")
            return {
                "status": "deferred",
                "message": "High memory usage, deferring task",
            }

        # Call the original function
        try:
            results = await update_coverage_for_all_locations()
            return {
                "status": "success",
                "message": "Coverage update completed",
                "results": results,
            }
        except Exception as e:
            error_msg = f"Error updating coverage: {str(e)}"
            logger.error(error_msg)
            raise self.retry(exc=e, countdown=300)

    try:
        return _execute()
    except Exception as e:
        logger.exception(
            f"Error executing update_coverage_for_all_locations: {
                str(e)}"
        )
        raise


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    time_limit=1800,
    soft_time_limit=1700,
    name="tasks.cleanup_stale_trips",
    queue="low_priority",
)
def cleanup_stale_trips_task(self) -> Dict[str, Any]:
    """
    Archive trips that haven't been updated recently.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Check memory
        high_memory = await check_memory_usage()

        # Call the actual cleanup function
        cleanup_count = await cleanup_stale_trips()

        logger.info(f"Cleaned up {cleanup_count} stale trips")
        return {
            "status": "success",
            "message": f"Cleaned up {cleanup_count} stale trips",
        }

    try:
        return _execute()
    except Exception as e:
        logger.exception(f"Error executing cleanup_stale_trips: {str(e)}")
        raise


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.cleanup_invalid_trips",
    queue="low_priority",
)
def cleanup_invalid_trips(self) -> Dict[str, Any]:
    """
    Identify and mark invalid trip records.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        update_ops = []

        async for trip in db["trips"].find(
            {}, {"startTime": 1, "endTime": 1, "gps": 1}
        ):
            valid, message = validate_trip_data(trip)
            if not valid:
                update_ops.append(
                    UpdateOne(
                        {"_id": trip["_id"]},
                        {
                            "$set": {
                                "invalid": True,
                                "validation_message": message,
                                "validated_at": datetime.now(timezone.utc),
                            }
                        },
                    )
                )

        if update_ops:
            result = await db["trips"].bulk_write(update_ops)
            logger.info(f"Marked {result.modified_count} invalid trips")
            return {
                "status": "success",
                "message": f"Marked {result.modified_count} invalid trips",
            }
        else:
            return {"status": "success", "message": "No invalid trips found"}

    try:
        return _execute()
    except Exception as e:
        logger.exception(f"Error executing cleanup_invalid_trips: {str(e)}")
        raise


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.update_geocoding",
    queue="default",
)
def update_geocoding(self) -> Dict[str, Any]:
    """
    Update reverse geocoding for trips missing location data.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Find trips that need geocoding
        query = {
            "$or": [
                {"startLocation": {"$exists": False}},
                {"destination": {"$exists": False}},
                {"startLocation": ""},
                {"destination": ""},
            ]
        }
        limit = 100

        trips_to_process = await find_with_retry(trips_collection, query, limit=limit)
        geocoded_count = 0
        failed_count = 0

        for trip in trips_to_process:
            try:
                # Use the unified processor
                processor = TripProcessor(
                    mapbox_token=os.getenv("MAPBOX_ACCESS_TOKEN", ""), source="api"
                )
                processor.set_trip_data(trip)

                # Just validate and geocode, don't map match
                await processor.validate()
                if processor.state == TripState.VALIDATED:
                    await processor.process_basic()
                    if processor.state == TripState.PROCESSED:
                        await processor.geocode()
                        if processor.state == TripState.GEOCODED:
                            result = await processor.save()
                            if result:
                                geocoded_count += 1
                                continue

                failed_count += 1
            except Exception as e:
                logger.error(
                    f"Error geocoding trip {
                        trip.get('transactionId')}: {
                        str(e)}"
                )
                failed_count += 1

            # Sleep briefly to avoid rate limiting
            await asyncio.sleep(0.2)

        logger.info(f"Geocoded {geocoded_count} trips ({failed_count} failed)")
        return {
            "status": "success",
            "geocoded_count": geocoded_count,
            "failed_count": failed_count,
            "message": f"Geocoded {geocoded_count} trips ({failed_count} failed)",
        }

    try:
        return _execute()
    except Exception as e:
        logger.exception(f"Error executing update_geocoding: {str(e)}")
        raise


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.remap_unmatched_trips",
    queue="default",
)
def remap_unmatched_trips(self) -> Dict[str, Any]:
    """
    Attempt to map-match trips that previously failed.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Check dependencies
        if not await check_dependencies("remap_unmatched_trips"):
            return {"status": "deferred", "message": "Dependencies not satisfied"}

        # Find trips that need map matching
        query = {"$or": [{"matchedGps": {"$exists": False}}, {"matchedGps": None}]}
        limit = 50  # Process in smaller batches due to API constraints

        trips_to_process = await find_with_retry(trips_collection, query, limit=limit)
        remap_count = 0
        failed_count = 0

        for trip in trips_to_process:
            try:
                # Use the unified processor
                processor = TripProcessor(
                    mapbox_token=os.getenv("MAPBOX_ACCESS_TOKEN", ""), source="api"
                )
                processor.set_trip_data(trip)

                # Process with map matching
                await processor.process(do_map_match=True)
                result = await processor.save(map_match_result=True)

                if result:
                    remap_count += 1
                else:
                    failed_count += 1
                    status = processor.get_processing_status()
                    logger.warning(
                        f"Failed to remap trip {
                            trip.get('transactionId')}: {status}"
                    )
            except Exception as e:
                logger.warning(
                    f"Failed to remap trip {
                        trip.get('transactionId')}: {
                        str(e)}"
                )
                failed_count += 1

            # Sleep briefly to avoid rate limiting
            await asyncio.sleep(0.5)

        logger.info(f"Remapped {remap_count} trips ({failed_count} failed)")
        return {
            "status": "success",
            "remapped_count": remap_count,
            "failed_count": failed_count,
            "message": f"Remapped {remap_count} trips ({failed_count} failed)",
        }

    try:
        return _execute()
    except Exception as e:
        logger.exception(f"Error executing remap_unmatched_trips: {str(e)}")
        raise


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.validate_trip_data",
    queue="low_priority",
)
def validate_trip_data_task(self) -> Dict[str, Any]:
    """
    Validate trip data consistency.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Fetch trips to validate
        query = {"validated_at": {"$exists": False}}
        limit = 100  # Process in batches

        trips_to_process = await find_with_retry(trips_collection, query, limit=limit)
        processed_count = 0
        failed_count = 0

        for trip in trips_to_process:
            try:
                # Use the unified processor
                processor = TripProcessor(
                    mapbox_token=os.getenv("MAPBOX_ACCESS_TOKEN", ""), source="api"
                )
                processor.set_trip_data(trip)

                # Just validate, don't process fully
                await processor.validate()

                # Update trip with validation status
                status = processor.get_processing_status()
                update_data = {
                    "validated_at": datetime.now(timezone.utc),
                    "validation_status": status["state"],
                }

                if status["state"] == TripState.FAILED.value:
                    update_data["invalid"] = True
                    update_data["validation_message"] = status.get("errors", {}).get(
                        TripState.NEW.value, "Validation failed"
                    )
                else:
                    update_data["invalid"] = False

                await update_one_with_retry(
                    trips_collection, {"_id": trip["_id"]}, {"$set": update_data}
                )

                processed_count += 1
            except Exception as e:
                logger.error(
                    f"Error validating trip {
                        trip.get('_id')}: {
                        str(e)}"
                )
                failed_count += 1

        logger.info(f"Validated {processed_count} trips ({failed_count} failed)")
        return {
            "status": "success",
            "validated_count": processed_count,
            "failed_count": failed_count,
            "message": f"Validated {processed_count} trips ({failed_count} failed)",
        }

    try:
        return _execute()
    except Exception as e:
        logger.exception(f"Error executing validate_trip_data: {str(e)}")
        raise


# Task execution helper
@shared_task(bind=True, name="tasks.execute_task")
def execute_task(self, task_name: str, is_manual: bool = False) -> Dict[str, Any]:
    """
    Execute a named task with dependency validation.

    Args:
        task_name: Name of the task to execute
        is_manual: Whether this is a manual execution

    Returns:
        Dict with status information
    """
    task_mapping = {
        "periodic_fetch_trips": periodic_fetch_trips,
        "preprocess_streets": preprocess_streets,
        "update_coverage_for_all_locations": update_coverage_for_all_locations_task,
        "cleanup_stale_trips": cleanup_stale_trips_task,
        "cleanup_invalid_trips": cleanup_invalid_trips,
        "update_geocoding": update_geocoding,
        "remap_unmatched_trips": remap_unmatched_trips,
        "validate_trip_data": validate_trip_data_task,
    }

    if task_name not in task_mapping:
        logger.error(f"Unknown task: {task_name}")
        return {"status": "error", "message": f"Unknown task: {task_name}"}

    try:
        # Apply task_id suffix for manual runs to track separately
        if is_manual:
            task_id = f"{task_name}_manual_{uuid.uuid4()}"
        else:
            task_id = f"{task_name}_{uuid.uuid4()}"

        # Launch the task with appropriate queue
        task_func = task_mapping[task_name]
        priority = TASK_METADATA.get(task_name, {}).get("priority", TaskPriority.MEDIUM)

        queue = "default"
        if priority == TaskPriority.HIGH:
            queue = "high_priority"
        elif priority == TaskPriority.LOW:
            queue = "low_priority"

        result = task_func.apply_async(task_id=task_id, queue=queue)

        return {
            "status": "success",
            "message": f"Task {task_name} scheduled for execution",
            "task_id": result.id,
        }
    except Exception as e:
        logger.error(f"Error executing task {task_name}: {str(e)}")
        return {
            "status": "error",
            "message": f"Error executing task: {
                str(e)}",
        }


# API functions for app.py to interact with Celery


async def get_all_task_metadata():
    """Return all task metadata for the UI."""
    return TASK_METADATA


async def manual_run_task(task_id: str, is_manual: bool = True) -> Dict[str, Any]:
    """
    Run a task manually.

    Args:
        task_id: ID of the task to run
        is_manual: Whether this is a manual execution

    Returns:
        Dict with status information
    """
    if task_id == "ALL":
        # Get enabled tasks
        config = await get_task_config()
        enabled_tasks = []
        for task_name, task_config in config.get("tasks", {}).items():
            if task_config.get("enabled", True):
                enabled_tasks.append(task_name)

        # Execute all enabled tasks
        results = []
        for task_name in enabled_tasks:
            # Use execute_task.delay to run asynchronously
            result = execute_task.delay(task_name, True)
            results.append({"task": task_name, "success": True, "task_id": result.id})

        return {
            "status": "success",
            "message": f"Triggered {len(results)} tasks",
            "results": results,
        }
    else:
        # Execute single task
        result = execute_task.delay(task_id, is_manual)
        return {
            "status": "success",
            "message": f"Task {task_id} scheduled for execution",
            "task_id": result.id,
        }


async def update_task_schedule(task_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Update the scheduling configuration for tasks.

    Args:
        task_config: New configuration data

    Returns:
        Dict with status information
    """
    try:
        global_disabled = task_config.get("globalDisable", False)
        tasks_config = task_config.get("tasks", {})

        # Get current config
        current_config = await get_task_config()
        current_config["disabled"] = global_disabled

        # Update task configurations
        for task_id, task_settings in tasks_config.items():
            if task_id in TASK_METADATA:
                if task_id not in current_config["tasks"]:
                    current_config["tasks"][task_id] = {}

                if "enabled" in task_settings:
                    current_config["tasks"][task_id]["enabled"] = task_settings[
                        "enabled"
                    ]

                if "interval_minutes" in task_settings:
                    current_config["tasks"][task_id]["interval_minutes"] = (
                        task_settings["interval_minutes"]
                    )

        # Save updated config
        await update_one_with_retry(
            db["task_config"],
            {"_id": "global_background_task_config"},
            {"$set": current_config},
            upsert=True,
        )

        # Schedule update happens when Celery Beat reloads config
        # (we're not dynamically changing Beat schedule in this implementation)

        return {
            "status": "success",
            "message": "Task configuration updated successfully",
        }
    except Exception as e:
        logger.error(f"Error updating task schedule: {str(e)}")
        return {"status": "error", "message": f"Error updating task schedule: {str(e)}"}
