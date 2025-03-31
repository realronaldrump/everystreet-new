# tasks.py

"""Background tasks implementation using Celery.

This module provides task definitions for all background tasks performed by the
application. It handles proper integration between Celery's synchronous tasks
and FastAPI's asynchronous code patterns, using the centralized db_manager.
"""

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from enum import Enum
from functools import wraps
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Optional,
    TypeVar,
    cast,
)

from pymongo import UpdateOne
from celery import Task, shared_task
from celery.signals import task_failure, task_postrun, task_prerun
from celery.utils.log import get_task_logger

# --- Local Imports ---
# Import db_manager and necessary functions/collections from db.py
from db import (
    SerializationHelper,
    find_one_with_retry,
    find_with_retry,
    update_one_with_retry,
    # Specific collections needed by tasks/helpers
    coverage_metadata_collection,
    matched_trips_collection,
    progress_collection,
    task_config_collection,
    task_history_collection,
    trips_collection,
)
from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from live_tracking import cleanup_stale_trips
from street_coverage_calculation import (
    compute_incremental_coverage,
)
from trip_processor import TripProcessor, TripState
from utils import validate_trip_data
from celery_app import app as celery_app

# Set up task-specific logger
logger = get_task_logger(__name__)

# Type variable for async function return
T = TypeVar("T")


# Task priorities for UI display
class TaskPriority(Enum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3

    @classmethod
    def from_string(cls, priority_str: str) -> "TaskPriority":
        priority_map = {"LOW": cls.LOW, "MEDIUM": cls.MEDIUM, "HIGH": cls.HIGH}
        return priority_map.get(priority_str, cls.MEDIUM)


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


# Central task status manager using db_manager
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
        """Update task status using db_manager."""
        try:
            now = datetime.now(timezone.utc)
            update_data = {
                f"tasks.{task_id}.status": status,
                f"tasks.{task_id}.last_updated": now,
            }

            if status == TaskStatus.RUNNING.value:
                update_data[f"tasks.{task_id}.start_time"] = now
                update_data[f"tasks.{task_id}.end_time"] = None  # Clear end time
                update_data[f"tasks.{task_id}.last_error"] = None  # Clear last error

            elif status == TaskStatus.COMPLETED.value:
                update_data[f"tasks.{task_id}.last_run"] = now
                update_data[f"tasks.{task_id}.end_time"] = now
                update_data[f"tasks.{task_id}.last_error"] = None  # Clear last error
                # Calculate next run based on interval
                config = await get_task_config()  # Use the refactored helper
                task_config_data = config.get("tasks", {}).get(task_id, {})
                interval_minutes = task_config_data.get(
                    "interval_minutes",
                    TASK_METADATA.get(task_id, {}).get("default_interval_minutes", 60),
                )
                next_run = now + timedelta(minutes=interval_minutes)
                update_data[f"tasks.{task_id}.next_run"] = next_run

            elif status == TaskStatus.FAILED.value:
                update_data[f"tasks.{task_id}.last_error"] = error
                update_data[f"tasks.{task_id}.last_run"] = (
                    now  # Record last attempt time
                )
                update_data[f"tasks.{task_id}.end_time"] = now

            # Use update_one_with_retry from db.py
            result = await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": update_data},
                upsert=True,  # Ensure config doc exists
            )
            return result.modified_count > 0 or result.upserted_id is not None

        except Exception as e:
            logger.exception(f"Error updating task status for {task_id}: {e}")
            return False

    def sync_update_status(
        self, task_id: str, status: str, error: Optional[str] = None
    ) -> bool:
        """Synchronous wrapper for status updates (for Celery signals) using
        asyncio.run()."""
        try:
            # asyncio.run() creates a new event loop if one isn't running
            return asyncio.run(self.update_status(task_id, status, error))
        except RuntimeError as e:
            # Handle cases where asyncio.run() might conflict with existing loops
            # This might happen in complex Celery setups, though less likely now.
            logger.error(
                f"RuntimeError calling sync_update_status for {task_id}: {e}. Falling back slightly."
            )
            # Fallback: Schedule the async update without waiting (less reliable for immediate state)
            try:
                loop = asyncio.get_event_loop()
                loop.create_task(self.update_status(task_id, status, error))
                return True  # Assume it will likely succeed
            except Exception as fallback_e:
                logger.error(
                    f"Error in sync_update_status fallback for {task_id}: {fallback_e}"
                )
                return False
        except Exception as e:
            logger.exception(f"General error in sync_update_status for {task_id}: {e}")
            return False


