"""
Background tasks implementation using Celery.

This module provides task definitions for all background tasks performed by the application.
It handles proper integration between Celery's synchronous tasks and FastAPI's asynchronous code patterns,
using the centralized db_manager. Tasks are now triggered dynamically by the run_task_scheduler task.
"""

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, Optional, TypeVar

from celery import shared_task
from celery.utils.log import get_task_logger
from pymongo import UpdateOne

from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from celery_app import app as celery_app

# --- Local Imports ---
from db import (
    SerializationHelper,
    coverage_metadata_collection,
    find_one_with_retry,
    find_with_retry,
    matched_trips_collection,
    progress_collection,
    task_config_collection,
    task_history_collection,
    trips_collection,
    update_one_with_retry,
)
from live_tracking import cleanup_stale_trips as cleanup_stale_trips_logic
from street_coverage_calculation import compute_incremental_coverage
from trip_processor import TripProcessor, TripState
from utils import validate_trip_data as validate_trip_data_logic

logger = get_task_logger(__name__)
T = TypeVar("T")

# ------------------------------------------------------------------------------
# Enums and Task Metadata
# ------------------------------------------------------------------------------


class TaskPriority(Enum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3

    @classmethod
    def from_string(cls, priority_str: str) -> "TaskPriority":
        priority_map = {"LOW": cls.LOW, "MEDIUM": cls.MEDIUM, "HIGH": cls.HIGH}
        return priority_map.get(priority_str, cls.MEDIUM)


class TaskStatus(Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    PAUSED = "PAUSED"
    PENDING = "PENDING"


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
    "update_coverage_for_new_trips": {
        "display_name": "Incremental Progress Updates",
        "default_interval_minutes": 180,
        "priority": TaskPriority.MEDIUM,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Updates coverage calculations incrementally for new trips",
    },
}

# ------------------------------------------------------------------------------
# Task Status Manager
# ------------------------------------------------------------------------------


class TaskStatusManager:
    """Centralized task status management using db_manager."""

    _instance = None

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = TaskStatusManager()
        return cls._instance

    async def update_status(
        self, task_id: str, status: str, error: Optional[str] = None
    ) -> bool:
        try:
            now = datetime.now(timezone.utc)
            update_data = {
                f"tasks.{task_id}.status": status,
                f"tasks.{task_id}.last_updated": now,
            }
            if status == TaskStatus.RUNNING.value:
                update_data[f"tasks.{task_id}.start_time"] = now
                update_data[f"tasks.{task_id}.end_time"] = None
                update_data[f"tasks.{task_id}.last_error"] = None
            elif status == TaskStatus.COMPLETED.value:
                update_data[f"tasks.{task_id}.last_run"] = now
                update_data[f"tasks.{task_id}.end_time"] = now
                update_data[f"tasks.{task_id}.last_error"] = None
            elif status == TaskStatus.FAILED.value:
                update_data[f"tasks.{task_id}.last_error"] = error
                update_data[f"tasks.{task_id}.end_time"] = now

            result = await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": update_data},
                upsert=True,
            )
            return result.modified_count > 0 or result.upserted_id is not None

        except Exception as e:
            logger.exception(f"Error updating task status for {task_id}: {e}")
            return False


# ------------------------------------------------------------------------------
# Helper Functions (async)
# ------------------------------------------------------------------------------


async def get_task_config() -> Dict[str, Any]:
    try:
        cfg = await find_one_with_retry(
            task_config_collection, {"_id": "global_background_task_config"}
        )
        if not cfg:
            logger.info("No task config found, creating default.")
            cfg = {
                "_id": "global_background_task_config",
                "disabled": False,
                "tasks": {
                    t_id: {
                        "enabled": True,
                        "interval_minutes": t_def["default_interval_minutes"],
                        "status": TaskStatus.IDLE.value,
                        "last_run": None,
                        "next_run": None,
                        "last_error": None,
                        "start_time": None,
                        "end_time": None,
                        "last_updated": None,
                    }
                    for t_id, t_def in TASK_METADATA.items()
                },
            }
            await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": cfg},
                upsert=True,
            )
        else:
            updated = False
            if "tasks" not in cfg:
                cfg["tasks"] = {}
            for t_id, t_def in TASK_METADATA.items():
                if t_id not in cfg["tasks"]:
                    cfg["tasks"][t_id] = {
                        "enabled": True,
                        "interval_minutes": t_def["default_interval_minutes"],
                        "status": TaskStatus.IDLE.value,
                        "last_run": None,
                        "next_run": None,
                        "last_error": None,
                        "start_time": None,
                        "end_time": None,
                        "last_updated": None,
                    }
                    updated = True
            if updated:
                await update_one_with_retry(
                    task_config_collection,
                    {"_id": "global_background_task_config"},
                    {"$set": {"tasks": cfg["tasks"]}},
                )
        return cfg
    except Exception as e:
        logger.exception(f"Error getting task config: {str(e)}")
        return {
            "_id": "global_background_task_config",
            "disabled": False,
            "tasks": {},
        }


