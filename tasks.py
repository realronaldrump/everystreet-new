"""
Background tasks implementation using Celery.

This module provides task definitions for all background tasks performed by the
application. It handles proper integration between Celery's synchronous tasks
and FastAPI's asynchronous code patterns.
"""

import asyncio
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from enum import Enum
from functools import wraps
from typing import Any, Awaitable, Callable, Dict, TypeVar, cast

from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from celery import Task, shared_task
from celery.signals import task_failure, task_postrun, task_prerun
from celery.utils.log import get_task_logger

# Import Celery app
from celery_app import app

# Local module imports
from db import (
    DatabaseManager,
    coverage_metadata_collection,
    task_config_collection,
    task_history_collection,
    trips_collection,
)
from live_tracking import cleanup_stale_trips
from preprocess_streets import preprocess_streets as async_preprocess_streets
from pymongo import MongoClient, UpdateOne
from street_coverage_calculation import (
    compute_incremental_coverage,
    update_coverage_for_all_locations,
)
from trip_processor import TripProcessor, TripState
from utils import validate_trip_data

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
    def from_string(cls, priority_str):
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


# Database manager singleton for task operations
db_manager = DatabaseManager()


# Simplified AsyncTask base class for better async handling
class AsyncTask(Task):
    """
    Base class for Celery tasks that need to run async code.
    Creates and manages a dedicated event loop for the duration of the task.
    """

    _event_loops = {}
    _lock = threading.Lock()

    def run_async(self, coro_func: Callable[[], Awaitable[T]]) -> T:
        """
        Run an async coroutine function from a Celery task.
        Ensures the event loop stays open for the entire duration of the task.

        Args:
            coro_func: Function that returns a coroutine when called

        Returns:
            The result of the coroutine
        """
        task_id = self.request.id

        # Use a lock to prevent race conditions when creating/accessing event loops
        with self._lock:
            # Check if an event loop already exists for this task
            if (
                task_id in self._event_loops
                and not self._event_loops[task_id].is_closed()
            ):
                loop = self._event_loops[task_id]
            else:
                # Create a new event loop and store it
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self._event_loops[task_id] = loop

        try:
            # Create a fresh coroutine and run it
            coro = coro_func()
            return loop.run_until_complete(coro)
        finally:
            # Use the lock again when cleaning up
            with self._lock:
                # Only close and remove the loop when the task is completely done
                if task_id in self._event_loops:
                    try:
                        # Check if there are any pending tasks
                        if not loop.is_closed():
                            pending = asyncio.all_tasks(loop)
                            if pending:
                                # Run them to completion
                                loop.run_until_complete(asyncio.gather(*pending))
                    except Exception as e:
                        logger.warning(f"Error cleaning up pending tasks: {e}")

                    try:
                        # Close the loop and remove it from the dictionary
                        if not loop.is_closed():
                            loop.close()
                        del self._event_loops[task_id]
                    except Exception as e:
                        logger.warning(f"Error closing event loop: {e}")


# Signal to set task status before it runs
@task_prerun.connect
def task_started(task_id=None, task=None, **kwargs):
    """Record when a task starts running and update its status."""
    if not task:
        return

    task_name = task.name.split(".")[-1] if task and task.name else "unknown"

    try:
        # First, check if this task is disabled in configuration
        mongo_uri = os.getenv("MONGO_URI")
        if not mongo_uri:
            logger.error("MONGO_URI environment variable not set")
            return

        client = MongoClient(mongo_uri)
        db = client[os.getenv("MONGODB_DATABASE", "every_street")]

        # Get task configuration
        config = db.task_config_collection.find_one({})

        # Check if tasks are globally disabled or this specific task is disabled
        if config:
            globally_disabled = config.get("disabled", False)
            task_config = config.get("tasks", {}).get(task_name, {})
            task_disabled = not task_config.get("enabled", True)

            if globally_disabled or task_disabled:
                logger.info(
                    f"Task {task_name} ({task_id}) is disabled, skipping execution"
                )
                # Raise an exception to prevent task execution
                # This will be caught by Celery and the task will be marked as failed
                client.close()
                raise Exception(f"Task {task_name} is disabled in configuration")

        # Update task status using our synchronous function
        update_task_status_sync(task_name, TaskStatus.RUNNING.value)

        # Record history entry
        now = datetime.now(timezone.utc)

        # Update history
        db.task_history.update_one(
            {"_id": str(task_id)},
            {
                "$set": {
                    "task_id": task_name,
                    "status": TaskStatus.RUNNING.value,
                    "timestamp": now,
                    "start_time": now,
                    "manual_run": False,
                }
            },
            upsert=True,
        )

        logger.info(f"Task {task_name} ({task_id}) started")

        # Close MongoDB connection
        client.close()
    except Exception as e:
        logger.error(f"Error updating task start status: {e}")