# Base class for async tasks
class AsyncTask(Task):
    """Enhanced base class for Celery tasks that need to run async code."""

    @staticmethod
    def run_async(coro_func: Callable[[], Awaitable[T]]) -> T:
        """Run an async coroutine function from a Celery task."""
        try:
            # Use asyncio.run() which handles loop creation/closing
            return asyncio.run(coro_func())
        except Exception as e:
            logger.exception(f"Error in run_async execution: {e}")
            raise  # Re-raise the exception so Celery marks the task as failed


# --- Signal Handlers (Refactored to use db_manager and TaskStatusManager) ---


@task_prerun.connect
def task_started(task_id: Optional[str] = None, task: Optional[Task] = None, **kwargs):
    """Record when a task starts running and update its status."""
    if not task or not task.name or not task_id:
        logger.warning("task_prerun signal received without task/task_id.")
        return

    task_name = task.name.split(".")[-1]
    celery_task_id_str = str(task_id)  # Use the actual Celery task ID

    try:
        # --- Check if task is enabled (using asyncio.run and db_manager) ---
        async def check_enabled():
            config = await get_task_config()  # Use refactored helper
            globally_disabled = config.get("disabled", False)
            task_config_data = config.get("tasks", {}).get(task_name, {})
            task_disabled = not task_config_data.get("enabled", True)
            return not (globally_disabled or task_disabled)

        is_enabled = asyncio.run(check_enabled())

        if not is_enabled:
            logger.info(
                f"Task {task_name} ({celery_task_id_str}) is disabled, skipping execution."
            )
            # To prevent execution, we might need a custom mechanism or rely on task logic to check.
            # For now, we'll log and update status, but Celery might still run it briefly.
            # A more robust way involves custom Task classes or checking within the task itself.
            status_manager = TaskStatusManager.get_instance()
            status_manager.sync_update_status(
                task_name, TaskStatus.IDLE.value, error="Task disabled"
            )  # Reset to IDLE
            # Ideally, prevent the task run altogether here if possible with Celery mechanisms.
            return  # Or raise an exception if that reliably stops Celery execution

        # --- Update Status and History (using TaskStatusManager and db_manager) ---
        status_manager = TaskStatusManager.get_instance()
        status_updated = status_manager.sync_update_status(
            task_name, TaskStatus.RUNNING.value
        )

        if not status_updated:
            logger.error(
                f"Failed to update RUNNING status for task {task_name} ({celery_task_id_str})"
            )
            # Continue with history update attempt

        # Record history entry using asyncio.run
        async def update_history():
            now = datetime.now(timezone.utc)
            await update_one_with_retry(
                task_history_collection,
                {"_id": celery_task_id_str},  # Use Celery task ID as document ID
                {
                    "$set": {
                        "task_id": task_name,
                        "status": TaskStatus.RUNNING.value,
                        "timestamp": now,  # General timestamp
                        "start_time": now,  # Specific start time
                        # manual_run needs context, maybe pass via headers? Defaulting to False
                        "manual_run": task.request.get("manual_run", False),
                        "end_time": None,
                        "runtime": None,
                        "result": None,
                        "error": None,
                    }
                },
                upsert=True,
            )

        asyncio.run(update_history())

        logger.info(f"Task {task_name} ({celery_task_id_str}) started")

    except Exception as e:
        logger.exception(
            f"Error in task_prerun for {task_name} ({celery_task_id_str}): {e}"
        )