async def check_dependencies(task_id: str) -> Dict[str, Any]:
    try:
        if task_id not in TASK_METADATA:
            return {"can_run": False, "reason": f"Unknown task: {task_id}"}
        dependencies = TASK_METADATA[task_id].get("dependencies", [])
        if not dependencies:
            return {"can_run": True}
        config = await get_task_config()
        tasks_config = config.get("tasks", {})
        for dep_id in dependencies:
            if dep_id not in tasks_config:
                logger.warning(
                    f"Task {task_id} dependency {dep_id} not configured."
                )
                continue
            dep_status = tasks_config[dep_id].get("status")
            if dep_status == TaskStatus.RUNNING.value:
                return {
                    "can_run": False,
                    "reason": f"Dependency {dep_id} is running",
                }
            if dep_status == TaskStatus.FAILED.value:
                last_updated = tasks_config[dep_id].get("last_updated")
                if last_updated:
                    if isinstance(last_updated, str):
                        try:
                            last_updated = datetime.fromisoformat(
                                last_updated.replace("Z", "+00:00")
                            )
                        except ValueError:
                            last_updated = None
                    if last_updated and last_updated.tzinfo is None:
                        last_updated = last_updated.replace(
                            tzinfo=timezone.utc
                        )
                    if last_updated and (
                        datetime.now(timezone.utc) - last_updated
                        < timedelta(hours=1)
                    ):
                        return {
                            "can_run": False,
                            "reason": f"Dependency {dep_id} failed recently",
                        }
        return {"can_run": True}
    except Exception as e:
        logger.exception(f"Error checking dependencies for {task_id}: {e}")
        return {
            "can_run": False,
            "reason": f"Error checking dependencies: {str(e)}",
        }


async def update_task_history_entry(
    celery_task_id: str,
    task_name: str,
    status: str,
    manual_run: bool = False,
    result: Any = None,
    error: Optional[str] = None,
    start_time: Optional[datetime] = None,
    end_time: Optional[datetime] = None,
    runtime_ms: Optional[float] = None,
):
    try:
        now = datetime.now(timezone.utc)
        update_fields = {
            "task_id": task_name,
            "status": status,
            "timestamp": now,
            "manual_run": manual_run,
        }
        if start_time:
            update_fields["start_time"] = start_time
        if end_time:
            update_fields["end_time"] = end_time
        if runtime_ms is not None:
            update_fields["runtime"] = runtime_ms
        if result is not None:
            try:
                serialized_result = SerializationHelper.serialize_document(
                    {"result": result}
                )["result"]
                update_fields["result"] = serialized_result
            except Exception as ser_err:
                logger.warning(
                    f"Could not serialize result for {task_name} history: {ser_err}"
                )
                update_fields["result"] = (
                    f"<Unserializable: {type(result).__name__}>"
                )
        if error is not None:
            update_fields["error"] = error
        await update_one_with_retry(
            task_history_collection,
            {"_id": celery_task_id},
            {"$set": update_fields},
            upsert=True,
        )
    except Exception as e:
        logger.exception(
            f"Error updating task history for {celery_task_id}: {e}"
        )


# ------------------------------------------------------------------------------
# Task Implementations
# ------------------------------------------------------------------------------

# 1. PERIODIC FETCH TRIPS


