"""
Background tasks implementation using Celery.

This module provides task definitions for all background tasks performed by the
application. It handles proper integration between Celery's synchronous tasks
and FastAPI's asynchronous code patterns.
"""

import asyncio
import os
import uuid
import threading
import time
from datetime import datetime, timedelta, timezone
from enum import Enum
from functools import wraps
from typing import Dict, Any, cast, Optional, Callable, Awaitable, TypeVar, List

# Try to import psutil for memory monitoring, but make it optional
try:
    import psutil

    HAVE_PSUTIL = True
except ImportError:
    HAVE_PSUTIL = False

from bson import ObjectId
from celery import shared_task, Task
from celery.signals import task_prerun, task_postrun, task_failure
from celery.utils.log import get_task_logger
from pymongo import UpdateOne

# Import Celery app
from celery_app import app

# Local module imports
from db import (
    DatabaseManager,
    trips_collection,
    coverage_metadata_collection,
    task_history_collection,
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

# Type variable for async function return
T = TypeVar("T")


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


# Database manager singleton for task operations
db_manager = DatabaseManager()


# Custom AsyncTask base class for better async handling
class AsyncTask(Task):
    """
    Base class for Celery tasks that need to run async code.
    Uses thread-local event loops that are kept alive between tasks.
    """

    _event_loops_lock = threading.RLock()
    _event_loops: Dict[int, asyncio.AbstractEventLoop] = {}
    _loop_owners: Dict[int, str] = {}  # track which task is using which loop

    def get_event_loop(self) -> asyncio.AbstractEventLoop:
        """
        Get an event loop for the current thread.
        Creates a new one if needed or reuses an existing one.
        """
        thread_id = threading.get_ident()

        with self._event_loops_lock:
            # Check if we already have a loop for this thread
            if thread_id in self._event_loops:
                loop = self._event_loops[thread_id]
                # Check if the loop is still usable
                if not loop.is_closed():
                    task_id = self.request.id if hasattr(self, "request") else "unknown"
                    self._loop_owners[thread_id] = task_id
                    return loop
                else:
                    # The loop is closed, remove it so we create a new one
                    logger.info(
                        f"Found closed event loop for thread {thread_id}, will create a new one"
                    )
                    del self._event_loops[thread_id]
                    if thread_id in self._loop_owners:
                        del self._loop_owners[thread_id]

            # Create a new event loop
            try:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self._event_loops[thread_id] = loop
                task_id = self.request.id if hasattr(self, "request") else "unknown"
                self._loop_owners[thread_id] = task_id
                logger.info(
                    f"Created new event loop for thread {thread_id} (task: {task_id})"
                )
                return loop
            except Exception as e:
                logger.error(f"Error creating event loop: {e}")
                raise

    def run_async(self, coro_func: Callable[[], Awaitable[T]]) -> T:
        """
        Run an async coroutine function from a Celery task.
        Accepts a function that returns a coroutine, not the coroutine itself.

        Args:
            coro_func: A function that returns a coroutine when called

        Returns:
            The result of the coroutine
        """
        # Get the event loop for the current thread
        for attempt in range(3):  # Try up to 3 times if we encounter event loop issues
            try:
                loop = self.get_event_loop()

                # Create a fresh coroutine by calling the function
                coro = coro_func()

                # Run the coroutine and get the result
                if loop.is_running():
                    # If the loop is already running (nested call), use run_coroutine_threadsafe
                    future = asyncio.run_coroutine_threadsafe(coro, loop)
                    return future.result()
                else:
                    # Otherwise, use run_until_complete
                    return loop.run_until_complete(coro)
            except RuntimeError as e:
                if (
                    "Event loop is closed" in str(e) and attempt < 2
                ):  # Don't try on last attempt
                    # The loop was closed - create a new one and retry
                    logger.warning(
                        f"Event loop was closed (attempt {attempt+1}/3), creating a new one and retrying"
                    )
                    thread_id = threading.get_ident()
                    with self._event_loops_lock:
                        if thread_id in self._event_loops:
                            del self._event_loops[thread_id]
                        if thread_id in self._loop_owners:
                            del self._loop_owners[thread_id]

                    # Sleep briefly to allow resources to be cleaned up
                    time.sleep(0.1)
                    continue  # Try again with a new loop
                else:
                    # Some other RuntimeError or we're on our last attempt, re-raise
                    logger.error(
                        f"RuntimeError in run_async (attempt {attempt+1}/3): {e}"
                    )
                    raise
            except Exception as e:
                logger.error(f"Error in run_async (attempt {attempt+1}/3): {e}")
                raise

    def __del__(self):
        """
        Cleanup when the task object is garbage collected.
        We don't close loops here to avoid the "Event loop is closed" errors.
        """
        pass


# Signal to create an event loop before a task runs
@task_prerun.connect
def task_started(task_id=None, task=None, *args, **kwargs):
    """Record when a task starts running and initialize any necessary resources."""
    if not task:
        return

    task_name = task.name.split(".")[-1] if task and task.name else "unknown"

    # Create a new event loop for this signal handler
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        # Update task history
        update_data = {
            "task_id": task_name,
            "status": TaskStatus.RUNNING.value,
            "timestamp": datetime.now(timezone.utc),
            "start_time": datetime.now(timezone.utc),
        }

        # Store task start information in MongoDB
        async def update_records():
            try:
                await task_history_collection.update_one(
                    {"_id": str(task_id)}, {"$set": update_data}, upsert=True
                )

                # Update task config status
                await update_task_config(
                    task_name,
                    {
                        "status": TaskStatus.RUNNING.value,
                        "start_time": datetime.now(timezone.utc),
                        "last_updated": datetime.now(timezone.utc),
                    },
                )
            except Exception as e:
                logger.error(f"Error updating task history: {str(e)}")

        # Run the update
        try:
            loop.run_until_complete(update_records())
        except Exception as e:
            logger.error(f"Error recording task start: {str(e)}")
        finally:
            # Close this temporary loop when done - it's not the main task loop
            try:
                loop.close()
            except Exception:
                pass

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
        # Create a temporary event loop for this signal handler
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def update_records():
            try:
                # Get task info from MongoDB
                task_info = await task_history_collection.find_one(
                    {"_id": str(task_id)}
                )

                start_time = task_info.get("start_time") if task_info else None
                runtime = None
                if start_time:
                    end_time = datetime.now(timezone.utc)
                    runtime = (
                        end_time - start_time
                    ).total_seconds() * 1000  # Convert to ms

                # Update task history
                status = (
                    TaskStatus.COMPLETED.value
                    if state == "SUCCESS"
                    else TaskStatus.FAILED.value
                )

                await task_history_collection.update_one(
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
                await update_task_config(
                    task_name,
                    {
                        "status": status,
                        "last_run": datetime.now(timezone.utc),
                        "next_run": next_run,
                        "end_time": datetime.now(timezone.utc),
                        "last_updated": datetime.now(timezone.utc),
                    },
                )
            except Exception as e:
                logger.error(f"Error updating task records: {str(e)}")

        # Run the update
        try:
            loop.run_until_complete(update_records())
        except Exception as e:
            logger.error(f"Error recording task completion: {str(e)}")
        finally:
            # Close this temporary loop
            try:
                loop.close()
            except Exception:
                pass

        logger.info(f"Task {task_name} ({task_id}) finished with status {state}")

    except Exception as e:
        logger.error(f"Error recording task completion: {str(e)}")


@task_failure.connect
def task_failed(task_id=None, task=None, exception=None, *args, **kwargs):
    """Record when a task fails."""
    if not task:
        return

    task_name = task.name.split(".")[-1] if task.name else "unknown"

    try:
        # Create a temporary event loop for this signal handler
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        error_msg = str(exception) if exception else "Unknown error"

        async def update_records():
            try:
                # Update task history with error
                await task_history_collection.update_one(
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

                # Update task config
                await update_task_config(
                    task_name,
                    {
                        "status": TaskStatus.FAILED.value,
                        "last_error": error_msg,
                        "end_time": datetime.now(timezone.utc),
                        "last_updated": datetime.now(timezone.utc),
                    },
                )
            except Exception as e:
                logger.error(f"Error updating failure records: {str(e)}")

        # Run the update
        try:
            loop.run_until_complete(update_records())
        except Exception as e:
            logger.error(f"Error recording task failure: {str(e)}")
        finally:
            # Close this temporary loop
            try:
                loop.close()
            except Exception:
                pass

        logger.error(f"Task {task_name} ({task_id}) failed: {error_msg}")

    except Exception as e:
        logger.error(f"Error recording task failure: {str(e)}")


# Task configuration helpers
async def update_task_config(task_id: str, updates: Dict[str, Any]) -> None:
    """Update the configuration for a specific task."""
    update_dict = {f"tasks.{task_id}.{k}": v for k, v in updates.items()}
    try:
        task_config = db_manager.db["task_config"]
        await task_config.update_one(
            {"_id": "global_background_task_config"}, {"$set": update_dict}, upsert=True
        )
    except Exception as e:
        logger.error(f"Error updating task config for {task_id}: {str(e)}")


async def get_task_config() -> Dict[str, Any]:
    """Get the current task configuration."""
    try:
        task_config = db_manager.db["task_config"]
        cfg = await task_config.find_one({"_id": "global_background_task_config"})

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
            await task_config.update_one(
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


async def check_dependencies(task_id: str) -> bool:
    """Check if all dependencies for a task are satisfied using DAG traversal."""
    try:
        if task_id not in TASK_METADATA:
            return True

        # Create a graph for traversal
        graph = {
            t_id: meta.get("dependencies", []) for t_id, meta in TASK_METADATA.items()
        }

        # Use depth-first search to check all dependencies
        visited = set()

        async def check_dep(dep_id: str) -> bool:
            if dep_id in visited:
                return True  # Already checked

            visited.add(dep_id)

            # Get current task status
            config = await get_task_config()
            tasks_config = config.get("tasks", {})

            if dep_id not in tasks_config:
                logger.warning(
                    f"Dependency {dep_id} for task {task_id} not found in config"
                )
                return False

            # Check if dependency is running (can't proceed)
            dep_status = tasks_config[dep_id].get("status")
            if dep_status == TaskStatus.RUNNING.value:
                logger.info(
                    f"Task {task_id} waiting for dependency {dep_id} to complete"
                )
                return False

            # Check if dependency has ever completed successfully
            dep_history = await task_history_collection.find_one(
                {"task_id": dep_id, "status": TaskStatus.COMPLETED.value},
                sort=[("timestamp", -1)],
            )

            if not dep_history:
                logger.info(
                    f"Dependency {dep_id} for task {task_id} has never completed successfully"
                )
                return False

            # Check nested dependencies
            for nested_dep in graph.get(dep_id, []):
                if not await check_dep(nested_dep):
                    return False

            return True

        # Check immediate dependencies first
        dependencies = TASK_METADATA[task_id]["dependencies"]
        for dep_id in dependencies:
            if not await check_dep(dep_id):
                return False

        return True
    except Exception as e:
        logger.error(f"Error checking dependencies for {task_id}: {str(e)}")
        return False


async def check_memory_usage() -> Dict[str, Any]:
    """
    Check system memory usage and return status information.
    """
    if not HAVE_PSUTIL:
        return {
            "status": "unknown",
            "memory_percent": 0,
            "warning": False,
            "critical": False,
        }

    try:
        # Check memory usage
        process = psutil.Process()
        memory_info = process.memory_info()
        memory_percent = process.memory_percent()

        logger.info(
            f"Memory usage: {memory_info.rss / (1024 * 1024):.2f} MB "
            f"({memory_percent:.2f}% of system memory)"
        )

        result = {
            "status": "ok",
            "memory_percent": memory_percent,
            "memory_mb": memory_info.rss / (1024 * 1024),
            "warning": memory_percent > MEMORY_WARN_THRESHOLD,
            "critical": memory_percent > MEMORY_CRITICAL_THRESHOLD,
        }

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
            result["action_taken"] = "gc_and_db_reset"

        elif memory_percent > MEMORY_WARN_THRESHOLD:
            # High memory usage
            logger.warning(
                f"High memory usage ({memory_percent:.2f}%) - "
                "proceeding with caution"
            )
            result["action_taken"] = "warning_only"

        return result
    except Exception as e:
        logger.error(f"Error checking memory usage: {str(e)}")
        return {"status": "error", "error": str(e), "warning": False, "critical": False}


# Decorator for better async task handling
def async_task_wrapper(func):
    """Decorator to handle async tasks more robustly with proper error tracking."""

    @wraps(func)
    async def wrapped_async_func(*args, **kwargs):
        task_name = func.__name__
        start_time = datetime.now(timezone.utc)

        try:
            logger.info(f"Starting async task {task_name}")
            # Add additional context for easier debugging
            memory_info = await check_memory_usage()
            logger.info(
                f"Memory usage: {memory_info.get('memory_mb', 0):.2f} MB ({memory_info.get('memory_percent', 0):.2f}% of system memory)"
            )

            result = await func(*args, **kwargs)

            # Log successful completion
            runtime = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.info(f"Completed async task {task_name} in {runtime:.2f}s")

            return result
        except Exception as e:
            # Log error details
            runtime = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.exception(
                f"Error in async task {task_name} after {runtime:.2f}s: {str(e)}"
            )

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
        # Check memory usage first
        memory_status = await check_memory_usage()

        if memory_status.get("critical", False):
            logger.warning("Memory usage is critical, deferring fetch")
            return {
                "status": "deferred",
                "message": "Memory usage critical, task deferred",
                "memory_status": memory_status,
            }

        # Last successful fetch time is saved in task config
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
            # If we have memory issues, try to recover
            if "Cannot allocate memory" in str(e):
                await db_manager.handle_memory_error()
            raise self.retry(exc=e, countdown=60)

    # Use the custom run_async method from AsyncTask
    # Pass a lambda that returns a fresh coroutine each time it's called
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
        can_proceed = await check_dependencies("preprocess_streets")
        if not can_proceed:
            return {"status": "deferred", "message": "Dependencies not satisfied"}

        memory_status = await check_memory_usage()
        if memory_status.get("critical", False):
            return {
                "status": "deferred",
                "message": "Memory usage critical, task deferred",
                "memory_status": memory_status,
            }

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

                # Check memory after each area to prevent OOM
                if processed_count % 5 == 0:
                    memory_status = await check_memory_usage()
                    if memory_status.get("critical", False):
                        logger.warning("Memory critical during preprocessing, pausing")
                        break
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

    # Use the custom run_async method from AsyncTask - pass a lambda that returns a fresh coroutine
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
        can_proceed = await check_dependencies("update_coverage_for_all_locations")
        if not can_proceed:
            return {"status": "deferred", "message": "Dependencies not satisfied"}

        # Check memory
        memory_status = await check_memory_usage()
        if memory_status.get("critical", False):
            logger.warning("Memory usage is critical, deferring coverage update")
            return {
                "status": "deferred",
                "message": "Memory usage critical, task deferred",
                "memory_status": memory_status,
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

    # Use the custom run_async method from AsyncTask - pass a lambda that returns a fresh coroutine
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
        # Check memory
        memory_status = await check_memory_usage()
        if memory_status.get("warning", False):
            logger.warning("Memory usage is high, proceeding with caution")

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

    # Use the custom run_async method from AsyncTask - pass a lambda that returns a fresh coroutine
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

            # Check memory after each batch
            if processed_count % (batch_size * 5) == 0:
                memory_status = await check_memory_usage()
                if memory_status.get("critical", False):
                    logger.warning("Memory critical during cleanup, pausing")
                    break

        if not processed_count:
            return {"status": "success", "message": "No trips to process"}

        return {
            "status": "success",
            "message": f"Processed {processed_count} trips",
            "updated_count": processed_count,
        }

    # Use the custom run_async method from AsyncTask - pass a lambda that returns a fresh coroutine
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

        # Check memory
        memory_status = await check_memory_usage()
        if memory_status.get("critical", False):
            return {
                "status": "deferred",
                "message": "Memory usage critical, task deferred",
            }

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

            # Check memory periodically
            if (geocoded_count + failed_count) % 20 == 0:
                memory_status = await check_memory_usage()
                if memory_status.get("critical", False):
                    logger.warning("Memory critical during geocoding, pausing")
                    break

        logger.info(f"Geocoded {geocoded_count} trips ({failed_count} failed)")
        return {
            "status": "success",
            "geocoded_count": geocoded_count,
            "failed_count": failed_count,
            "message": f"Geocoded {geocoded_count} trips ({failed_count} failed)",
        }

    # Use the custom run_async method from AsyncTask - pass a lambda that returns a fresh coroutine
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

        # Check memory status
        memory_status = await check_memory_usage()
        if memory_status.get("critical", False):
            return {
                "status": "deferred",
                "message": "Memory usage critical, task deferred",
            }

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

            # Check memory periodically
            if (remap_count + failed_count) % 10 == 0:
                memory_status = await check_memory_usage()
                if memory_status.get("critical", False):
                    logger.warning("Memory critical during remapping, pausing")
                    break

        logger.info(f"Remapped {remap_count} trips ({failed_count} failed)")
        return {
            "status": "success",
            "remapped_count": remap_count,
            "failed_count": failed_count,
            "message": f"Remapped {remap_count} trips ({failed_count} failed)",
        }

    # Use the custom run_async method from AsyncTask - pass a lambda that returns a fresh coroutine
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

        # Check memory status
        memory_status = await check_memory_usage()
        if memory_status.get("critical", False):
            return {
                "status": "deferred",
                "message": "Memory usage critical, task deferred",
            }

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

            # Check memory periodically
            if (processed_count + failed_count) % 25 == 0:
                memory_status = await check_memory_usage()
                if memory_status.get("critical", False):
                    logger.warning("Memory critical during validation, pausing")
                    break

        logger.info(f"Validated {processed_count} trips ({failed_count} failed)")
        return {
            "status": "success",
            "validated_count": processed_count,
            "failed_count": failed_count,
            "message": f"Validated {processed_count} trips ({failed_count} failed)",
        }

    # Use the custom run_async method from AsyncTask - pass a lambda that returns a fresh coroutine
    return cast(AsyncTask, self).run_async(lambda: _execute())


# Task execution helper
@shared_task(bind=True, base=AsyncTask, name="tasks.execute_task")
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

    @async_task_wrapper
    async def _execute():
        if task_name not in task_mapping:
            logger.error(f"Unknown task: {task_name}")
            return {"status": "error", "message": f"Unknown task: {task_name}"}

        try:
            # Check for task configuration
            config = await get_task_config()
            tasks_config = config.get("tasks", {})

            # Check if the task is enabled
            if (
                task_name in tasks_config
                and not tasks_config[task_name].get("enabled", True)
                and not is_manual
            ):
                return {"status": "skipped", "message": f"Task {task_name} is disabled"}

            # Check dependencies for non-manual runs
            if not is_manual:
                can_proceed = await check_dependencies(task_name)
                if not can_proceed:
                    return {
                        "status": "deferred",
                        "message": f"Dependencies not satisfied for {task_name}",
                    }

            # Apply task_id suffix for manual runs to track separately
            task_id = (
                f"{task_name}_{'manual' if is_manual else 'scheduled'}_{uuid.uuid4()}"
            )

            # Launch the task with appropriate queue
            task_func = task_mapping[task_name]
            priority = TASK_METADATA.get(task_name, {}).get(
                "priority", TaskPriority.MEDIUM
            )

            queue = "default"
            if priority == TaskPriority.HIGH:
                queue = "high_priority"
            elif priority == TaskPriority.LOW:
                queue = "low_priority"

            # Execute the task
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
                "message": f"Error executing task: {str(e)}",
            }

    # Use the custom run_async method - pass a lambda that returns a fresh coroutine
    return cast(AsyncTask, self).run_async(lambda: _execute())


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
            # Create a unique task ID for each execution
            task_instance_id = f"{task_name}_manual_{uuid.uuid4()}"

            # Use execute_task.apply_async to run asynchronously with the task_id
            result = execute_task.apply_async(
                args=[task_name, True], task_id=task_instance_id, queue="default"
            )

            results.append({"task": task_name, "success": True, "task_id": result.id})

        return {
            "status": "success",
            "message": f"Triggered {len(results)} tasks",
            "results": results,
        }
    else:
        # Execute single task
        task_instance_id = f"{task_id}_manual_{uuid.uuid4()}"
        result = execute_task.apply_async(
            args=[task_id, is_manual], task_id=task_instance_id, queue="default"
        )

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
        task_config_collection = db_manager.db["task_config"]
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