@task_postrun.connect
def task_finished(
    task_id: Optional[str] = None,
    task: Optional[Task] = None,
    retval: Any = None,
    state: Optional[str] = None,
    **kwargs,
):
    """Record when a task finishes running and update its status."""
    if not task or not task.name or not task_id:
        logger.warning("task_postrun signal received without task/task_id.")
        return

    task_name = task.name.split(".")[-1]
    celery_task_id_str = str(task_id)

    try:
        now = datetime.now(timezone.utc)
        final_status = (
            TaskStatus.COMPLETED.value
            if state == "SUCCESS"
            else TaskStatus.FAILED.value
        )
        error_msg = None
        result_val = None

        if final_status == TaskStatus.FAILED.value:
            if isinstance(retval, Exception):
                error_msg = str(retval)
            elif (
                isinstance(retval, dict) and "exc_message" in retval
            ):  # Celery often puts exception here
                error_msg = retval["exc_message"]
                if isinstance(error_msg, list):
                    error_msg = error_msg[0]  # Take first line
            else:
                error_msg = f"Task failed with state {state}"
            logger.error(f"Task {task_name} ({celery_task_id_str}) failed: {error_msg}")
        else:
            result_val = retval  # Store successful return value if needed

        # --- Update Status (using TaskStatusManager) ---
        status_manager = TaskStatusManager.get_instance()
        status_updated = status_manager.sync_update_status(
            task_name, final_status, error=error_msg
        )
        if not status_updated:
            logger.error(
                f"Failed to update final status for task {task_name} ({celery_task_id_str})"
            )

        # --- Update History (using asyncio.run and db_manager) ---
        async def update_history():
            # Get start time to calculate runtime
            history_doc = await find_one_with_retry(
                task_history_collection, {"_id": celery_task_id_str}
            )
            start_time = history_doc.get("start_time") if history_doc else None
            runtime_ms = None
            if start_time:
                if start_time.tzinfo is None:
                    start_time = start_time.replace(tzinfo=timezone.utc)
                runtime_ms = (now - start_time).total_seconds() * 1000

            await update_one_with_retry(
                task_history_collection,
                {"_id": celery_task_id_str},
                {
                    "$set": {
                        "status": final_status,
                        "end_time": now,
                        "runtime": runtime_ms,
                        "result": (
                            result_val
                            if final_status == TaskStatus.COMPLETED.value
                            else None
                        ),
                        "error": (
                            error_msg
                            if final_status == TaskStatus.FAILED.value
                            else None
                        ),
                    }
                },
                # Don't upsert here, prerun should have created it
            )

        asyncio.run(update_history())

        logger.info(
            f"Task {task_name} ({celery_task_id_str}) finished with state {state}"
        )

    except Exception as e:
        logger.exception(
            f"Error in task_postrun for {task_name} ({celery_task_id_str}): {e}"
        )


# Note: task_failure signal might be redundant if task_postrun handles the FAILED state.
# However, keeping it can provide slightly more specific context if needed.
@task_failure.connect
def task_failed_signal_handler(
    task_id: Optional[str] = None,
    task: Optional[Task] = None,
    exception: Optional[Exception] = None,
    **kwargs,
):
    """Handle task failures specifically (might overlap with postrun)."""
    # This handler might be optional if task_postrun correctly handles the 'FAILURE' state.
    # If kept, ensure it doesn't conflict or duplicate updates made by task_postrun.
    # For simplicity, we can rely on task_postrun to handle both SUCCESS and FAILURE.
    # logger.debug(f"task_failure signal caught for {task.name if task else 'unknown'} ({task_id})")
    pass


# --- Task Configuration Helpers (Refactored) ---


async def get_task_config() -> Dict[str, Any]:
    """Get the current task configuration using db_manager."""
    try:
        # Use find_one_with_retry from db.py
        cfg = await find_one_with_retry(
            task_config_collection, {"_id": "global_background_task_config"}
        )

        if not cfg:
            # Create default config if not exists
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
            # Use update_one_with_retry
            await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": cfg},
                upsert=True,
            )
        else:
            # Ensure all tasks from TASK_METADATA exist in the config
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
        # Return a minimal default config on error
        return {
            "_id": "global_background_task_config",
            "disabled": False,
            "tasks": {},
        }