async def periodic_fetch_trips_async(self) -> Dict[str, Any]:
    task_name = "periodic_fetch_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    try:
        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")

        # Fetch the task config to determine the start time for fetching trips.
        task_config_doc = await find_one_with_retry(
            task_config_collection, {"_id": "global_background_task_config"}
        )
        last_success_time = None
        if (
            task_config_doc
            and "tasks" in task_config_doc
            and task_name in task_config_doc["tasks"]
        ):
            last_success_time = task_config_doc["tasks"][task_name].get(
                "last_success_time"
            )
        now_utc = datetime.now(timezone.utc)
        start_date_fetch = None
        if last_success_time:
            start_date_fetch = last_success_time
            if isinstance(start_date_fetch, str):
                start_date_fetch = datetime.fromisoformat(
                    start_date_fetch.replace("Z", "+00:00")
                )
            if start_date_fetch.tzinfo is None:
                start_date_fetch = start_date_fetch.replace(
                    tzinfo=timezone.utc
                )
        else:
            last_bouncie_trip = await find_one_with_retry(
                trips_collection, {"source": "bouncie"}, sort=[("endTime", -1)]
            )
            if last_bouncie_trip and "endTime" in last_bouncie_trip:
                start_date_fetch = last_bouncie_trip["endTime"]
                if start_date_fetch.tzinfo is None:
                    start_date_fetch = start_date_fetch.replace(
                        tzinfo=timezone.utc
                    )
        if not start_date_fetch:
            start_date_fetch = now_utc - timedelta(hours=3)
        min_start_date = now_utc - timedelta(hours=24)
        start_date_fetch = max(start_date_fetch, min_start_date)

        logger.info(f"Periodic fetch: from {start_date_fetch} to {now_utc}")
        await fetch_bouncie_trips_in_range(
            start_date_fetch, now_utc, do_map_match=True
        )

        await update_one_with_retry(
            task_config_collection,
            {"_id": "global_background_task_config"},
            {"$set": {f"tasks.{task_name}.last_success_time": now_utc}},
            upsert=True,
        )
        result_data = {
            "status": "success",
            "message": "Trips fetched successfully",
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(
            task_name, TaskStatus.COMPLETED.value
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.COMPLETED.value,
            result=result_data,
            end_time=end_time,
            runtime_ms=runtime,
        )
        logger.info(
            f"Task {task_name} ({celery_task_id}) completed in {runtime:.0f}ms."
        )
        return result_data

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Error in {task_name}: {e}"
        logger.exception(
            f"Task {task_name} ({celery_task_id}) failed: {error_msg}"
        )
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(e)
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(e),
            end_time=end_time,
            runtime_ms=runtime,
        )
        try:
            raise self.retry(exc=e, countdown=60)
        except Exception:
            raise e


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    time_limit=3600,
    soft_time_limit=3300,
    name="tasks.periodic_fetch_trips",
    queue="high_priority",
)
def periodic_fetch_trips(self):
    return asyncio.run(periodic_fetch_trips_async(self))


# 2. UPDATE COVERAGE FOR NEW TRIPS


async def update_coverage_for_new_trips_async(self) -> Dict[str, Any]:
    task_name = "update_coverage_for_new_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    processed_areas = 0
    result_data = {}
    try:
        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")

        # Retrieve coverage areas and update each one.
        coverage_areas = await find_with_retry(
            coverage_metadata_collection, {}
        )
        for area in coverage_areas:
            location = area.get("location")
            area_id_str = str(area.get("_id"))
            display_name = (
                location.get("display_name", "Unknown")
                if location
                else "Unknown"
            )
            if not location:
                logger.warning(
                    f"Skipping area {area_id_str} due to missing location data."
                )
                continue
            sub_task_id = f"auto_update_{area_id_str}_{uuid.uuid4()}"
            logger.info(
                f"Processing incremental update for {display_name} (SubTask: {sub_task_id})"
            )
            try:
                result = await compute_incremental_coverage(
                    location, sub_task_id
                )
                if result:
                    logger.info(
                        f"Updated coverage for {display_name}: {result.get('coverage_percentage', 0):.2f}%"
                    )
                    processed_areas += 1
                else:
                    logger.warning(
                        f"Incremental update failed or returned no result for {display_name}"
                    )
                await asyncio.sleep(0.5)
            except Exception as inner_e:
                logger.error(
                    f"Error updating coverage for {display_name}: {inner_e}",
                    exc_info=True,
                )
                await update_one_with_retry(
                    progress_collection,
                    {"_id": sub_task_id},
                    {
                        "$set": {
                            "stage": "error",
                            "error": str(inner_e),
                            "updated_at": datetime.now(timezone.utc),
                        }
                    },
                    upsert=True,
                )
                continue
        logger.info(
            f"Completed automated incremental updates for {processed_areas} areas"
        )
        result_data = {"status": "success", "areas_processed": processed_areas}
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(
            task_name, TaskStatus.COMPLETED.value
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.COMPLETED.value,
            result=result_data,
            end_time=end_time,
            runtime_ms=runtime,
        )
        logger.info(
            f"Task {task_name} ({celery_task_id}) completed in {runtime:.0f}ms."
        )
        return result_data

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Error in {task_name}: {e}"
        logger.exception(
            f"Task {task_name} ({celery_task_id}) failed: {error_msg}"
        )
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(e)
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(e),
            end_time=end_time,
            runtime_ms=runtime,
        )
        try:
            raise self.retry(exc=e)
        except Exception:
            raise e


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.update_coverage_for_new_trips",
    queue="default",
)
def update_coverage_for_new_trips(self):
    return asyncio.run(update_coverage_for_new_trips_async(self))


# 3. CLEANUP STALE TRIPS