@task_postrun.connect
def task_finished(task_id=None, task=None, retval=None, state=None, **kwargs):
    """Record when a task finishes running and update its status."""
    if not task:
        return

    task_name = task.name.split(".")[-1] if task and task.name else "unknown"

    try:
        # Connect to database using synchronous client
        mongo_uri = os.getenv("MONGO_URI")
        if not mongo_uri:
            logger.error("MONGO_URI environment variable not set")
            return

        now = datetime.now(timezone.utc)

        # Use PyMongo directly (synchronous client)
        client = MongoClient(mongo_uri)
        db = client[os.getenv("MONGODB_DATABASE", "every_street")]

        # Get task info to calculate runtime
        task_info = db.task_history.find_one({"_id": str(task_id)})

        # Calculate runtime if we have a start time
        start_time = task_info.get("start_time") if task_info else None
        runtime = None
        if start_time:
            # Ensure start_time has timezone info
            if start_time.tzinfo is None:
                start_time = start_time.replace(tzinfo=timezone.utc)
            runtime = (now - start_time).total_seconds() * 1000  # Convert to ms

        # Determine status
        status = (
            TaskStatus.COMPLETED.value
            if state == "SUCCESS"
            else TaskStatus.FAILED.value
        )

        # Use our synchronous function to update task status
        error_msg = None
        if status == TaskStatus.FAILED.value:
            # Extract error from retval if possible
            if isinstance(retval, dict) and "error" in retval:
                error_msg = retval["error"]
            elif isinstance(retval, Exception):
                error_msg = str(retval)
            else:
                error_msg = f"Task failed with state {state}"

            update_task_status_sync(task_name, status, error=error_msg)
        else:
            update_task_status_sync(task_name, status)

        # Update history
        db.task_history.update_one(
            {"_id": str(task_id)},
            {
                "$set": {
                    "status": status,
                    "end_time": now,
                    "runtime": runtime,
                    "result": state == "SUCCESS",
                    **(({"error": error_msg}) if error_msg else {}),
                }
            },
            upsert=True,
        )

        logger.info(f"Task {task_name} ({task_id}) finished with status {state}")

        # Close MongoDB connection
        client.close()
    except Exception as e:
        logger.error(f"Error updating task completion status: {e}")


@task_failure.connect
def task_failed(task_id=None, task=None, exception=None, **kwargs):
    """Record when a task fails with detailed error information."""
    if not task:
        return

    task_name = task.name.split(".")[-1] if task and task.name else "unknown"
    error_msg = str(exception) if exception else "Unknown error"

    try:
        # Use our synchronous function to update status
        update_task_status_sync(task_name, TaskStatus.FAILED.value, error=error_msg)

        # Connect to database using synchronous client for history
        mongo_uri = os.getenv("MONGO_URI")
        if not mongo_uri:
            logger.error("MONGO_URI environment variable not set")
            return

        now = datetime.now(timezone.utc)

        # Use PyMongo directly (synchronous client)
        client = MongoClient(mongo_uri)
        db = client[os.getenv("MONGODB_DATABASE", "every_street")]

        # Update history with error details
        db.task_history.update_one(
            {"_id": str(task_id)},
            {
                "$set": {
                    "status": TaskStatus.FAILED.value,
                    "error": error_msg,
                    "end_time": now,
                }
            },
            upsert=True,
        )

        logger.error(f"Task {task_name} ({task_id}) failed: {error_msg}")

        # Close MongoDB connection
        client.close()
    except Exception as e:
        logger.error(f"Error updating task failure status: {e}")