async def check_dependencies(task_id: str) -> Dict[str, Any]:
    """Check if a task's dependencies are satisfied using db_manager."""
    try:
        if task_id not in TASK_METADATA:
            return {"can_run": False, "reason": f"Unknown task: {task_id}"}

        dependencies = TASK_METADATA[task_id].get("dependencies", [])
        if not dependencies:
            return {"can_run": True}

        config = await get_task_config()  # Use refactored helper
        tasks_config = config.get("tasks", {})

        for dep_id in dependencies:
            if dep_id not in tasks_config:
                logger.warning(f"Task {task_id} dependency {dep_id} not configured.")
                continue  # Or treat as failed? For now, skip check.

            dep_status = tasks_config[dep_id].get("status")
            if dep_status == TaskStatus.RUNNING.value:
                return {
                    "can_run": False,
                    "reason": f"Dependency {dep_id} is running",
                }

            if dep_status == TaskStatus.FAILED.value:
                last_updated = tasks_config[dep_id].get("last_updated")
                if last_updated:
                    # Convert if string
                    if isinstance(last_updated, str):
                        try:
                            last_updated = datetime.fromisoformat(
                                last_updated.replace("Z", "+00:00")
                            )
                        except ValueError:
                            last_updated = None  # Ignore invalid date
                    # Add timezone if naive
                    if last_updated and last_updated.tzinfo is None:
                        last_updated = last_updated.replace(tzinfo=timezone.utc)

                    if last_updated and (
                        datetime.now(timezone.utc) - last_updated < timedelta(hours=1)
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


# --- Task History Helper (Refactored) ---


async def update_task_history_entry(  # Renamed for clarity
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
    """Update or insert a task history entry using db_manager."""
    try:
        now = datetime.now(timezone.utc)
        update_fields = {
            "task_id": task_name,
            "status": status,
            "timestamp": now,  # Last updated timestamp
            "manual_run": manual_run,
        }
        if start_time:
            update_fields["start_time"] = start_time
        if end_time:
            update_fields["end_time"] = end_time
        if runtime_ms is not None:
            update_fields["runtime"] = runtime_ms
        if result is not None:
            update_fields["result"] = result
        if error is not None:
            update_fields["error"] = error

        await update_one_with_retry(
            task_history_collection,
            {"_id": celery_task_id},
            {"$set": update_fields},
            upsert=True,
        )
    except Exception as e:
        logger.exception(f"Error updating task history for {celery_task_id}: {e}")


# --- Async Task Wrapper (No changes needed) ---
def async_task_wrapper(func):
    @wraps(func)
    async def wrapped_async_func(*args, **kwargs):
        task_name = func.__name__
        start_time = datetime.now(timezone.utc)
        try:
            logger.info(f"Starting async task logic for {task_name}")
            result = await func(*args, **kwargs)
            runtime = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.info(f"Completed async task logic for {task_name} in {runtime:.2f}s")
            return result
        except Exception as e:
            runtime = (datetime.now(timezone.utc) - start_time).total_seconds()
            error_msg = f"Error in async task logic for {task_name} after {runtime:.2f}s: {str(e)}"
            logger.exception(error_msg)
            raise  # Re-raise for Celery

    return wrapped_async_func


# --- Core Task Implementations (Refactored to use db_manager) ---


@shared_task(
    bind=True,
    base=AsyncTask,
    max_retries=3,
    default_retry_delay=60,
    time_limit=3600,
    soft_time_limit=3300,
    name="tasks.periodic_fetch_trips",
    queue="high_priority",
)
def periodic_fetch_trips(self) -> Dict[str, Any]:
    """Fetch trips from the Bouncie API periodically."""

    @async_task_wrapper
    async def _execute():
        try:
            # Get last successful fetch time from config using db_manager
            task_config_doc = await find_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
            )
            last_success_time = None
            if (
                task_config_doc
                and "tasks" in task_config_doc
                and "periodic_fetch_trips" in task_config_doc["tasks"]
            ):
                last_success_time = task_config_doc["tasks"][
                    "periodic_fetch_trips"
                ].get("last_success_time")

            now_utc = datetime.now(timezone.utc)
            start_date = None
            if last_success_time:
                start_date = last_success_time
                if isinstance(start_date, str):
                    start_date = datetime.fromisoformat(
                        start_date.replace("Z", "+00:00")
                    )
                if start_date.tzinfo is None:
                    start_date = start_date.replace(tzinfo=timezone.utc)
            else:
                # Find the latest 'bouncie' trip using db_manager
                last_bouncie_trip = await find_one_with_retry(
                    trips_collection,
                    {"source": "bouncie"},
                    sort=[("endTime", -1)],
                )
                if last_bouncie_trip and "endTime" in last_bouncie_trip:
                    start_date = last_bouncie_trip["endTime"]
                    if start_date.tzinfo is None:
                        start_date = start_date.replace(tzinfo=timezone.utc)

            if not start_date:
                start_date = now_utc - timedelta(hours=3)
            min_start_date = now_utc - timedelta(hours=24)
            start_date = max(start_date, min_start_date)

            logger.info(f"Periodic fetch: from {start_date} to {now_utc}")

            # Fetch trips (this function internally uses db_manager now implicitly via TripProcessor)
            await fetch_bouncie_trips_in_range(start_date, now_utc, do_map_match=True)

            # Update last success time using db_manager
            await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": {"tasks.periodic_fetch_trips.last_success_time": now_utc}},
                upsert=True,
            )
            return {
                "status": "success",
                "message": "Trips fetched successfully",
            }
        except Exception as e:
            logger.exception(f"Error in periodic_fetch_trips _execute: {e}")
            # Retry using Celery's mechanism by raising the exception
            raise self.retry(exc=e, countdown=60)

    return cast(AsyncTask, self).run_async(_execute)