async def cleanup_stale_trips_async(self) -> Dict[str, Any]:
    task_name = "cleanup_stale_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    result_data = {}
    try:
        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")

        # Execute cleanup logic for stale trips.
        cleanup_result = await cleanup_stale_trips_logic()
        count = cleanup_result.get("stale_trips_archived", 0)
        logger.info(f"Cleaned up {count} stale trips")
        result_data = {
            "status": "success",
            "message": f"Cleaned up {count} stale trips",
            "details": cleanup_result,
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(
            task_name, TaskStatus.COMPLETED.value
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.COMPLETED.value,
            result=result_data,
            end_time=end_time,
            runtime_ms=runtime,
        )
        logger.info(
            f"Task {task_name} ({celery_task_id}) completed in {runtime:.0f}ms."
        )
        return result_data

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Error in {task_name}: {e}"
        logger.exception(
            f"Task {task_name} ({celery_task_id}) failed: {error_msg}"
        )
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(e)
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(e),
            end_time=end_time,
            runtime_ms=runtime,
        )
        try:
            raise self.retry(exc=e)
        except Exception:
            raise e


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    time_limit=1800,
    soft_time_limit=1700,
    name="tasks.cleanup_stale_trips",
    queue="low_priority",
)
def cleanup_stale_trips(self):
    return asyncio.run(cleanup_stale_trips_async(self))


# 4. CLEANUP INVALID TRIPS


async def cleanup_invalid_trips_async(self) -> Dict[str, Any]:
    task_name = "cleanup_invalid_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    processed_count = 0
    modified_count = 0
    batch_size = 500
    result_data = {}
    try:
        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")

        # Process trips in batches.
        cursor = trips_collection.find(
            {}, {"startTime": 1, "endTime": 1, "gps": 1, "_id": 1}
        )
        async for trip in cursor:
            valid, message = validate_trip_data_logic(trip)
            if not valid:
                update_ops = [
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
                ]
                result = await trips_collection.bulk_write(update_ops)
                modified_count += result.modified_count
            processed_count += 1
            if processed_count % batch_size == 0:
                logger.info(f"Processed batch of {batch_size} trips.")
                await asyncio.sleep(0)
        result_data = {
            "status": "success",
            "message": f"Processed {processed_count} trips, marked {modified_count} as invalid",
            "processed_count": processed_count,
            "modified_count": modified_count,
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(
            task_name, TaskStatus.COMPLETED.value
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.COMPLETED.value,
            result=result_data,
            end_time=end_time,
            runtime_ms=runtime,
        )
        logger.info(
            f"Task {task_name} ({celery_task_id}) completed in {runtime:.0f}ms."
        )
        return result_data

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Error in {task_name}: {e}"
        logger.exception(
            f"Task {task_name} ({celery_task_id}) failed: {error_msg}"
        )
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(e)
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(e),
            end_time=end_time,
            runtime_ms=runtime,
        )
        try:
            raise self.retry(exc=e)
        except Exception:
            raise e


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.cleanup_invalid_trips",
    queue="low_priority",
)
def cleanup_invalid_trips(self):
    return asyncio.run(cleanup_invalid_trips_async(self))


# 5. UPDATE GEOCODING


async def update_geocoding_async(self) -> Dict[str, Any]:
    task_name = "update_geocoding"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    geocoded_count = 0
    failed_count = 0
    limit = 100
    result_data = {}
    try:
        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")

        query = {
            "$or": [
                {"startLocation": {"$exists": False}},
                {"destination": {"$exists": False}},
                {"startLocation": ""},
                {"destination": ""},
            ]
        }
        trips_to_process = await find_with_retry(
            trips_collection, query, limit=limit
        )
        mapbox_token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
        if not mapbox_token:
            logger.warning(
                "MAPBOX_ACCESS_TOKEN not set, cannot perform geocoding."
            )
            raise ValueError("MAPBOX_ACCESS_TOKEN is not configured.")

        for trip in trips_to_process:
            trip_id = trip.get("transactionId", str(trip.get("_id")))
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=mapbox_token, source=source
                )
                processor.set_trip_data(trip)
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
                logger.warning(
                    f"Geocoding failed for trip {trip_id}. State: {processor.state.value}"
                )
            except Exception as e:
                logger.error(
                    f"Error geocoding trip {trip_id}: {e}", exc_info=False
                )
                failed_count += 1
            await asyncio.sleep(0.2)
        logger.info(f"Geocoded {geocoded_count} trips ({failed_count} failed)")
        result_data = {
            "status": "success",
            "geocoded_count": geocoded_count,
            "failed_count": failed_count,
            "message": f"Geocoded {geocoded_count} trips ({failed_count} failed)",
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(
            task_name, TaskStatus.COMPLETED.value
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.COMPLETED.value,
            result=result_data,
            end_time=end_time,
            runtime_ms=runtime,
        )
        logger.info(
            f"Task {task_name} ({celery_task_id}) completed in {runtime:.0f}ms."
        )
        return result_data

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Error in {task_name}: {e}"
        logger.exception(
            f"Task {task_name} ({celery_task_id}) failed: {error_msg}"
        )
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(e)
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(e),
            end_time=end_time,
            runtime_ms=runtime,
        )
        try:
            raise self.retry(exc=e)
        except Exception:
            raise e


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.update_geocoding",
    queue="default",
)
def update_geocoding(self):
    return asyncio.run(update_geocoding_async(self))