# Task configuration helpers
async def get_task_config() -> Dict[str, Any]:
    """Get the current task configuration."""
    try:
        cfg = await task_config_collection.find_one(
            {"_id": "global_background_task_config"}
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
            await task_config_collection.update_one(
                {"_id": "global_background_task_config"}, {"$set": cfg}, upsert=True
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


async def check_dependencies(task_id: str) -> Dict[str, Any]:
    """Check if a task's dependencies are satisfied before running it.

    Args:
        task_id: ID of the task to check

    Returns:
        Dict with 'can_run' boolean and 'reason' string if can_run is False
    """
    try:
        # Get task dependencies
        if task_id not in TASK_METADATA:
            return {"can_run": False, "reason": f"Unknown task: {task_id}"}

        dependencies = TASK_METADATA[task_id].get("dependencies", [])
        if not dependencies:
            return {"can_run": True}

        # Get current task configurations
        config = await get_task_config()
        tasks_config = config.get("tasks", {})

        # Check if any dependency is currently running or recently failed
        for dep_id in dependencies:
            if dep_id not in tasks_config:
                logger.warning(
                    f"Task {task_id} has dependency {dep_id} which is not configured"
                )
                continue

            # Check if dependency is running
            if tasks_config[dep_id].get("status") == TaskStatus.RUNNING.value:
                logger.info(
                    f"Task {task_id} waiting for dependency {dep_id} to complete"
                )
                return {
                    "can_run": False,
                    "reason": f"Dependency {dep_id} is currently running",
                }

            # Check for failed dependencies within the last hour
            if tasks_config[dep_id].get("status") == TaskStatus.FAILED.value:
                last_updated = tasks_config[dep_id].get("last_updated")
                if last_updated:
                    # If the failure was recent (< 1 hour ago), don't run dependent tasks
                    now = datetime.now(timezone.utc)
                    if isinstance(last_updated, str):
                        last_updated = datetime.fromisoformat(
                            last_updated.replace("Z", "+00:00")
                        )

                    # Add timezone if missing
                    if last_updated.tzinfo is None:
                        last_updated = last_updated.replace(tzinfo=timezone.utc)

                    if now - last_updated < timedelta(hours=1):
                        logger.warning(
                            f"Task {task_id} depends on recently failed task {dep_id}"
                        )
                        return {
                            "can_run": False,
                            "reason": f"Dependency {dep_id} recently failed (less than 1 hour ago)",
                        }

        return {"can_run": True}
    except Exception as e:
        logger.exception(f"Error checking dependencies for {task_id}: {e}")
        return {"can_run": False, "reason": f"Error checking dependencies: {str(e)}"}


def check_dependencies_sync(task_id: str) -> Dict[str, Any]:
    """Synchronous version of check_dependencies for use in signal handlers.

    Args:
        task_id: ID of the task to check

    Returns:
        Dict with 'can_run' boolean and 'reason' string if can_run is False
    """
    try:
        # Get task dependencies
        if task_id not in TASK_METADATA:
            return {"can_run": False, "reason": f"Unknown task: {task_id}"}

        dependencies = TASK_METADATA[task_id].get("dependencies", [])
        if not dependencies:
            return {"can_run": True}

        # For synchronous version, we can't check real-time status
        # Just log that we're skipping detailed checks
        if dependencies:
            logger.info(
                f"Task {task_id} has dependencies {dependencies}, but detailed checking skipped in sync context"
            )

        return {"can_run": True}
    except Exception as e:
        logger.exception(f"Error in sync dependency check for {task_id}: {e}")
        return {"can_run": False, "reason": f"Error checking dependencies: {str(e)}"}


# Synchronous versions of status update functions for signal handlers
def update_task_status_sync(task_id: str, status: str, error: str = None):
    """Synchronous version of update_task_status_async for use in signal handlers.

    Args:
        task_id: ID of the task to update
        status: New status for the task
        error: Optional error message if status is FAILED
    """
    try:
        now = datetime.now(timezone.utc)
        update_data = {
            f"tasks.{task_id}.status": status,
            f"tasks.{task_id}.last_updated": now,
        }

        if status == TaskStatus.COMPLETED.value:
            update_data[f"tasks.{task_id}.last_run"] = now

        elif status == TaskStatus.FAILED.value:
            update_data[f"tasks.{task_id}.last_error"] = error
            update_data[f"tasks.{task_id}.last_run"] = now

        elif status == TaskStatus.RUNNING.value:
            update_data[f"tasks.{task_id}.start_time"] = now

        # Use PyMongo directly (synchronous client)
        mongo_uri = os.getenv("MONGO_URI")
        if not mongo_uri:
            logger.error("MONGO_URI environment variable not set")
            return

        client = MongoClient(mongo_uri)
        db = client[os.getenv("MONGODB_DATABASE", "every_street")]

        db.task_config.update_one(
            {"_id": "global_background_task_config"}, {"$set": update_data}, upsert=True
        )

        client.close()
    except Exception as e:
        logger.exception(f"Error updating task status: {e}")


# Task status management functions
async def update_task_status_async(task_id: str, status: str, error: str = None):
    """Update the status of a task in the database.

    Args:
        task_id: ID of the task to update
        status: New status for the task
        error: Optional error message if status is FAILED
    """
    try:
        now = datetime.now(timezone.utc)
        update_data = {
            f"tasks.{task_id}.status": status,
            f"tasks.{task_id}.last_updated": now,
        }

        if status == TaskStatus.COMPLETED.value:
            update_data[f"tasks.{task_id}.last_run"] = now
            # Calculate next run based on interval
            config = await get_task_config()
            task_config = config.get("tasks", {}).get(task_id, {})
            interval_minutes = task_config.get(
                "interval_minutes",
                TASK_METADATA.get(task_id, {}).get("default_interval_minutes", 60),
            )
            next_run = now + timedelta(minutes=interval_minutes)
            update_data[f"tasks.{task_id}.next_run"] = next_run

        elif status == TaskStatus.FAILED.value:
            update_data[f"tasks.{task_id}.last_error"] = error
            update_data[f"tasks.{task_id}.last_run"] = now

        elif status == TaskStatus.RUNNING.value:
            update_data[f"tasks.{task_id}.start_time"] = now

        await task_config_collection.update_one(
            {"_id": "global_background_task_config"}, {"$set": update_data}, upsert=True
        )
    except Exception as e:
        logger.exception(f"Error updating task status: {e}")


async def update_task_history(
    task_id: str,
    status: str,
    manual_run: bool = False,
    celery_task_id: str = None,
    result: Any = None,
    error: str = None,
):
    """Add a new entry to the task history collection.

    Args:
        task_id: ID of the task
        status: Status of the task
        manual_run: Whether this was a manual run
        celery_task_id: Optional Celery task ID
        result: Optional result data
        error: Optional error message
    """
    try:
        now = datetime.now(timezone.utc)
        history_entry = {
            "task_id": task_id,
            "status": status,
            "timestamp": now,
            "manual_run": manual_run,
        }

        if celery_task_id:
            history_entry["celery_task_id"] = celery_task_id

        if status == TaskStatus.RUNNING.value:
            history_entry["start_time"] = now

        elif status == TaskStatus.COMPLETED.value:
            history_entry["end_time"] = now
            history_entry["result"] = result

        elif status == TaskStatus.FAILED.value:
            history_entry["end_time"] = now
            history_entry["error"] = error

        await task_history_collection.insert_one(history_entry)
    except Exception as e:
        logger.exception(f"Error updating task history: {e}")


# Decorator for better async task handling
def async_task_wrapper(func):
    """Decorator to handle async tasks more robustly with proper error tracking.

    This decorator wraps an async function and adds status updates and error handling.
    """

    @wraps(func)
    async def wrapped_async_func(*args, **kwargs):
        task_name = func.__name__
        start_time = datetime.now(timezone.utc)

        try:
            logger.info(f"Starting async task {task_name}")

            # Update task status to running - handle async operations safely
            try:
                await update_task_status_async(task_name, TaskStatus.RUNNING.value)
                await update_task_history(task_name, TaskStatus.RUNNING.value)
            except Exception as status_error:
                logger.error(
                    f"Error updating start status for {task_name}: {status_error}"
                )
                # Continue with task execution even if status update fails

            # Execute the task
            result = await func(*args, **kwargs)

            # Log successful completion
            runtime = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.info(f"Completed async task {task_name} in {runtime:.2f}s")

            # Update task status to completed - handle async operations safely
            try:
                await update_task_status_async(task_name, TaskStatus.COMPLETED.value)
                await update_task_history(
                    task_name, TaskStatus.COMPLETED.value, result=result
                )
            except Exception as status_error:
                logger.error(
                    f"Error updating completion status for {task_name}: {status_error}"
                )
                # Continue returning result even if status update fails

            return result
        except Exception as e:
            # Log error details
            runtime = (datetime.now(timezone.utc) - start_time).total_seconds()
            error_msg = (
                f"Error in async task {task_name} after {runtime:.2f}s: {str(e)}"
            )
            logger.exception(error_msg)

            # Update task status to failed - handle async operations safely
            try:
                await update_task_status_async(
                    task_name, TaskStatus.FAILED.value, error=str(e)
                )
                await update_task_history(
                    task_name, TaskStatus.FAILED.value, error=str(e)
                )
            except Exception as status_error:
                logger.error(
                    f"Error updating failure status for {task_name}: {status_error}"
                )
                # Continue raising the original exception

            # Re-raise to let the task framework handle the failure
            raise

    return wrapped_async_func


# Core Task Implementations
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
    """
    Fetch trips from the Bouncie API periodically.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Get last successful fetch time
        task_config = await db_manager.db["task_config"].find_one(
            {"task_id": "periodic_fetch_trips"}
        )

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
            await db_manager.db["task_config"].update_one(
                {"task_id": "periodic_fetch_trips"},
                {"$set": {"last_success_time": now_utc}},
                upsert=True,
            )

            return {"status": "success", "message": "Trips fetched successfully"}
        except Exception as e:
            error_msg = f"Error in periodic fetch: {str(e)}"
            logger.error(error_msg)
            raise self.retry(exc=e, countdown=60)

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


@shared_task(
    bind=True,
    base=AsyncTask,
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
        dependency_check = await check_dependencies("preprocess_streets")
        if not dependency_check["can_run"]:
            logger.info(f"Deferring preprocess_streets: {dependency_check['reason']}")
            return {"status": "deferred", "message": dependency_check["reason"]}

        # Find areas that need processing
        processing_areas = await coverage_metadata_collection.find(
            {"status": "processing"}
        ).to_list(
            length=20
        )  # Process in smaller batches

        processed_count = 0
        error_count = 0

        for area in processing_areas:
            try:
                await async_preprocess_streets(area["location"])
                processed_count += 1
            except Exception as e:
                error_count += 1
                logger.error(
                    f"Error preprocessing streets for {area['location'].get('display_name')}: {str(e)}"
                )
                await coverage_metadata_collection.update_one(
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

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


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
    """
    Background task that automatically updates coverage for all locations
    using the incremental algorithm (only processes new trips).
    """

    @async_task_wrapper
    async def _execute():
        logger.info("Starting automated incremental coverage updates")

        try:
            # Get all coverage areas
            coverage_areas = await coverage_metadata_collection.find({}).to_list(100)

            processed_areas = 0
            for area in coverage_areas:
                try:
                    location = area.get("location")
                    if not location:
                        continue

                    # Generate a task ID for tracking progress
                    task_id = f"auto_update_{str(area.get('_id'))}"

                    logger.info(
                        f"Processing incremental update for {location.get('display_name')}"
                    )

                    # Calculate coverage incrementally
                    result = await compute_incremental_coverage(location, task_id)

                    if result:
                        logger.info(
                            f"Updated coverage for {location.get('display_name')}: "
                            f"{result.get('coverage_percentage', 0):.2f}%"
                        )
                        processed_areas += 1
                    else:
                        logger.warning(
                            f"Failed to update coverage for {location.get('display_name')}"
                        )

                    # Sleep briefly to avoid overloading the server
                    await asyncio.sleep(1)

                except Exception as e:
                    logger.error(
                        f"Error updating coverage for {area.get('location', {}).get('display_name', 'Unknown')}: {str(e)}"
                    )
                    continue

            logger.info(
                f"Completed automated incremental updates for {processed_areas} areas"
            )
            return {"status": "success", "areas_processed": processed_areas}

        except Exception as e:
            logger.exception(f"Error in automated coverage update: {str(e)}")
            return {"status": "error", "message": str(e)}

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


@shared_task(
    bind=True,
    base=AsyncTask,
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
        dependency_check = await check_dependencies("update_coverage_for_all_locations")
        if not dependency_check["can_run"]:
            logger.info(
                f"Deferring update_coverage_for_all_locations: {dependency_check['reason']}"
            )
            return {"status": "deferred", "message": dependency_check["reason"]}

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
            # Update task status to FAILED before retrying
            await update_task_status_async(
                "update_coverage_for_all_locations",
                TaskStatus.FAILED.value,
                error=str(e),
            )
            raise self.retry(exc=e, countdown=300)

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


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
    """
    Archive trips that haven't been updated recently.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Call the actual cleanup function
        cleanup_result = await cleanup_stale_trips()

        logger.info(
            f"Cleaned up {cleanup_result.get('stale_trips_archived', 0)} stale trips"
        )
        return {
            "status": "success",
            "message": f"Cleaned up {cleanup_result.get('stale_trips_archived', 0)} stale trips",
            "details": cleanup_result,
        }

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


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
    """
    Identify and mark invalid trip records.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        update_ops = []
        processed_count = 0
        batch_size = 500  # Process in batches to avoid memory issues

        # Process trips in batches
        cursor = db_manager.db["trips"].find(
            {}, {"startTime": 1, "endTime": 1, "gps": 1}
        )
        while True:
            batch = await cursor.to_list(length=batch_size)
            if not batch:
                break

            for trip in batch:
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

            # Execute batch update
            if update_ops:
                result = await db_manager.db["trips"].bulk_write(update_ops)
                logger.info(f"Marked {result.modified_count} invalid trips in batch")
                update_ops = []  # Reset for next batch

        if not processed_count:
            return {"status": "success", "message": "No trips to process"}

        return {
            "status": "success",
            "message": f"Processed {processed_count} trips",
            "processed_count": processed_count,
        }

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


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

        trips_to_process = (
            await trips_collection.find(query).limit(limit).to_list(length=limit)
        )
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
                    f"Error geocoding trip {trip.get('transactionId')}: {str(e)}"
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

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


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
    """
    Attempt to map-match trips that previously failed.

    Returns:
        Dict with status information
    """

    @async_task_wrapper
    async def _execute():
        # Check dependencies
        can_proceed = await check_dependencies("remap_unmatched_trips")
        if not can_proceed:
            return {"status": "deferred", "message": "Dependencies not satisfied"}

        # Find trips that need map matching
        query = {"$or": [{"matchedGps": {"$exists": False}}, {"matchedGps": None}]}
        limit = 50  # Process in smaller batches due to API constraints

        trips_to_process = (
            await trips_collection.find(query).limit(limit).to_list(length=limit)
        )
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
                        f"Failed to remap trip {trip.get('transactionId')}: {status}"
                    )
            except Exception as e:
                logger.warning(
                    f"Failed to remap trip {trip.get('transactionId')}: {str(e)}"
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

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


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

        trips_to_process = (
            await trips_collection.find(query).limit(limit).to_list(length=limit)
        )
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

                await trips_collection.update_one(
                    {"_id": trip["_id"]}, {"$set": update_data}
                )

                processed_count += 1
            except Exception as e:
                logger.error(f"Error validating trip {trip.get('_id')}: {str(e)}")
                failed_count += 1

        logger.info(f"Validated {processed_count} trips ({failed_count} failed)")
        return {
            "status": "success",
            "validated_count": processed_count,
            "failed_count": failed_count,
            "message": f"Validated {processed_count} trips ({failed_count} failed)",
        }

    # Use the custom run_async method from AsyncTask
    return cast(AsyncTask, self).run_async(lambda: _execute())


# API functions for app.py to interact with Celery
async def get_all_task_metadata():
    """
    Return all task metadata for the UI with additional status information.

    Returns:
        Dict containing task metadata with current state information
    """
    try:
        # Get current task configuration first
        task_config = await get_task_config()

        # Create a copy of task metadata to avoid modifying the original
        task_metadata = {}

        for task_id, metadata in TASK_METADATA.items():
            # Start with the static metadata
            task_metadata[task_id] = metadata.copy()

            # Add runtime information from config if available
            if "tasks" in task_config and task_id in task_config["tasks"]:
                config_data = task_config["tasks"][task_id]
                task_metadata[task_id].update(
                    {
                        "enabled": config_data.get("enabled", True),
                        "interval_minutes": config_data.get(
                            "interval_minutes", metadata.get("default_interval_minutes")
                        ),
                        "status": config_data.get("status", "IDLE"),
                        "last_run": config_data.get("last_run"),
                        "next_run": config_data.get("next_run"),
                        "last_error": config_data.get("last_error"),
                    }
                )

            # Ensure all entries have consistent fields
            if "enabled" not in task_metadata[task_id]:
                task_metadata[task_id]["enabled"] = True
            if "status" not in task_metadata[task_id]:
                task_metadata[task_id]["status"] = "IDLE"

        return task_metadata

    except Exception as e:
        logger.exception(f"Error getting task metadata: {e}")
        # Return the basic metadata if there was an error
        return TASK_METADATA


async def manual_run_task(task_id: str) -> Dict[str, Any]:
    """
    Run a task manually directly from the API.

    Args:
        task_id: ID of the task to run

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

    if task_id == "ALL":
        # Get enabled tasks
        config = await get_task_config()
        enabled_tasks = []
        for task_name, task_config in config.get("tasks", {}).items():
            if task_config.get("enabled", True) and task_name in task_mapping:
                enabled_tasks.append(task_name)

        # Execute all enabled tasks
        results = []
        for task_name in enabled_tasks:
            try:
                # Check dependencies before running
                dependency_check = await check_dependencies(task_name)
                if not dependency_check["can_run"]:
                    results.append(
                        {
                            "task": task_name,
                            "success": False,
                            "error": dependency_check["reason"],
                        }
                    )
                    continue

                # Create a unique task ID for each execution
                task_instance_id = f"{task_name}_manual_{uuid.uuid4()}"

                # Apply the task asynchronously
                result = task_mapping[task_name].apply_async(task_id=task_instance_id)

                # Record that the task was started manually
                await update_task_history(
                    task_name,
                    TaskStatus.RUNNING.value,
                    manual_run=True,
                    celery_task_id=result.id,
                )

                results.append(
                    {"task": task_name, "success": True, "task_id": result.id}
                )
            except Exception as e:
                logger.exception(f"Error starting task {task_name}")
                results.append({"task": task_name, "success": False, "error": str(e)})

        return {
            "status": "success",
            "message": f"Triggered {len(results)} tasks",
            "results": results,
        }
    elif task_id in task_mapping:
        # Execute single task
        try:
            # Check dependencies before running
            dependency_check = await check_dependencies(task_id)
            if not dependency_check["can_run"]:
                return {
                    "status": "error",
                    "message": dependency_check["reason"],
                }

            task_instance_id = f"{task_id}_manual_{uuid.uuid4()}"
            result = task_mapping[task_id].apply_async(task_id=task_instance_id)

            # Record that the task was started manually
            await update_task_history(
                task_id,
                TaskStatus.RUNNING.value,
                manual_run=True,
                celery_task_id=result.id,
            )

            return {
                "status": "success",
                "message": f"Task {task_id} scheduled for execution",
                "task_id": result.id,
            }
        except Exception as e:
            logger.exception(f"Error starting task {task_id}")
            return {
                "status": "error",
                "message": f"Failed to schedule task {task_id}: {str(e)}",
            }
    else:
        return {"status": "error", "message": f"Unknown task: {task_id}"}


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

        # Log changes for debugging
        changes = []

        # Update task configurations
        for task_id, task_settings in tasks_config.items():
            if task_id in TASK_METADATA:
                if task_id not in current_config["tasks"]:
                    current_config["tasks"][task_id] = {}
                    changes.append(f"Added new task configuration for {task_id}")

                if "enabled" in task_settings:
                    old_value = current_config["tasks"][task_id].get("enabled", True)
                    new_value = task_settings["enabled"]
                    if old_value != new_value:
                        changes.append(
                            f"Changed {task_id} enabled: {old_value} -> {new_value}"
                        )
                    current_config["tasks"][task_id]["enabled"] = new_value

                if "interval_minutes" in task_settings:
                    old_value = current_config["tasks"][task_id].get(
                        "interval_minutes",
                        TASK_METADATA[task_id]["default_interval_minutes"],
                    )
                    new_value = task_settings["interval_minutes"]
                    if old_value != new_value:
                        changes.append(
                            f"Changed {task_id} interval: {old_value} -> {new_value} minutes"
                        )
                    current_config["tasks"][task_id]["interval_minutes"] = new_value

        # Save updated config
        await task_config_collection.update_one(
            {"_id": "global_background_task_config"},
            {"$set": current_config},
            upsert=True,
        )

        # Log the changes
        if changes:
            logger.info(f"Task configuration updated: {', '.join(changes)}")
        else:
            logger.info("Task configuration updated (no changes detected)")

        return {
            "status": "success",
            "message": "Task configuration updated successfully",
            "changes": changes,
        }
    except Exception as e:
        logger.error(f"Error updating task schedule: {str(e)}")
        return {"status": "error", "message": f"Error updating task schedule: {str(e)}"}