@shared_task(
    bind=True,
    base=AsyncTask,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.update_coverage_for_new_trips",
    queue="default",
)
def update_coverage_for_new_trips(self) -> Dict[str, Any]:
    """Automatically updates coverage for all locations incrementally."""

    @async_task_wrapper
    async def _execute():
        logger.info("Starting automated incremental coverage updates")
        processed_areas = 0
        try:
            # Get all coverage areas using db_manager
            coverage_areas = await find_with_retry(coverage_metadata_collection, {})

            for area in coverage_areas:
                location = area.get("location")
                area_id_str = str(area.get("_id"))
                display_name = (
                    location.get("display_name", "Unknown") if location else "Unknown"
                )

                if not location:
                    logger.warning(
                        f"Skipping area {area_id_str} due to missing location data."
                    )
                    continue

                task_id = (
                    f"auto_update_{area_id_str}_{uuid.uuid4()}"  # Unique ID per run
                )
                logger.info(
                    f"Processing incremental update for {display_name} (Task: {task_id})"
                )

                try:
                    # This function internally uses db_manager for progress/metadata updates
                    result = await compute_incremental_coverage(location, task_id)
                    if result:
                        logger.info(
                            f"Updated coverage for {display_name}: {result.get('coverage_percentage', 0):.2f}%"
                        )
                        processed_areas += 1
                    else:
                        logger.warning(
                            f"Incremental update failed or returned no result for {display_name}"
                        )
                    await asyncio.sleep(0.5)  # Brief pause
                except Exception as inner_e:
                    logger.error(
                        f"Error updating coverage for {display_name}: {inner_e}",
                        exc_info=True,
                    )
                    # Log error in progress collection for this specific run
                    await update_one_with_retry(
                        progress_collection,
                        {"_id": task_id},
                        {
                            "$set": {
                                "stage": "error",
                                "error": str(inner_e),
                                "updated_at": datetime.now(timezone.utc),
                            }
                        },
                        upsert=True,
                    )
                    continue  # Continue to next area

            logger.info(
                f"Completed automated incremental updates for {processed_areas} areas"
            )
            return {"status": "success", "areas_processed": processed_areas}
        except Exception as e:
            logger.exception(f"Error in automated coverage update task: {e}")
            raise self.retry(exc=e)  # Use Celery retry

    return cast(AsyncTask, self).run_async(_execute)


@shared_task(
    bind=True,
    base=AsyncTask,
    max_retries=3,
    default_retry_delay=60,
    time_limit=1800,
    soft_time_limit=1700,
    name="tasks.cleanup_stale_trips",
    queue="low_priority",
)
def cleanup_stale_trips_task(self) -> Dict[str, Any]:
    """Archive trips that haven't been updated recently."""

    @async_task_wrapper
    async def _execute():
        # cleanup_stale_trips uses db_manager internally
        cleanup_result = await cleanup_stale_trips()
        count = cleanup_result.get("stale_trips_archived", 0)
        logger.info(f"Cleaned up {count} stale trips")
        return {
            "status": "success",
            "message": f"Cleaned up {count} stale trips",
            "details": cleanup_result,
        }

    return cast(AsyncTask, self).run_async(_execute)