# 6. REMAP UNMATCHED TRIPS


async def remap_unmatched_trips_async(self) -> Dict[str, Any]:
    task_name = "remap_unmatched_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    remap_count = 0
    failed_count = 0
    limit = 50
    result_data = {}
    try:
        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")
        dependency_check = await check_dependencies(task_name)
        if not dependency_check["can_run"]:
            reason = dependency_check.get("reason", "Unknown reason")
            logger.info(f"Deferring {task_name}: {reason}")
            result_data = {"status": "deferred", "message": reason}
            await status_manager.update_status(
                task_name, TaskStatus.COMPLETED.value
            )
            await update_task_history_entry(
                celery_task_id=celery_task_id,
                task_name=task_name,
                status=TaskStatus.COMPLETED.value,
                result=result_data,
                end_time=datetime.now(timezone.utc),
                runtime_ms=0,
            )
            return result_data

        # Fetch matched trip IDs to skip already processed trips.
        matched_ids_cursor = matched_trips_collection.find(
            {}, {"transactionId": 1}
        )
        matched_ids = {
            doc["transactionId"]
            async for doc in matched_ids_cursor
            if "transactionId" in doc
        }
        query = {"transactionId": {"$nin": list(matched_ids)}}
        trips_to_process = await find_with_retry(
            trips_collection, query, limit=limit
        )

        for trip in trips_to_process:
            trip_id = trip.get("transactionId", str(trip.get("_id")))
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=os.environ.get("MAPBOX_ACCESS_TOKEN", ""),
                    source=source,
                )
                processor.set_trip_data(trip)
                await processor.process(do_map_match=True)
                result = await processor.save(map_match_result=True)
                if result:
                    remap_count += 1
                else:
                    failed_count += 1
                    status_info = processor.get_processing_status()
                    logger.warning(
                        f"Failed to remap trip {trip_id}: {status_info}"
                    )
            except Exception as e:
                logger.warning(
                    f"Error remapping trip {trip_id}: {e}", exc_info=False
                )
                failed_count += 1
            await asyncio.sleep(0.5)
        logger.info(f"Remapped {remap_count} trips ({failed_count} failed)")
        result_data = {
            "status": "success",
            "remapped_count": remap_count,
            "failed_count": failed_count,
            "message": f"Remapped {remap_count} trips ({failed_count} failed)",
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(
            task_name, TaskStatus.COMPLETED.value
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.COMPLETED.value,
            result=result_data,
            end_time=end_time,
            runtime_ms=runtime,
        )
        logger.info(
            f"Task {task_name} ({celery_task_id}) completed in {runtime:.0f}ms."
        )
        return result_data

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Error in {task_name}: {e}"
        logger.exception(
            f"Task {task_name} ({celery_task_id}) failed: {error_msg}"
        )
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(e)
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(e),
            end_time=end_time,
            runtime_ms=runtime,
        )
        try:
            raise self.retry(exc=e)
        except Exception:
            raise e


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.remap_unmatched_trips",
    queue="default",
)
def remap_unmatched_trips(self):
    return asyncio.run(remap_unmatched_trips_async(self))


# 7. VALIDATE TRIP DATA


async def validate_trip_data_async(self) -> Dict[str, Any]:
    task_name = "validate_trip_data"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    processed_count = 0
    failed_count = 0
    limit = 100
    result_data = {}
    try:
        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")
        query = {"validated_at": {"$exists": False}}
        trips_to_process = await find_with_retry(
            trips_collection, query, limit=limit
        )
        mapbox_token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
        for trip in trips_to_process:
            trip_id = str(trip.get("_id"))
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=mapbox_token, source=source
                )
                processor.set_trip_data(trip)
                await processor.validate()
                status_info = processor.get_processing_status()
                validation_errors = status_info.get("errors", {}).get(
                    TripState.NEW.value
                )
                update_data = {
                    "validated_at": datetime.now(timezone.utc),
                    "validation_status": status_info["state"],
                    "invalid": status_info["state"] == TripState.FAILED.value,
                    "validation_message": validation_errors
                    if status_info["state"] == TripState.FAILED.value
                    else None,
                }
                await update_one_with_retry(
                    trips_collection,
                    {"_id": trip["_id"]},
                    {"$set": update_data},
                )
                processed_count += 1
            except Exception as e:
                logger.error(
                    f"Error validating trip {trip_id}: {e}", exc_info=False
                )
                failed_count += 1
                try:
                    await update_one_with_retry(
                        trips_collection,
                        {"_id": trip["_id"]},
                        {
                            "$set": {
                                "validated_at": datetime.now(timezone.utc),
                                "validation_status": TaskStatus.FAILED.value,
                                "invalid": True,
                                "validation_message": f"Task Error: {str(e)}",
                            }
                        },
                    )
                except Exception as update_err:
                    logger.error(
                        f"Failed to mark trip {trip_id} as failed validation: {update_err}"
                    )
        logger.info(
            f"Validated {processed_count} trips ({failed_count} failed)"
        )
        result_data = {
            "status": "success",
            "validated_count": processed_count,
            "failed_count": failed_count,
            "message": f"Validated {processed_count} trips ({failed_count} failed)",
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(
            task_name, TaskStatus.COMPLETED.value
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.COMPLETED.value,
            result=result_data,
            end_time=end_time,
            runtime_ms=runtime,
        )
        logger.info(
            f"Task {task_name} ({celery_task_id}) completed in {runtime:.0f}ms."
        )
        return result_data

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Error in {task_name}: {e}"
        logger.exception(
            f"Task {task_name} ({celery_task_id}) failed: {error_msg}"
        )
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(e)
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(e),
            end_time=end_time,
            runtime_ms=runtime,
        )
        try:
            raise self.retry(exc=e)
        except Exception:
            raise e


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.validate_trip_data",
    queue="low_priority",
)
def validate_trip_data(self):
    return asyncio.run(validate_trip_data_async(self))