@shared_task(
    bind=True,
    base=AsyncTask,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.cleanup_invalid_trips",
    queue="low_priority",
)
def cleanup_invalid_trips(self) -> Dict[str, Any]:
    """Identify and mark invalid trip records."""

    @async_task_wrapper
    async def _execute():
        update_ops = []
        processed_count = 0
        modified_count = 0
        batch_size = 500
        try:
            # Use find_with_retry and iterate
            cursor = trips_collection.find(
                {}, {"startTime": 1, "endTime": 1, "gps": 1, "_id": 1}
            )  # Ensure _id is projected
            async for trip in cursor:  # Motor cursor is async iterable
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
                processed_count += 1

                if len(update_ops) >= batch_size:
                    if update_ops:
                        # Use db_manager's collection directly for bulk_write (no specific retry wrapper needed unless desired)
                        result = await trips_collection.bulk_write(update_ops)
                        modified_count += result.modified_count
                        logger.info(
                            f"Marked {result.modified_count} invalid trips in batch"
                        )
                    update_ops = []  # Reset

            # Process remaining updates
            if update_ops:
                result = await trips_collection.bulk_write(update_ops)
                modified_count += result.modified_count
                logger.info(
                    f"Marked {result.modified_count} invalid trips in final batch"
                )

            return {
                "status": "success",
                "message": f"Processed {processed_count} trips, marked {modified_count} as invalid",
                "processed_count": processed_count,
                "modified_count": modified_count,
            }
        except Exception as e:
            logger.exception(f"Error during cleanup_invalid_trips: {e}")
            raise self.retry(exc=e)

    return cast(AsyncTask, self).run_async(_execute)


@shared_task(
    bind=True,
    base=AsyncTask,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.update_geocoding",
    queue="default",
)
def update_geocoding(self) -> Dict[str, Any]:
    """Update reverse geocoding for trips missing location data."""

    @async_task_wrapper
    async def _execute():
        geocoded_count = 0
        failed_count = 0
        limit = 100
        try:
            query = {
                "$or": [
                    {"startLocation": {"$exists": False}},
                    {"destination": {"$exists": False}},
                    {"startLocation": ""},
                    {"destination": ""},
                ]
            }
            # Use find_with_retry
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

                    await processor.validate()
                    if processor.state == TripState.VALIDATED:
                        await processor.process_basic()
                        if processor.state == TripState.PROCESSED:
                            await processor.geocode()
                            if processor.state == TripState.GEOCODED:
                                # processor.save uses db_manager internally
                                result = await processor.save()
                                if result:
                                    geocoded_count += 1
                                    continue  # Success
                    # If any step failed or didn't reach GEOCODED
                    failed_count += 1
                    logger.warning(
                        f"Geocoding failed for trip {trip_id}. State: {processor.state.value}"
                    )

                except Exception as e:
                    logger.error(f"Error geocoding trip {trip_id}: {e}", exc_info=False)
                    failed_count += 1
                await asyncio.sleep(0.2)  # Rate limiting

            logger.info(f"Geocoded {geocoded_count} trips ({failed_count} failed)")
            return {
                "status": "success",
                "geocoded_count": geocoded_count,
                "failed_count": failed_count,
                "message": f"Geocoded {geocoded_count} trips ({failed_count} failed)",
            }
        except Exception as e:
            logger.exception(f"Error during update_geocoding task: {e}")
            raise self.retry(exc=e)

    return cast(AsyncTask, self).run_async(_execute)


@shared_task(
    bind=True,
    base=AsyncTask,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.remap_unmatched_trips",
    queue="default",
)
def remap_unmatched_trips(self) -> Dict[str, Any]:
    """Attempt to map-match trips that previously failed."""

    @async_task_wrapper
    async def _execute():
        remap_count = 0
        failed_count = 0
        limit = 50
        try:
            # Check dependencies using refactored helper
            dependency_check = await check_dependencies("remap_unmatched_trips")
            if not dependency_check["can_run"]:
                reason = dependency_check.get("reason", "Unknown reason")
                logger.info(f"Deferring remap_unmatched_trips: {reason}")
                return {"status": "deferred", "message": reason}

            # Get IDs of trips already in matched_trips using db_manager
            matched_ids = [
                doc["transactionId"]
                async for doc in matched_trips_collection.find({}, {"transactionId": 1})
                if "transactionId" in doc
            ]

            query = {"transactionId": {"$nin": matched_ids}}
            # Use find_with_retry
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
                    # processor.save uses db_manager internally
                    result = await processor.save(map_match_result=True)

                    if result:
                        remap_count += 1
                    else:
                        failed_count += 1
                        status = processor.get_processing_status()
                        logger.warning(f"Failed to remap trip {trip_id}: {status}")
                except Exception as e:
                    logger.warning(
                        f"Error remapping trip {trip_id}: {e}", exc_info=False
                    )
                    failed_count += 1
                await asyncio.sleep(0.5)  # Rate limiting

            logger.info(f"Remapped {remap_count} trips ({failed_count} failed)")
            return {
                "status": "success",
                "remapped_count": remap_count,
                "failed_count": failed_count,
                "message": f"Remapped {remap_count} trips ({failed_count} failed)",
            }
        except Exception as e:
            logger.exception(f"Error during remap_unmatched_trips task: {e}")
            raise self.retry(exc=e)

    return cast(AsyncTask, self).run_async(_execute)


@shared_task(
    bind=True,
    base=AsyncTask,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.validate_trip_data",
    queue="low_priority",
)
def validate_trip_data_task(self) -> Dict[str, Any]:
    """Validate trip data consistency."""

    @async_task_wrapper
    async def _execute():
        processed_count = 0
        failed_count = 0
        limit = 100
        try:
            query = {"validated_at": {"$exists": False}}
            # Use find_with_retry
            trips_to_process = await find_with_retry(
                trips_collection, query, limit=limit
            )

            for trip in trips_to_process:
                trip_id = str(trip.get("_id"))
                try:
                    source = trip.get("source", "unknown")
                    processor = TripProcessor(
                        mapbox_token=os.environ.get("MAPBOX_ACCESS_TOKEN", ""),
                        source=source,
                    )
                    processor.set_trip_data(trip)

                    await processor.validate()
                    status = processor.get_processing_status()
                    update_data = {
                        "validated_at": datetime.now(timezone.utc),
                        "validation_status": status["state"],
                        "invalid": status["state"] == TripState.FAILED.value,
                        "validation_message": (
                            status.get("errors", {}).get(TripState.NEW.value)
                            if status["state"] == TripState.FAILED.value
                            else None
                        ),
                    }
                    # Use update_one_with_retry
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

            logger.info(f"Validated {processed_count} trips ({failed_count} failed)")
            return {
                "status": "success",
                "validated_count": processed_count,
                "failed_count": failed_count,
                "message": f"Validated {processed_count} trips ({failed_count} failed)",
            }
        except Exception as e:
            logger.exception(f"Error during validate_trip_data task: {e}")
            raise self.retry(exc=e)

    return cast(AsyncTask, self).run_async(_execute)


# --- API Functions (Refactored to use db_manager) ---