# 8. RUN TASK SCHEDULER


async def run_task_scheduler_async(self) -> None:
    triggered_count = 0
    skipped_count = 0
    now_utc = datetime.now(timezone.utc)
    logger.debug(f"Scheduler task running at {now_utc.isoformat()}")
    status_manager = TaskStatusManager.get_instance()
    try:
        config = await get_task_config()
        if not config or config.get("disabled", False):
            logger.info(
                "Task scheduling is globally disabled. Exiting scheduler task."
            )
            return None

        tasks_to_check = config.get("tasks", {})
        task_name_mapping = {
            "periodic_fetch_trips": "tasks.periodic_fetch_trips",
            "cleanup_stale_trips": "tasks.cleanup_stale_trips",
            "cleanup_invalid_trips": "tasks.cleanup_invalid_trips",
            "update_geocoding": "tasks.update_geocoding",
            "remap_unmatched_trips": "tasks.remap_unmatched_trips",
            "validate_trip_data": "tasks.validate_trip_data",
            "update_coverage_for_new_trips": "tasks.update_coverage_for_new_trips",
        }
        tasks_to_trigger = []

        for task_id, task_config in tasks_to_check.items():
            if task_id not in task_name_mapping:
                logger.debug(
                    f"Skipping unknown task_id '{task_id}' in scheduler."
                )
                continue
            is_enabled = task_config.get("enabled", True)
            current_status = task_config.get("status")
            interval_minutes = task_config.get("interval_minutes")
            last_run_any = task_config.get("last_run")
            if (
                not is_enabled
                or current_status == TaskStatus.RUNNING.value
                or current_status == TaskStatus.PENDING.value
                or interval_minutes is None
                or interval_minutes <= 0
            ):
                skipped_count += 1
                continue

            last_run = None
            if isinstance(last_run_any, datetime):
                last_run = last_run_any
            elif isinstance(last_run_any, str):
                try:
                    last_run = datetime.fromisoformat(
                        last_run_any.replace("Z", "+00:00")
                    )
                except ValueError:
                    pass
            if last_run and last_run.tzinfo is None:
                last_run = last_run.replace(tzinfo=timezone.utc)
            is_due = False
            if last_run is None:
                is_due = True
                logger.debug(f"Task '{task_id}' is due (never run).")
            else:
                next_due_time = last_run + timedelta(minutes=interval_minutes)
                if now_utc >= next_due_time:
                    is_due = True
                    logger.debug(
                        f"Task '{task_id}' is due (last run: {last_run.isoformat()}, interval: {interval_minutes}m)."
                    )
            if is_due:
                dependency_check = await check_dependencies(task_id)
                if dependency_check["can_run"]:
                    tasks_to_trigger.append(task_id)
                else:
                    logger.warning(
                        f"Task '{task_id}' due but dependencies not met: {dependency_check.get('reason')}"
                    )
                    skipped_count += 1
            else:
                skipped_count += 1

        if not tasks_to_trigger:
            logger.debug("No tasks due to trigger this cycle.")
            return None

        for task_id_to_run in tasks_to_trigger:
            try:
                celery_task_name = task_name_mapping[task_id_to_run]
                priority_enum = TASK_METADATA[task_id_to_run].get(
                    "priority", TaskPriority.MEDIUM
                )
                priority_name = priority_enum.name.lower()
                queue = (
                    f"{priority_name}_priority"
                    if priority_name in ["high", "low"]
                    else "default"
                )
                celery_task_id = f"{task_id_to_run}_scheduled_{uuid.uuid4()}"
                celery_app.send_task(
                    celery_task_name,
                    task_id=celery_task_id,
                    queue=queue,
                )
                await status_manager.update_status(
                    task_id_to_run, TaskStatus.PENDING.value
                )
                await update_task_history_entry(
                    celery_task_id=celery_task_id,
                    task_name=task_id_to_run,
                    status=TaskStatus.PENDING.value,
                    manual_run=False,
                    start_time=now_utc,
                )
                triggered_count += 1
                logger.info(
                    f"Triggered task '{task_id_to_run}' with Celery ID {celery_task_id} on queue {queue}"
                )
                await asyncio.sleep(0.1)
            except Exception as trigger_err:
                logger.error(
                    f"Failed to trigger task '{task_id_to_run}': {trigger_err}",
                    exc_info=True,
                )
                await status_manager.update_status(
                    task_id_to_run,
                    TaskStatus.FAILED.value,
                    error=f"Trigger failed: {trigger_err}",
                )
        return None

    except Exception as e:
        logger.exception(f"Critical Error in run_task_scheduler: {e}")
        raise