async def get_all_task_metadata() -> Dict[str, Any]:
    """Return all task metadata with current status information from config."""
    try:
        task_config = await get_task_config()  # Use refactored helper
        task_metadata_with_status = {}

        for task_id, metadata in TASK_METADATA.items():
            task_metadata_with_status[task_id] = metadata.copy()
            config_data = task_config.get("tasks", {}).get(task_id, {})

            # Merge config data into metadata
            task_metadata_with_status[task_id].update(
                {
                    "enabled": config_data.get("enabled", True),
                    "interval_minutes": config_data.get(
                        "interval_minutes",
                        metadata.get("default_interval_minutes"),
                    ),
                    "status": config_data.get("status", TaskStatus.IDLE.value),
                    "last_run": SerializationHelper.serialize_datetime(
                        config_data.get("last_run")
                    ),
                    "next_run": SerializationHelper.serialize_datetime(
                        config_data.get("next_run")
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
                    "priority": metadata.get(
                        "priority", TaskPriority.MEDIUM
                    ).name,  # Add priority name
                }
            )
        return task_metadata_with_status
    except Exception as e:
        logger.exception(f"Error getting all task metadata: {e}")
        return TASK_METADATA  # Fallback


async def manual_run_task(task_id: str) -> Dict[str, Any]:
    """Run a task manually via Celery."""
    task_mapping = {
        "periodic_fetch_trips": periodic_fetch_trips,
        "cleanup_stale_trips": cleanup_stale_trips_task,
        "cleanup_invalid_trips": cleanup_invalid_trips,
        "update_geocoding": update_geocoding,
        "remap_unmatched_trips": remap_unmatched_trips,
        "validate_trip_data": validate_trip_data_task,
        "update_coverage_for_new_trips": update_coverage_for_new_trips,
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
            single_result = await _send_manual_task(task_name, task_mapping)
            results.append(single_result)
        # Filter results for overall status
        success = all(r.get("success", False) for r in results)
        return {
            "status": "success" if success else "partial_error",
            "message": f"Triggered {len(results)} tasks.",
            "results": results,
        }
    elif task_id in task_mapping:
        result = await _send_manual_task(task_id, task_mapping)
        return {
            "status": "success" if result.get("success") else "error",
            "message": result.get("message", f"Failed to schedule task {task_id}"),
            "task_id": result.get("task_id"),  # Celery task ID
        }
    else:
        return {"status": "error", "message": f"Unknown task: {task_id}"}


async def _send_manual_task(task_name: str, task_mapping: dict) -> Dict[str, Any]:
    """Helper to check dependencies and send a single manual task."""
    try:
        dependency_check = await check_dependencies(task_name)
        if not dependency_check["can_run"]:
            reason = dependency_check.get("reason", "Dependencies not met")
            logger.warning(f"Manual run for {task_name} skipped: {reason}")
            return {"task": task_name, "success": False, "message": reason}

        queue = f"{TASK_METADATA[task_name]['priority'].name.lower()}_priority"
        celery_task_id = f"{task_name}_manual_{uuid.uuid4()}"

        # Send task via Celery app instance
        result = celery_app.send_task(
            f"tasks.{task_name}",
            task_id=celery_task_id,
            queue=queue,
            kwargs={},
            headers={"manual_run": True},  # Pass manual run flag in headers
        )

        # Update history immediately (prerun might be slightly delayed)
        # Use the refactored history update function
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.PENDING.value,  # Mark as PENDING initially
            manual_run=True,
            start_time=datetime.now(timezone.utc),  # Approximate start
        )
        logger.info(
            f"Manually triggered task {task_name} with Celery ID {celery_task_id}"
        )
        return {
            "task": task_name,
            "success": True,
            "message": f"Task {task_name} scheduled",
            "task_id": result.id,
        }
    except Exception as e:
        logger.exception(f"Error sending manual task {task_name}")
        return {"task": task_name, "success": False, "message": str(e)}


async def update_task_schedule(
    task_config_update: Dict[str, Any],
) -> Dict[str, Any]:
    """Update the scheduling configuration for tasks using db_manager."""
    try:
        global_disable_update = task_config_update.get("globalDisable")
        tasks_update = task_config_update.get("tasks", {})
        changes = []
        update_payload = {}

        if global_disable_update is not None:
            update_payload["disabled"] = global_disable_update
            changes.append(f"Global disable set to {global_disable_update}")

        if tasks_update:
            # Fetch current config to compare against
            current_config = await get_task_config()
            current_tasks = current_config.get("tasks", {})

            for task_id, settings in tasks_update.items():
                if task_id in TASK_METADATA:
                    current_settings = current_tasks.get(task_id, {})
                    if "enabled" in settings:
                        new_val = settings["enabled"]
                        old_val = current_settings.get("enabled", True)
                        if new_val != old_val:
                            update_payload[f"tasks.{task_id}.enabled"] = new_val
                            changes.append(
                                f"Task {task_id} enabled: {old_val} -> {new_val}"
                            )
                    if "interval_minutes" in settings:
                        new_val = settings["interval_minutes"]
                        old_val = current_settings.get(
                            "interval_minutes",
                            TASK_METADATA[task_id]["default_interval_minutes"],
                        )
                        if new_val != old_val:
                            update_payload[f"tasks.{task_id}.interval_minutes"] = (
                                new_val
                            )
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

        # Use update_one_with_retry
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
            logger.warning(
                "Task configuration update requested but no document was modified."
            )
            return {
                "status": "warning",
                "message": "No changes applied to task configuration.",
            }

    except Exception as e:
        logger.exception(f"Error updating task schedule: {e}")
        return {
            "status": "error",
            "message": f"Error updating task schedule: {str(e)}",
        }