@shared_task(
    bind=True,
    name="tasks.run_task_scheduler",
    queue="high_priority",
    ignore_result=True,
)
def run_task_scheduler(self):
    return asyncio.run(run_task_scheduler_async(self))


# ------------------------------------------------------------------------------
# API Functions (Manual run, update schedule, etc.) remain async and are invoked elsewhere.
# ------------------------------------------------------------------------------
async def get_all_task_metadata() -> Dict[str, Any]:
    try:
        task_config = await get_task_config()
        task_metadata_with_status = {}
        for task_id, metadata in TASK_METADATA.items():
            task_metadata_with_status[task_id] = metadata.copy()
            config_data = task_config.get("tasks", {}).get(task_id, {})
            estimated_next_run = None
            last_run_any = config_data.get("last_run")
            interval_minutes = config_data.get(
                "interval_minutes", metadata.get("default_interval_minutes")
            )
            last_run = None
            if isinstance(last_run_any, datetime):
                last_run = last_run_any
            elif isinstance(last_run_any, str):
                try:
                    last_run = datetime.fromisoformat(
                        last_run_any.replace("Z", "+00:00")
                    )
                except ValueError:
                    pass
            if last_run and interval_minutes and interval_minutes > 0:
                if last_run.tzinfo is None:
                    last_run = last_run.replace(tzinfo=timezone.utc)
                estimated_next_run = last_run + timedelta(
                    minutes=interval_minutes
                )
            priority_enum = metadata.get("priority", TaskPriority.MEDIUM)
            priority_name = (
                priority_enum.name
                if isinstance(priority_enum, TaskPriority)
                else str(priority_enum)
            )
            task_metadata_with_status[task_id].update(
                {
                    "enabled": config_data.get("enabled", True),
                    "interval_minutes": interval_minutes,
                    "status": config_data.get("status", TaskStatus.IDLE.value),
                    "last_run": SerializationHelper.serialize_datetime(
                        last_run
                    ),
                    "next_run": SerializationHelper.serialize_datetime(
                        estimated_next_run
                    ),
                    "last_error": config_data.get("last_error"),
                    "start_time": SerializationHelper.serialize_datetime(
                        config_data.get("start_time")
                    ),
                    "end_time": SerializationHelper.serialize_datetime(
                        config_data.get("end_time")
                    ),
                    "last_updated": SerializationHelper.serialize_datetime(
                        config_data.get("last_updated")
                    ),
                    "priority": priority_name,
                }
            )
        return task_metadata_with_status
    except Exception as e:
        logger.exception(f"Error getting all task metadata: {e}")
        fallback_metadata = {}
        for task_id, metadata in TASK_METADATA.items():
            priority_enum = metadata.get("priority", TaskPriority.MEDIUM)
            priority_name = (
                priority_enum.name
                if isinstance(priority_enum, TaskPriority)
                else str(priority_enum)
            )
            fallback_metadata[task_id] = {
                **metadata,
                "priority": priority_name,
            }
        return fallback_metadata


async def manual_run_task(task_id: str) -> Dict[str, Any]:
    task_mapping = {
        "periodic_fetch_trips": "tasks.periodic_fetch_trips",
        "cleanup_stale_trips": "tasks.cleanup_stale_trips",
        "cleanup_invalid_trips": "tasks.cleanup_invalid_trips",
        "update_geocoding": "tasks.update_geocoding",
        "remap_unmatched_trips": "tasks.remap_unmatched_trips",
        "validate_trip_data": "tasks.validate_trip_data",
        "update_coverage_for_new_trips": "tasks.update_coverage_for_new_trips",
    }
    if task_id == "ALL":
        config = await get_task_config()
        enabled_tasks = [
            t_name
            for t_name, t_config in config.get("tasks", {}).items()
            if t_config.get("enabled", True) and t_name in task_mapping
        ]
        results = []
        for task_name in enabled_tasks:
            single_result = await _send_manual_task(
                task_name, task_mapping[task_name]
            )
            results.append(single_result)
        success = all(r.get("success", False) for r in results)
        return {
            "status": "success" if success else "partial_error",
            "message": f"Triggered {len(results)} tasks.",
            "results": results,
        }
    elif task_id in task_mapping:
        result = await _send_manual_task(task_id, task_mapping[task_id])
        return {
            "status": "success" if result.get("success") else "error",
            "message": result.get(
                "message", f"Failed to schedule task {task_id}"
            ),
            "task_id": result.get("task_id"),
        }
    else:
        return {
            "status": "error",
            "message": f"Unknown or non-runnable task: {task_id}",
        }


async def _send_manual_task(
    task_name: str, celery_task_string_name: str
) -> Dict[str, Any]:
    status_manager = TaskStatusManager.get_instance()
    try:
        dependency_check = await check_dependencies(task_name)
        if not dependency_check["can_run"]:
            reason = dependency_check.get("reason", "Dependencies not met")
            logger.warning(f"Manual run for {task_name} skipped: {reason}")
            return {"task": task_name, "success": False, "message": reason}
        priority_enum = TASK_METADATA[task_name].get(
            "priority", TaskPriority.MEDIUM
        )
        priority_name = priority_enum.name.lower()
        queue = (
            f"{priority_name}_priority"
            if priority_name in ["high", "low"]
            else "default"
        )
        celery_task_id = f"{task_name}_manual_{uuid.uuid4()}"
        result = celery_app.send_task(
            celery_task_string_name, task_id=celery_task_id, queue=queue
        )
        await status_manager.update_status(task_name, TaskStatus.PENDING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.PENDING.value,
            manual_run=True,
            start_time=datetime.now(timezone.utc),
        )
        logger.info(
            f"Manually triggered task {task_name} with Celery ID {celery_task_id} on queue {queue}"
        )
        return {
            "task": task_name,
            "success": True,
            "message": f"Task {task_name} scheduled",
            "task_id": result.id,
        }
    except Exception as e:
        logger.exception(f"Error sending manual task {task_name}")
        await status_manager.update_status(
            task_name,
            TaskStatus.FAILED.value,
            error=f"Manual trigger failed: {e}",
        )
        return {"task": task_name, "success": False, "message": str(e)}


async def update_task_schedule(
    task_config_update: Dict[str, Any],
) -> Dict[str, Any]:
    try:
        global_disable_update = task_config_update.get("globalDisable")
        tasks_update = task_config_update.get("tasks", {})
        changes = []
        update_payload = {}
        if global_disable_update is not None:
            update_payload["disabled"] = global_disable_update
            changes.append(f"Global disable set to {global_disable_update}")
        if tasks_update:
            current_config = await get_task_config()
            current_tasks = current_config.get("tasks", {})
            for task_id, settings in tasks_update.items():
                if task_id in TASK_METADATA:
                    current_settings = current_tasks.get(task_id, {})
                    if "enabled" in settings:
                        new_val = settings["enabled"]
                        old_val = current_settings.get("enabled", True)
                        if new_val != old_val:
                            update_payload[f"tasks.{task_id}.enabled"] = (
                                new_val
                            )
                            changes.append(
                                f"Task {task_id} enabled: {old_val} -> {new_val}"
                            )
                    if "interval_minutes" in settings:
                        try:
                            new_val = int(settings["interval_minutes"])
                            if new_val <= 0:
                                logger.warning(
                                    f"Ignoring invalid interval <= 0 for task {task_id}"
                                )
                                continue
                        except (ValueError, TypeError):
                            logger.warning(
                                f"Ignoring non-integer interval for task {task_id}: {settings['interval_minutes']}"
                            )
                            continue
                        old_val = current_settings.get(
                            "interval_minutes",
                            TASK_METADATA[task_id]["default_interval_minutes"],
                        )
                        if new_val != old_val:
                            update_payload[
                                f"tasks.{task_id}.interval_minutes"
                            ] = new_val
                            changes.append(
                                f"Task {task_id} interval: {old_val} -> {new_val} mins"
                            )
                else:
                    logger.warning(
                        f"Attempted to update config for unknown task: {task_id}"
                    )
        if not update_payload:
            return {
                "status": "success",
                "message": "No configuration changes detected.",
            }
        result = await update_one_with_retry(
            task_config_collection,
            {"_id": "global_background_task_config"},
            {"$set": update_payload},
            upsert=True,
        )
        if result.modified_count > 0 or result.upserted_id is not None:
            logger.info(f"Task configuration updated: {', '.join(changes)}")
            return {
                "status": "success",
                "message": "Task configuration updated.",
                "changes": changes,
            }
        else:
            logger.info(
                "Task configuration update requested but no document was modified (values might be the same)."
            )
            return {
                "status": "success",
                "message": "No changes applied to task configuration (values may already match).",
            }
    except Exception as e:
        logger.exception(f"Error updating task schedule: {e}")
        return {
            "status": "error",
            "message": f"Error updating task schedule: {str(e)}",
        }
