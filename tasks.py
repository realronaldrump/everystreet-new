# tasks.py
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
from pymongo.errors import BulkWriteError

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
    update_one_with_retry,  # Added import
)
from live_tracking import cleanup_stale_trips as cleanup_stale_trips_logic
from street_coverage_calculation import compute_incremental_coverage
from trip_processor import TripProcessor, TripState
from utils import (
    run_async_from_sync,
    validate_trip_data as validate_trip_data_logic,
)  # Import the new helper

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
        """
        Updates the status of a specific task in the global task configuration document.

        Args:
            task_id: The identifier of the task (e.g., 'periodic_fetch_trips').
            status: The new status string (should match TaskStatus enum values).
            error: An optional error message if the status is FAILED.

        Returns:
            True if the update was successful (document modified or upserted), False otherwise.
        """
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
            # Handle PENDING state - set start_time, clear end_time and error
            elif status == TaskStatus.PENDING.value:
                update_data[f"tasks.{task_id}.start_time"] = (
                    now  # Mark when it was queued
                )
                update_data[f"tasks.{task_id}.end_time"] = None
                update_data[f"tasks.{task_id}.last_error"] = None
            # Handle IDLE state - clear start/end times and error
            elif status == TaskStatus.IDLE.value:
                update_data[f"tasks.{task_id}.start_time"] = None
                update_data[f"tasks.{task_id}.end_time"] = None
                update_data[f"tasks.{task_id}.last_error"] = None

            # Use the retry wrapper for the database update
            result = await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": update_data},
                upsert=True,  # Create the config document if it doesn't exist
            )
            # Check if the operation resulted in modification or insertion
            return result.modified_count > 0 or result.upserted_id is not None

        except Exception as e:
            logger.exception(f"Error updating task status for {task_id}: {e}")
            return False


# ------------------------------------------------------------------------------
# Helper Functions (async)
# ------------------------------------------------------------------------------


async def get_task_config() -> Dict[str, Any]:
    """
    Retrieves the global task configuration document from the database.
    If the document doesn't exist, it creates a default configuration based
    on TASK_METADATA. It also ensures that all tasks defined in TASK_METADATA
    have a corresponding entry in the configuration.

    Returns:
        The task configuration dictionary. Returns a default structure on error.
    """
    try:
        # Use the retry wrapper to fetch the configuration
        cfg = await find_one_with_retry(
            task_config_collection, {"_id": "global_background_task_config"}
        )

        # If no config exists, create the default one
        if not cfg:
            logger.info("No task config found, creating default.")
            cfg = {
                "_id": "global_background_task_config",
                "disabled": False,  # Global flag to disable all tasks
                "tasks": {
                    t_id: {
                        "enabled": True,  # Individual task enable/disable flag
                        "interval_minutes": t_def["default_interval_minutes"],
                        "status": TaskStatus.IDLE.value,
                        "last_run": None,
                        "next_run": None,  # Note: next_run is calculated dynamically by scheduler
                        "last_error": None,
                        "start_time": None,  # Timestamp when the task started running
                        "end_time": None,  # Timestamp when the task finished (completed or failed)
                        "last_updated": None,  # Timestamp of the last status update for this task
                        "last_success_time": None,  # Timestamp of the last successful completion
                    }
                    for t_id, t_def in TASK_METADATA.items()
                },
            }
            # Use retry wrapper to insert the default config
            await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": cfg},
                upsert=True,
            )
        else:
            # Ensure all known tasks exist in the config, add if missing
            updated = False
            if "tasks" not in cfg:
                cfg["tasks"] = {}
                updated = True  # Need to update if 'tasks' key was missing

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
                        "last_success_time": None,
                    }
                    updated = True  # Need to update if a task was added

            # If any tasks were added, update the document in the database
            if updated:
                await update_one_with_retry(
                    task_config_collection,
                    {"_id": "global_background_task_config"},
                    {"$set": {"tasks": cfg["tasks"]}},
                )
        return cfg
    except Exception as e:
        # Log the error and return a safe default structure
        logger.exception(f"Error getting task config: {str(e)}")
        return {
            "_id": "global_background_task_config",
            "disabled": False,
            "tasks": {},
        }


async def check_dependencies(task_id: str) -> Dict[str, Any]:
    """
    Checks if the dependencies for a given task are met (i.e., not currently running or recently failed).

    Args:
        task_id: The identifier of the task to check dependencies for.

    Returns:
        A dictionary containing:
            'can_run': Boolean indicating if the task can run based on dependencies.
            'reason': String explaining why the task cannot run (if applicable).
    """
    try:
        # Check if the task_id is valid
        if task_id not in TASK_METADATA:
            return {"can_run": False, "reason": f"Unknown task: {task_id}"}

        # Get the list of dependencies for this task
        dependencies = TASK_METADATA[task_id].get("dependencies", [])
        if not dependencies:
            return {"can_run": True}  # No dependencies, can run

        # Fetch the current task configuration
        config = await get_task_config()
        tasks_config = config.get("tasks", {})

        # Check the status of each dependency
        for dep_id in dependencies:
            if dep_id not in tasks_config:
                # Log a warning if a dependency isn't found in the config
                logger.warning(
                    f"Task {task_id} dependency {dep_id} not found in configuration."
                )
                # Depending on policy, you might want to prevent running or allow it.
                # Let's assume for now that a missing dependency config doesn't block.
                continue

            dep_status = tasks_config[dep_id].get("status")

            # If a dependency is currently running or pending, the task cannot run
            if dep_status in [
                TaskStatus.RUNNING.value,
                TaskStatus.PENDING.value,
            ]:
                return {
                    "can_run": False,
                    "reason": f"Dependency '{dep_id}' is currently {dep_status}",
                }

            # If a dependency failed recently (e.g., within the last hour), the task cannot run
            if dep_status == TaskStatus.FAILED.value:
                last_updated_any = tasks_config[dep_id].get("last_updated")
                last_updated = None
                if isinstance(last_updated_any, datetime):
                    last_updated = last_updated_any
                elif isinstance(last_updated_any, str):
                    try:
                        # Handle ISO format, ensuring timezone awareness
                        last_updated = datetime.fromisoformat(
                            last_updated_any.replace("Z", "+00:00")
                        )
                    except ValueError:
                        pass  # Ignore invalid date strings

                # Ensure timezone awareness (assume UTC if naive)
                if last_updated and last_updated.tzinfo is None:
                    last_updated = last_updated.replace(tzinfo=timezone.utc)

                # Check if the failure was recent (e.g., within the last hour)
                if last_updated and (
                    datetime.now(timezone.utc) - last_updated
                    < timedelta(hours=1)  # Configurable threshold?
                ):
                    return {
                        "can_run": False,
                        "reason": f"Dependency '{dep_id}' failed recently",
                    }

        # If all dependencies are met
        return {"can_run": True}

    except Exception as e:
        # Log the error and prevent the task from running as a safety measure
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
    """
    Creates or updates an entry in the task history collection.

    Args:
        celery_task_id: The unique ID assigned by Celery to this task instance.
        task_name: The application-specific name of the task (e.g., 'periodic_fetch_trips').
        status: The current status of the task instance (e.g., 'RUNNING', 'COMPLETED', 'FAILED').
        manual_run: Boolean indicating if the task was triggered manually.
        result: The result of the task (if completed successfully). Will be serialized.
        error: Error message if the task failed.
        start_time: Timestamp when the task started execution.
        end_time: Timestamp when the task finished execution.
        runtime_ms: Duration of the task execution in milliseconds.
    """
    try:
        now = datetime.now(timezone.utc)
        update_fields = {
            "task_id": task_name,  # Application-defined task name
            "status": status,
            "timestamp": now,  # Timestamp of this history update
            "manual_run": manual_run,
        }
        # Add optional fields if they are provided
        if start_time:
            update_fields["start_time"] = start_time
        if end_time:
            update_fields["end_time"] = end_time
        if runtime_ms is not None:
            # Ensure runtime is stored as a float or int
            try:
                update_fields["runtime"] = float(runtime_ms)
            except (ValueError, TypeError):
                logger.warning(
                    f"Could not convert runtime {runtime_ms} to float for {celery_task_id}"
                )
                update_fields["runtime"] = (
                    None  # Store as None if conversion fails
                )

        if result is not None:
            try:
                # Use the robust serialization helper
                serialized_result = SerializationHelper.serialize_document(
                    {"result": result}
                )["result"]
                update_fields["result"] = serialized_result
            except Exception as ser_err:
                logger.warning(
                    f"Could not serialize result for {task_name} ({celery_task_id}) history: {ser_err}"
                )
                # Store a placeholder if serialization fails
                update_fields["result"] = (
                    f"<Unserializable Result: {type(result).__name__}>"
                )
        if error is not None:
            # Store error message as string
            update_fields["error"] = str(error)

        # Use the retry wrapper for the database update operation
        # Upsert ensures that if an entry for this celery_task_id doesn't exist, it's created.
        # If it exists, the fields are updated.
        await update_one_with_retry(
            task_history_collection,
            {
                "_id": celery_task_id
            },  # Use Celery's unique task instance ID as the document ID
            {"$set": update_fields},
            upsert=True,
        )
    except Exception as e:
        # Log any errors during history update but don't let it fail the main task
        logger.exception(
            f"Error updating task history for {celery_task_id} ({task_name}): {e}"
        )


# ------------------------------------------------------------------------------
# Task Implementations
# ------------------------------------------------------------------------------

# 1. PERIODIC FETCH TRIPS


async def periodic_fetch_trips_async(self) -> Dict[str, Any]:
    """Async logic for fetching periodic trips."""
    task_name = "periodic_fetch_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    try:
        # Update status to RUNNING immediately
        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")

        # --- Task Logic ---
        # Fetch the task config to determine the start time for fetching trips.
        task_config_doc = await get_task_config()  # Use helper to get config
        last_success_time = None
        if (
            task_config_doc
            and "tasks" in task_config_doc
            and task_name in task_config_doc["tasks"]
        ):
            # Get the timestamp of the last successful run for *this specific task*
            last_success_time = task_config_doc["tasks"][task_name].get(
                "last_success_time"
            )

        now_utc = datetime.now(timezone.utc)
        start_date_fetch = None

        # Determine the start time for the Bouncie API call
        if last_success_time:
            # If we have a last success time, use it as the start
            start_date_fetch = last_success_time
            # Ensure it's a datetime object and timezone-aware
            if isinstance(start_date_fetch, str):
                try:
                    start_date_fetch = datetime.fromisoformat(
                        start_date_fetch.replace("Z", "+00:00")
                    )
                except ValueError:
                    logger.warning(
                        f"Could not parse last_success_time '{last_success_time}', falling back."
                    )
                    start_date_fetch = None  # Fallback if parsing fails
            if start_date_fetch and start_date_fetch.tzinfo is None:
                start_date_fetch = start_date_fetch.replace(
                    tzinfo=timezone.utc
                )
        else:
            # If no last success time, find the end time of the most recent Bouncie trip in DB
            last_bouncie_trip = await find_one_with_retry(
                trips_collection, {"source": "bouncie"}, sort=[("endTime", -1)]
            )
            if last_bouncie_trip and "endTime" in last_bouncie_trip:
                start_date_fetch = last_bouncie_trip["endTime"]
                # Ensure timezone awareness
                if start_date_fetch and start_date_fetch.tzinfo is None:
                    start_date_fetch = start_date_fetch.replace(
                        tzinfo=timezone.utc
                    )

        # If still no start date, default to fetching the last few hours
        if not start_date_fetch:
            start_date_fetch = now_utc - timedelta(
                hours=3
            )  # Default fetch window

        # Don't fetch data older than a certain limit (e.g., 24 hours) to avoid excessive calls
        min_start_date = now_utc - timedelta(hours=24)
        start_date_fetch = max(start_date_fetch, min_start_date)

        logger.info(
            f"Task {task_name}: Fetching Bouncie trips from {start_date_fetch.isoformat()} to {now_utc.isoformat()}"
        )

        # Call the Bouncie fetcher function (ensure it uses async DB operations)
        fetched_trips = await fetch_bouncie_trips_in_range(
            start_date_fetch,
            now_utc,
            do_map_match=True,  # Perform map matching during fetch
        )

        # Update the last successful run time in the config
        await update_one_with_retry(
            task_config_collection,
            {"_id": "global_background_task_config"},
            {"$set": {f"tasks.{task_name}.last_success_time": now_utc}},
            upsert=True,  # Ensure config exists
        )

        # --- Completion ---
        result_data = {
            "status": "success",
            "message": f"Fetched {len(fetched_trips)} trips successfully",
            "trips_fetched": len(fetched_trips),
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
        # Update status to FAILED
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(e)
        )
        # Update history with failure details
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(e),
            end_time=end_time,
            runtime_ms=runtime,
        )
        # Use Celery's retry mechanism
        try:
            # This tells Celery to retry the task after a countdown
            # The exception 'e' is passed to the next retry attempt
            raise self.retry(exc=e, countdown=60)  # Retry after 60 seconds
        except Exception:
            # If self.retry itself fails or max retries are exceeded, re-raise the original exception
            # This ensures Celery marks the task as failed if retries don't succeed.
            raise e


# Celery task definition (synchronous wrapper)
@shared_task(
    bind=True,
    max_retries=3,  # Max number of retries
    default_retry_delay=60,  # Delay between retries in seconds
    time_limit=3600,  # Hard time limit for the task (1 hour)
    soft_time_limit=3300,  # Soft time limit (55 minutes)
    name="tasks.periodic_fetch_trips",
    queue="high_priority",  # Route to the high priority queue
)
def periodic_fetch_trips(self):
    """Celery task wrapper for fetching periodic trips."""
    # Use the helper to run the async function from the sync task
    return run_async_from_sync(periodic_fetch_trips_async(self))


# 2. UPDATE COVERAGE FOR NEW TRIPS


async def update_coverage_for_new_trips_async(self) -> Dict[str, Any]:
    """Async logic for updating coverage incrementally."""
    task_name = "update_coverage_for_new_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    processed_areas = 0
    failed_areas = 0
    skipped_areas = 0
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

        # --- Task Logic ---
        # Retrieve all defined coverage areas
        coverage_areas = await find_with_retry(
            coverage_metadata_collection, {}
        )
        logger.info(
            f"Found {len(coverage_areas)} coverage areas to check for incremental updates."
        )

        for area in coverage_areas:
            location = area.get("location")
            area_id_str = str(area.get("_id"))
            display_name = (
                location.get("display_name", "Unknown")
                if location
                else f"Unknown (ID: {area_id_str})"
            )

            if not location:
                logger.warning(
                    f"Skipping area {area_id_str} due to missing location data."
                )
                skipped_areas += 1
                continue

            # Use a unique ID for the sub-task progress tracking within the coverage module
            sub_task_id = f"incr_update_{area_id_str}_{uuid.uuid4()}"
            logger.info(
                f"Processing incremental update for '{display_name}' (SubTask: {sub_task_id})"
            )

            try:
                # Call the incremental coverage calculation function
                # This function handles its own progress updates via the sub_task_id
                # and returns stats on success or None on failure.
                result = await compute_incremental_coverage(
                    location, sub_task_id
                )

                if result:
                    logger.info(
                        f"Successfully updated coverage for '{display_name}'. New coverage: {result.get('coverage_percentage', 0):.2f}%"
                    )
                    processed_areas += 1
                else:
                    # compute_incremental_coverage should log the specific error
                    logger.warning(
                        f"Incremental update failed or returned no result for '{display_name}' (SubTask: {sub_task_id}). Check previous logs."
                    )
                    failed_areas += 1

                # Optional short delay between processing areas
                await asyncio.sleep(0.5)

            except Exception as inner_e:
                # Catch errors specifically from the call to compute_incremental_coverage
                logger.error(
                    f"Error during incremental update for '{display_name}': {inner_e}",
                    exc_info=True,
                )
                failed_areas += 1
                # Attempt to update the progress status for the sub-task to error
                try:
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
                except Exception as prog_err:
                    logger.error(
                        f"Failed to update progress status for failed sub-task {sub_task_id}: {prog_err}"
                    )
                continue  # Continue to the next area

        logger.info(
            f"Completed automated incremental updates. Processed: {processed_areas}, Failed: {failed_areas}, Skipped: {skipped_areas}"
        )

        # --- Completion ---
        result_data = {
            "status": "success",
            "areas_processed": processed_areas,
            "areas_failed": failed_areas,
            "areas_skipped": skipped_areas,
            "message": f"Completed incremental updates. Processed: {processed_areas}, Failed: {failed_areas}, Skipped: {skipped_areas}",
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
            # Use Celery's retry mechanism
            raise self.retry(exc=e, countdown=300)  # Retry after 5 minutes
        except Exception:
            raise e


# Celery task definition (synchronous wrapper)
@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,  # 5 minutes retry delay
    time_limit=7200,  # 2 hours hard limit (might need adjustment based on number of areas)
    soft_time_limit=7000,  # Slightly less than hard limit
    name="tasks.update_coverage_for_new_trips",
    queue="default",  # Use default queue, or consider a dedicated coverage queue
)
def update_coverage_for_new_trips(self):
    """Celery task wrapper for updating coverage incrementally."""
    return run_async_from_sync(update_coverage_for_new_trips_async(self))


# 3. CLEANUP STALE TRIPS


async def cleanup_stale_trips_async(self) -> Dict[str, Any]:
    """Async logic for cleaning up stale live tracking trips."""
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

        # --- Task Logic ---
        # Execute cleanup logic from live_tracking module
        cleanup_result = (
            await cleanup_stale_trips_logic()
        )  # This function now returns a dict
        stale_archived_count = cleanup_result.get("stale_trips_archived", 0)
        old_removed_count = cleanup_result.get("old_archives_removed", 0)
        logger.info(
            f"Cleaned up {stale_archived_count} stale live trips and removed {old_removed_count} old archived trips."
        )

        # --- Completion ---
        result_data = {
            "status": "success",
            "message": f"Cleaned up {stale_archived_count} stale trips, removed {old_removed_count} old archives.",
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
            # Use Celery's retry mechanism
            raise self.retry(exc=e, countdown=60)  # Retry after 1 minute
        except Exception:
            raise e


# Celery task definition (synchronous wrapper)
@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    time_limit=1800,  # 30 minutes hard limit
    soft_time_limit=1700,  # 28 minutes soft limit
    name="tasks.cleanup_stale_trips",
    queue="low_priority",  # Run on low priority queue
)
def cleanup_stale_trips(self):
    """Celery task wrapper for cleaning up stale live trips."""
    return run_async_from_sync(cleanup_stale_trips_async(self))


# 4. CLEANUP INVALID TRIPS


async def cleanup_invalid_trips_async(self) -> Dict[str, Any]:
    """Async logic for identifying and marking invalid trip records."""
    task_name = "cleanup_invalid_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    processed_count = 0
    modified_count = 0
    batch_size = 500  # Process trips in batches
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

        # --- Task Logic ---
        # Query for trips that haven't been validated or are marked as potentially invalid
        # Adjust query as needed based on how 'invalid' status is tracked
        query = {
            "invalid": {"$ne": True}
        }  # Example: process trips not already marked invalid

        total_docs_to_process = await trips_collection.count_documents(query)
        logger.info(f"Found {total_docs_to_process} trips to validate.")

        if total_docs_to_process == 0:
            result_data = {
                "status": "success",
                "message": "No trips found requiring validation.",
                "processed_count": 0,
                "modified_count": 0,
            }
        else:
            # Process trips in batches using a cursor
            cursor = trips_collection.find(
                query,
                {
                    "startTime": 1,
                    "endTime": 1,
                    "gps": 1,
                    "_id": 1,
                },  # Only fetch necessary fields
            ).batch_size(batch_size)

            batch_updates = []
            async for trip in cursor:
                processed_count += 1
                # Use the validation logic from utils.py
                valid, message = validate_trip_data_logic(trip)

                if not valid:
                    # If invalid, prepare an update operation to mark it
                    batch_updates.append(
                        UpdateOne(
                            {"_id": trip["_id"]},
                            {
                                "$set": {
                                    "invalid": True,
                                    "validation_message": message
                                    or "Invalid data detected",
                                    "validated_at": datetime.now(
                                        timezone.utc
                                    ),  # Timestamp validation
                                }
                            },
                        )
                    )
                    modified_count += (
                        1  # Increment potential modification count
                    )

                # Execute batch write when the batch is full or at the end
                if len(batch_updates) >= batch_size:
                    if batch_updates:
                        try:
                            # Use the retry wrapper for bulk write
                            result = await trips_collection.bulk_write(
                                batch_updates, ordered=False
                            )
                            logger.info(
                                f"Executed validation batch: Matched={result.matched_count}, Modified={result.modified_count}"
                            )
                        except BulkWriteError as bwe:
                            logger.error(
                                f"Bulk write error during validation: {bwe.details}"
                            )
                            # Handle potential errors, e.g., log details
                        except Exception as bulk_err:
                            logger.error(
                                f"Error executing validation batch: {bulk_err}"
                            )
                    batch_updates = []  # Reset batch
                    logger.info(
                        f"Processed {processed_count}/{total_docs_to_process} trips for validation."
                    )
                    await asyncio.sleep(0.1)  # Small delay to yield control

            # Process any remaining updates in the last batch
            if batch_updates:
                try:
                    result = await trips_collection.bulk_write(
                        batch_updates, ordered=False
                    )
                    logger.info(
                        f"Executed final validation batch: Matched={result.matched_count}, Modified={result.modified_count}"
                    )
                except BulkWriteError as bwe:
                    logger.error(
                        f"Bulk write error during final validation batch: {bwe.details}"
                    )
                except Exception as bulk_err:
                    logger.error(
                        f"Error executing final validation batch: {bulk_err}"
                    )

            result_data = {
                "status": "success",
                "message": f"Processed {processed_count} trips, marked {modified_count} as potentially invalid",
                "processed_count": processed_count,
                "modified_count": modified_count,
            }

        # --- Completion ---
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
            # Use Celery's retry mechanism
            raise self.retry(exc=e, countdown=300)  # Retry after 5 minutes
        except Exception:
            raise e


# Celery task definition (synchronous wrapper)
@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,  # 2 hours hard limit
    soft_time_limit=7000,  # Slightly less
    name="tasks.cleanup_invalid_trips",
    queue="low_priority",  # Run on low priority queue
)
def cleanup_invalid_trips(self):
    """Celery task wrapper for cleaning up invalid trip data."""
    return run_async_from_sync(cleanup_invalid_trips_async(self))


# 5. UPDATE GEOCODING


async def update_geocoding_async(self) -> Dict[str, Any]:
    """Async logic for updating geocoding for trips missing location data."""
    task_name = "update_geocoding"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    geocoded_count = 0
    failed_count = 0
    limit = 100  # Process a limited number of trips per run to avoid API rate limits/costs
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

        # --- Task Logic ---
        # Query for trips missing start or destination location data
        # Uses structured location fields introduced in TripProcessor
        query = {
            "$or": [
                {"startLocation": {"$exists": False}},
                {"destination": {"$exists": False}},
                {
                    "startLocation.formatted_address": ""
                },  # Check for empty formatted address
                {"destination.formatted_address": ""},
                # Optionally add checks for missing coordinates if needed
                # {"startLocation.coordinates.lat": 0.0, "startLocation.coordinates.lng": 0.0},
                # {"destination.coordinates.lat": 0.0, "destination.coordinates.lng": 0.0}
            ],
            # Optionally exclude trips already marked as failed geocoding?
            # "geocoding_status": {"$ne": "failed"}
        }

        # Find trips needing geocoding, limit the number processed per run
        trips_to_process = await find_with_retry(
            trips_collection, query, limit=limit
        )
        logger.info(
            f"Found {len(trips_to_process)} trips needing geocoding (limit {limit})."
        )

        # Get Mapbox token (needed by TripProcessor for geocoding)
        mapbox_token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
        if not mapbox_token:
            logger.warning(
                "MAPBOX_ACCESS_TOKEN not set, cannot perform geocoding."
            )
            # Fail the task if token is missing
            raise ValueError("MAPBOX_ACCESS_TOKEN is not configured.")

        # Process each trip
        for trip in trips_to_process:
            trip_id = trip.get("transactionId", str(trip.get("_id")))
            logger.debug(f"Attempting to geocode trip {trip_id}")
            try:
                # Determine the source from the trip data itself
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=mapbox_token, source=source
                )
                processor.set_trip_data(trip)

                # Run validation and basic processing first
                await processor.validate()
                if processor.state == TripState.VALIDATED:
                    await processor.process_basic()

                # Attempt geocoding if basic processing succeeded
                if processor.state == TripState.PROCESSED:
                    await (
                        processor.geocode()
                    )  # This method now handles the logic

                    # Check if geocoding was successful
                    if processor.state == TripState.GEOCODED:
                        # Save the updated trip data (including geocoding results)
                        save_result = await processor.save()
                        if save_result:
                            geocoded_count += 1
                            logger.debug(
                                f"Successfully geocoded and saved trip {trip_id}"
                            )
                        else:
                            failed_count += 1
                            logger.warning(
                                f"Geocoding succeeded for trip {trip_id}, but save failed."
                            )
                    else:
                        # Geocoding step failed
                        failed_count += 1
                        status_info = processor.get_processing_status()
                        logger.warning(
                            f"Geocoding failed for trip {trip_id}. State: {processor.state.value}, Errors: {status_info.get('errors')}"
                        )
                        # Optionally mark the trip as failed geocoding in DB?
                        # await update_one_with_retry(trips_collection, {"_id": trip["_id"]}, {"$set": {"geocoding_status": "failed"}})
                else:
                    # Validation or basic processing failed
                    failed_count += 1
                    status_info = processor.get_processing_status()
                    logger.warning(
                        f"Skipping geocoding for trip {trip_id} due to prior processing failure. State: {processor.state.value}, Errors: {status_info.get('errors')}"
                    )

            except Exception as e:
                # Catch unexpected errors during processing of a single trip
                logger.error(
                    f"Unexpected error geocoding trip {trip_id}: {e}",
                    exc_info=False,
                )
                failed_count += 1
            # Add a small delay to avoid overwhelming external geocoding APIs
            await asyncio.sleep(0.2)  # Adjust delay as needed

        logger.info(
            f"Geocoding attempt finished. Succeeded: {geocoded_count}, Failed: {failed_count}"
        )

        # --- Completion ---
        result_data = {
            "status": "success",
            "geocoded_count": geocoded_count,
            "failed_count": failed_count,
            "message": f"Attempted geocoding for {len(trips_to_process)} trips. Succeeded: {geocoded_count}, Failed: {failed_count}",
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
            # Use Celery's retry mechanism
            raise self.retry(exc=e, countdown=300)  # Retry after 5 minutes
        except Exception:
            raise e


# Celery task definition (synchronous wrapper)
@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,  # 2 hours hard limit (geocoding can be slow)
    soft_time_limit=7000,
    name="tasks.update_geocoding",
    queue="default",  # Or 'low_priority' if preferred
)
def update_geocoding(self):
    """Celery task wrapper for updating trip geocoding."""
    return run_async_from_sync(update_geocoding_async(self))


# 6. REMAP UNMATCHED TRIPS


async def remap_unmatched_trips_async(self) -> Dict[str, Any]:
    """Async logic for attempting to map-match trips that previously failed or were not matched."""
    task_name = "remap_unmatched_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    remap_count = 0
    failed_count = 0
    limit = 50  # Limit the number of trips processed per run to avoid long task duration
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

        # --- Dependency Check ---
        dependency_check = await check_dependencies(task_name)
        if not dependency_check["can_run"]:
            reason = dependency_check.get("reason", "Unknown reason")
            logger.info(f"Deferring {task_name}: {reason}")
            result_data = {"status": "deferred", "message": reason}
            # Mark as completed (deferred is a form of completion for this run)
            await status_manager.update_status(
                task_name, TaskStatus.COMPLETED.value
            )
            await update_task_history_entry(
                celery_task_id=celery_task_id,
                task_name=task_name,
                status=TaskStatus.COMPLETED.value,  # Mark deferred runs as completed in history
                result=result_data,
                end_time=datetime.now(timezone.utc),
                runtime_ms=0,
            )
            return result_data

        # --- Task Logic ---
        # Fetch IDs of trips already present in the matched_trips collection
        matched_ids_cursor = matched_trips_collection.find(
            {},
            {"transactionId": 1},  # Only fetch the transactionId field
        )
        # Collect matched IDs into a set for efficient lookup
        matched_ids = {
            doc["transactionId"]
            async for doc in matched_ids_cursor
            if "transactionId" in doc
        }
        logger.info(f"Found {len(matched_ids)} already matched trip IDs.")

        # Query for trips in the main 'trips' collection that are NOT in the matched set
        # Also, optionally filter for trips that previously failed map matching if tracked
        query = {
            "transactionId": {"$nin": list(matched_ids)},
            # Optionally add: "map_match_status": {"$ne": "success"} if you track status
        }

        # Find trips to process, applying the limit
        trips_to_process = await find_with_retry(
            trips_collection, query, limit=limit
        )
        logger.info(
            f"Found {len(trips_to_process)} trips to attempt remapping (limit {limit})."
        )

        # Get Mapbox token
        mapbox_token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
        if not mapbox_token:
            logger.warning(
                "MAPBOX_ACCESS_TOKEN not set, cannot perform map matching."
            )
            raise ValueError("MAPBOX_ACCESS_TOKEN is not configured.")

        # Process each trip
        for trip in trips_to_process:
            trip_id = trip.get("transactionId", str(trip.get("_id")))
            logger.debug(f"Attempting map matching for trip {trip_id}")
            try:
                # Determine the source from the trip data itself
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=mapbox_token, source=source
                )
                processor.set_trip_data(trip)

                # Run the full processing pipeline, ensuring map matching is enabled
                await processor.process(do_map_match=True)

                # Check the final state after processing
                if (
                    processor.state == TripState.MAP_MATCHED
                    or processor.state == TripState.COMPLETED
                ):
                    # Save the results (save method handles matched_trips collection update)
                    save_result = await processor.save(map_match_result=True)
                    if save_result:
                        remap_count += 1
                        logger.debug(
                            f"Successfully remapped and saved trip {trip_id}"
                        )
                    else:
                        failed_count += 1
                        logger.warning(
                            f"Remapping succeeded for trip {trip_id}, but save failed."
                        )
                else:
                    # Processing (including map matching) failed
                    failed_count += 1
                    status_info = processor.get_processing_status()
                    logger.warning(
                        f"Failed to remap trip {trip_id}. Final State: {processor.state.value}, Errors: {status_info.get('errors')}"
                    )
                    # Optionally update the trip status in the main collection if needed
                    # await update_one_with_retry(trips_collection, {"_id": trip["_id"]}, {"$set": {"map_match_status": "failed"}})

            except Exception as e:
                # Catch unexpected errors during processing of a single trip
                logger.warning(
                    f"Unexpected error remapping trip {trip_id}: {e}",
                    exc_info=False,
                )
                failed_count += 1
            # Add a delay to manage API rate limits and load
            await asyncio.sleep(0.5)  # Adjust delay as needed

        logger.info(
            f"Remapping attempt finished. Succeeded: {remap_count}, Failed: {failed_count}"
        )

        # --- Completion ---
        result_data = {
            "status": "success",
            "remapped_count": remap_count,
            "failed_count": failed_count,
            "message": f"Attempted remapping for {len(trips_to_process)} trips. Succeeded: {remap_count}, Failed: {failed_count}",
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
            # Use Celery's retry mechanism
            raise self.retry(exc=e, countdown=300)  # Retry after 5 minutes
        except Exception:
            raise e


# Celery task definition (synchronous wrapper)
@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,  # 2 hours hard limit (map matching can be slow)
    soft_time_limit=7000,
    name="tasks.remap_unmatched_trips",
    queue="default",  # Or 'low_priority'
)
def remap_unmatched_trips(self):
    """Celery task wrapper for remapping unmatched trips."""
    return run_async_from_sync(remap_unmatched_trips_async(self))


# 7. VALIDATE TRIP DATA


async def validate_trip_data_async(self) -> Dict[str, Any]:
    """Async logic for validating trip data integrity."""
    task_name = "validate_trip_data"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    processed_count = 0
    failed_count = 0
    modified_count = 0  # Track how many trips were actually marked invalid
    limit = 100  # Process a limited number of trips per run
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

        # --- Task Logic ---
        # Query for trips that haven't been validated recently or need re-validation
        # Example: Find trips not validated in the last N days or missing validation timestamp
        validation_threshold = datetime.now(timezone.utc) - timedelta(
            days=7
        )  # Re-validate weekly
        query = {
            "$or": [
                {"validated_at": {"$exists": False}},
                {"validated_at": {"$lt": validation_threshold}},
            ]
            # Optionally add: "invalid": {"$ne": True} # To skip already known invalid trips
        }

        # Find trips needing validation, applying the limit
        trips_to_process = await find_with_retry(
            trips_collection, query, limit=limit
        )
        logger.info(
            f"Found {len(trips_to_process)} trips needing validation (limit {limit})."
        )

        # Get Mapbox token (might be needed by TripProcessor for certain validations)
        mapbox_token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")

        # Process each trip
        batch_updates = []
        for trip in trips_to_process:
            trip_id = str(trip.get("_id"))
            logger.debug(f"Validating trip {trip_id}")
            processed_count += 1
            try:
                # Determine the source from the trip data itself
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=mapbox_token, source=source
                )
                processor.set_trip_data(trip)

                # Run only the validation step
                await processor.validate()

                # Prepare update based on validation result
                status_info = processor.get_processing_status()
                is_valid = processor.state == TripState.VALIDATED
                validation_message = None
                if not is_valid:
                    # Get the error message from the validation step
                    validation_message = status_info.get("errors", {}).get(
                        TripState.NEW.value, "Validation failed"
                    )

                # Prepare the update operation for this trip
                update_data = {
                    "validated_at": datetime.now(timezone.utc),
                    "validation_status": processor.state.value,  # Store the state reached
                    "invalid": not is_valid,  # Mark as invalid if validation failed
                    "validation_message": validation_message
                    if not is_valid
                    else None,
                }
                batch_updates.append(
                    UpdateOne({"_id": trip["_id"]}, {"$set": update_data})
                )
                if not is_valid:
                    modified_count += (
                        1  # Increment count of trips marked invalid
                    )

            except Exception as e:
                # Catch unexpected errors during validation of a single trip
                logger.error(
                    f"Unexpected error validating trip {trip_id}: {e}",
                    exc_info=False,
                )
                failed_count += 1
                # Prepare update to mark as failed validation due to error
                batch_updates.append(
                    UpdateOne(
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
                )
                modified_count += 1  # Also counts as modified/marked invalid

            # Execute batch write when the batch is full
            if len(batch_updates) >= 50:  # Write in smaller batches
                if batch_updates:
                    try:
                        result = await trips_collection.bulk_write(
                            batch_updates, ordered=False
                        )
                        logger.debug(
                            f"Executed validation update batch: Matched={result.matched_count}, Modified={result.modified_count}"
                        )
                    except BulkWriteError as bwe:
                        logger.error(
                            f"Bulk write error during validation update: {bwe.details}"
                        )
                    except Exception as bulk_err:
                        logger.error(
                            f"Error executing validation update batch: {bulk_err}"
                        )
                batch_updates = []  # Reset batch
                await asyncio.sleep(0.1)  # Small delay

        # Process any remaining updates in the last batch
        if batch_updates:
            try:
                result = await trips_collection.bulk_write(
                    batch_updates, ordered=False
                )
                logger.debug(
                    f"Executed final validation update batch: Matched={result.matched_count}, Modified={result.modified_count}"
                )
            except BulkWriteError as bwe:
                logger.error(
                    f"Bulk write error during final validation update: {bwe.details}"
                )
            except Exception as bulk_err:
                logger.error(
                    f"Error executing final validation update batch: {bulk_err}"
                )

        logger.info(
            f"Validation attempt finished. Processed: {processed_count}, Marked Invalid: {modified_count}, Failed Processing: {failed_count}"
        )

        # --- Completion ---
        result_data = {
            "status": "success",
            "processed_count": processed_count,
            "marked_invalid_count": modified_count,
            "failed_count": failed_count,
            "message": f"Validated {processed_count} trips. Marked {modified_count} as invalid, {failed_count} failed processing.",
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
            # Use Celery's retry mechanism
            raise self.retry(exc=e, countdown=300)  # Retry after 5 minutes
        except Exception:
            raise e


# Celery task definition (synchronous wrapper)
@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,  # 2 hours hard limit
    soft_time_limit=7000,
    name="tasks.validate_trip_data",
    queue="low_priority",  # Run on low priority queue
)
def validate_trip_data(self):
    """Celery task wrapper for validating trip data."""
    return run_async_from_sync(validate_trip_data_async(self))


# 8. RUN TASK SCHEDULER


async def run_task_scheduler_async(self) -> None:
    """
    Async logic for the main task scheduler.
    This task runs periodically (e.g., every minute) and triggers other tasks
    based on their configured schedules and dependencies.
    """

    triggered_count = 0
    skipped_count = 0
    now_utc = datetime.now(timezone.utc)
    logger.debug(f"Scheduler task running at {now_utc.isoformat()}")
    status_manager = (
        TaskStatusManager.get_instance()
    )  # For updating triggered task status

    try:
        # Get the current task configuration
        config = await get_task_config()

        # Check if scheduling is globally disabled
        if not config or config.get("disabled", False):
            logger.info(
                "Task scheduling is globally disabled. Exiting scheduler task."
            )
            return  # Exit if globally disabled

        tasks_to_check = config.get("tasks", {})

        # Mapping from internal task names to Celery task string names
        task_name_mapping = {
            "periodic_fetch_trips": "tasks.periodic_fetch_trips",
            "cleanup_stale_trips": "tasks.cleanup_stale_trips",
            "cleanup_invalid_trips": "tasks.cleanup_invalid_trips",
            "update_geocoding": "tasks.update_geocoding",
            "remap_unmatched_trips": "tasks.remap_unmatched_trips",
            "validate_trip_data": "tasks.validate_trip_data",
            "update_coverage_for_new_trips": "tasks.update_coverage_for_new_trips",
        }

        tasks_to_trigger = []  # List to hold tasks ready to be triggered

        # Iterate through each configured task to check if it should run
        for task_id, task_config in tasks_to_check.items():
            # Skip if the task_id isn't one we know how to trigger
            if task_id not in task_name_mapping:
                logger.debug(
                    f"Skipping unknown task_id '{task_id}' found in config during scheduling."
                )
                continue

            # --- Check conditions for skipping the task ---
            is_enabled = task_config.get("enabled", True)
            current_status = task_config.get("status")
            interval_minutes = task_config.get("interval_minutes")

            if not is_enabled:
                logger.debug(f"Task '{task_id}' skipped (disabled).")
                skipped_count += 1
                continue
            if current_status == TaskStatus.RUNNING.value:
                logger.debug(f"Task '{task_id}' skipped (already running).")
                skipped_count += 1
                continue
            if current_status == TaskStatus.PENDING.value:
                logger.debug(f"Task '{task_id}' skipped (already pending).")
                skipped_count += 1
                continue
            if interval_minutes is None or interval_minutes <= 0:
                logger.debug(
                    f"Task '{task_id}' skipped (invalid or zero interval: {interval_minutes})."
                )
                skipped_count += 1
                continue

            # --- Check if the task is due based on last run time and interval ---
            last_run_any = task_config.get("last_run")
            last_run = None
            if isinstance(last_run_any, datetime):
                last_run = last_run_any
            elif isinstance(last_run_any, str):
                try:
                    # Handle ISO format, ensuring timezone awareness
                    last_run = datetime.fromisoformat(
                        last_run_any.replace("Z", "+00:00")
                    )
                except ValueError:
                    logger.warning(
                        f"Could not parse last_run timestamp '{last_run_any}' for task '{task_id}'."
                    )
                    pass  # Treat as never run if parse fails

            # Ensure timezone awareness (assume UTC if naive)
            if last_run and last_run.tzinfo is None:
                last_run = last_run.replace(tzinfo=timezone.utc)

            is_due = False
            if last_run is None:
                # Task has never run before, it's due now
                is_due = True
                logger.debug(f"Task '{task_id}' is due (never run).")
            else:
                # Calculate the next due time
                next_due_time = last_run + timedelta(minutes=interval_minutes)
                if now_utc >= next_due_time:
                    is_due = True
                    logger.debug(
                        f"Task '{task_id}' is due (Last run: {last_run.isoformat()}, Interval: {interval_minutes}m, Due: {next_due_time.isoformat()})"
                    )

            # --- Check dependencies if the task is due ---
            if is_due:
                dependency_check = await check_dependencies(task_id)
                if dependency_check["can_run"]:
                    # If due and dependencies met, add to the trigger list
                    tasks_to_trigger.append(task_id)
                else:
                    # Log why it was skipped due to dependencies
                    logger.warning(
                        f"Task '{task_id}' is due but dependencies not met: {dependency_check.get('reason')}"
                    )
                    skipped_count += 1
            else:
                # Not due yet
                skipped_count += 1

        # --- Trigger Due Tasks ---
        if not tasks_to_trigger:
            logger.debug("No tasks due to trigger this scheduler cycle.")
            return  # Exit if no tasks are ready

        logger.info(
            f"Scheduler identified {len(tasks_to_trigger)} tasks to trigger: {', '.join(tasks_to_trigger)}"
        )

        # Send each due task to the appropriate Celery queue
        for task_id_to_run in tasks_to_trigger:
            try:
                celery_task_name = task_name_mapping[task_id_to_run]

                # Determine the priority and queue from TASK_METADATA
                priority_enum = TASK_METADATA[task_id_to_run].get(
                    "priority",
                    TaskPriority.MEDIUM,  # Default to MEDIUM
                )
                priority_name = priority_enum.name.lower()
                queue = (
                    f"{priority_name}_priority"
                    if priority_name in ["high", "low"]
                    else "default"  # Map MEDIUM priority to the 'default' queue
                )

                # Generate a unique Celery task ID for history tracking
                celery_task_id = f"{task_id_to_run}_scheduled_{uuid.uuid4()}"

                # Send the task to Celery
                celery_app.send_task(
                    celery_task_name,
                    task_id=celery_task_id,
                    queue=queue,
                    # Pass manual_run=False explicitly if needed by history/logic
                    # kwargs={'manual_run': False} # Example if needed
                )

                # Update the task's status to PENDING in the config
                await status_manager.update_status(
                    task_id_to_run, TaskStatus.PENDING.value
                )
                # Create the initial PENDING entry in the task history
                await update_task_history_entry(
                    celery_task_id=celery_task_id,
                    task_name=task_id_to_run,
                    status=TaskStatus.PENDING.value,
                    manual_run=False,  # Scheduled run
                    start_time=now_utc,  # Record when it was scheduled
                )

                triggered_count += 1
                logger.info(
                    f"Triggered task '{task_id_to_run}' -> Celery task '{celery_task_name}' (ID: {celery_task_id}) on queue '{queue}'"
                )

                # Small delay between triggering tasks to avoid overwhelming the broker instantly
                await asyncio.sleep(0.1)

            except Exception as trigger_err:
                # Log error if triggering failed
                logger.error(
                    f"Failed to trigger task '{task_id_to_run}': {trigger_err}",
                    exc_info=True,
                )
                # Update status to FAILED if triggering failed
                await status_manager.update_status(
                    task_id_to_run,
                    TaskStatus.FAILED.value,
                    error=f"Scheduler trigger failed: {trigger_err}",
                )
                # Optionally create a FAILED history entry here? Or let the task itself handle it if it starts?
                # For now, just update config status.

        logger.info(
            f"Scheduler finished. Triggered: {triggered_count}, Skipped: {skipped_count}"
        )
        return  # Explicitly return None

    except Exception as e:
        # Catch-all for critical errors within the scheduler logic itself
        logger.exception(f"CRITICAL ERROR in run_task_scheduler_async: {e}")
        # Avoid retrying the scheduler itself on critical errors, just log.
        raise  # Re-raise to let Celery know the scheduler task failed critically


# Celery task definition (synchronous wrapper)
@shared_task(
    bind=True,
    name="tasks.run_task_scheduler",
    queue="high_priority",  # Ensure scheduler runs reliably
    ignore_result=True,  # Scheduler doesn't produce a meaningful result
    # Time limits might not be necessary for the scheduler if it's quick,
    # but set reasonably if DB calls could potentially hang.
    time_limit=300,  # 5 minutes hard limit
    soft_time_limit=280,
)
def run_task_scheduler(self):
    """Celery task wrapper for the main task scheduler."""
    # Use the helper to run the async scheduler logic
    run_async_from_sync(run_task_scheduler_async(self))
    # No return value needed


# ------------------------------------------------------------------------------
# API Functions (async for use in FastAPI endpoints)
# ------------------------------------------------------------------------------
async def get_all_task_metadata() -> Dict[str, Any]:
    """
    Retrieves metadata for all defined tasks, enriched with current status
    and configuration from the database.

    Returns:
        A dictionary where keys are task IDs and values are dictionaries
        containing task metadata and current status information.
    """
    try:
        # Get the latest configuration
        task_config = await get_task_config()
        task_metadata_with_status = {}

        # Iterate through statically defined tasks
        for task_id, metadata in TASK_METADATA.items():
            # Start with a copy of the static metadata
            task_entry = metadata.copy()

            # Get the current dynamic configuration for this task
            config_data = task_config.get("tasks", {}).get(task_id, {})

            # --- Calculate Estimated Next Run Time ---
            estimated_next_run = None
            last_run_any = config_data.get("last_run")
            interval_minutes = config_data.get(
                "interval_minutes", metadata.get("default_interval_minutes")
            )
            last_run = None

            # Parse last_run timestamp safely
            if isinstance(last_run_any, datetime):
                last_run = last_run_any
            elif isinstance(last_run_any, str):
                try:
                    last_run = datetime.fromisoformat(
                        last_run_any.replace("Z", "+00:00")
                    )
                except ValueError:
                    pass  # Ignore invalid string format

            # Calculate next run if possible
            if last_run and interval_minutes and interval_minutes > 0:
                # Ensure timezone awareness
                if last_run.tzinfo is None:
                    last_run = last_run.replace(tzinfo=timezone.utc)
                estimated_next_run = last_run + timedelta(
                    minutes=interval_minutes
                )

            # --- Format Priority ---
            priority_enum = metadata.get("priority", TaskPriority.MEDIUM)
            priority_name = (
                priority_enum.name
                if isinstance(priority_enum, TaskPriority)
                else str(priority_enum)  # Fallback if not an enum
            )

            # --- Update entry with dynamic data ---
            task_entry.update(
                {
                    "enabled": config_data.get("enabled", True),
                    "interval_minutes": interval_minutes,
                    "status": config_data.get("status", TaskStatus.IDLE.value),
                    # Use serialization helper for consistent datetime formatting
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
                    "priority": priority_name,  # Use formatted priority name
                }
            )
            task_metadata_with_status[task_id] = task_entry

        return task_metadata_with_status
    except Exception as e:
        # Log error and return static metadata as fallback
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
                "priority": priority_name,  # Add formatted priority
                # Add default/empty status fields for consistency
                "enabled": True,
                "interval_minutes": metadata.get("default_interval_minutes"),
                "status": TaskStatus.IDLE.value,
                "last_run": None,
                "next_run": None,
                "last_error": "Error fetching status",
                "start_time": None,
                "end_time": None,
                "last_updated": None,
            }
        return fallback_metadata


async def manual_run_task(task_id: str) -> Dict[str, Any]:
    """
    Manually triggers one or all specified background tasks via Celery.

    Args:
        task_id: The identifier of the task to run, or 'ALL' to run all enabled tasks.

    Returns:
        A dictionary indicating the status of the trigger operation.
    """
    # Mapping from internal task names to Celery task string names
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
        # Trigger all enabled tasks
        config = await get_task_config()
        enabled_tasks = [
            t_name
            for t_name, t_config in config.get("tasks", {}).items()
            # Check if task is enabled and exists in our mapping
            if t_config.get("enabled", True) and t_name in task_mapping
        ]
        logger.info(
            f"Manual run requested for ALL enabled tasks: {enabled_tasks}"
        )
        results = []
        # Trigger each enabled task individually
        for task_name in enabled_tasks:
            single_result = await _send_manual_task(
                task_name, task_mapping[task_name]
            )
            results.append(single_result)
            await asyncio.sleep(0.1)  # Small delay between triggers

        # Determine overall status based on individual results
        success = all(r.get("success", False) for r in results)
        return {
            "status": "success" if success else "partial_error",
            "message": f"Triggered {len(results)} tasks.",
            "results": results,  # Provide details for each triggered task
        }
    elif task_id in task_mapping:
        # Trigger a single specified task
        logger.info(f"Manual run requested for task: {task_id}")
        result = await _send_manual_task(task_id, task_mapping[task_id])
        return {
            # Return status based on the success of the trigger operation
            "status": "success" if result.get("success") else "error",
            "message": result.get(
                "message", f"Failed to schedule task {task_id}"
            ),
            "task_id": result.get(
                "task_id"
            ),  # Return the Celery task ID if successful
        }
    else:
        # Handle unknown task ID
        logger.error(f"Manual run requested for unknown task: {task_id}")
        return {
            "status": "error",
            "message": f"Unknown or non-runnable task ID: {task_id}",
        }


async def _send_manual_task(
    task_name: str, celery_task_string_name: str
) -> Dict[str, Any]:
    """
    Internal helper to check dependencies and send a single manual task to Celery.

    Args:
        task_name: The application-specific task name.
        celery_task_string_name: The string name used to register the task with Celery.

    Returns:
        A dictionary indicating success/failure and the Celery task ID if successful.
    """
    status_manager = TaskStatusManager.get_instance()
    try:
        # Check dependencies before triggering
        dependency_check = await check_dependencies(task_name)
        if not dependency_check["can_run"]:
            reason = dependency_check.get("reason", "Dependencies not met")
            logger.warning(f"Manual run for {task_name} skipped: {reason}")
            return {"task": task_name, "success": False, "message": reason}

        # Determine priority and queue
        priority_enum = TASK_METADATA[task_name].get(
            "priority", TaskPriority.MEDIUM
        )
        priority_name = priority_enum.name.lower()
        queue = (
            f"{priority_name}_priority"
            if priority_name in ["high", "low"]
            else "default"
        )

        # Generate a unique Celery task ID
        celery_task_id = f"{task_name}_manual_{uuid.uuid4()}"

        # Send the task to the Celery broker
        result = celery_app.send_task(
            celery_task_string_name,
            task_id=celery_task_id,
            queue=queue,
            # Pass manual_run=True via kwargs if the task needs to know
            # kwargs={'manual_run': True} # Example
        )

        # Update status to PENDING in config and history
        await status_manager.update_status(task_name, TaskStatus.PENDING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.PENDING.value,
            manual_run=True,  # Mark as manually triggered
            start_time=datetime.now(timezone.utc),  # Record scheduling time
        )

        logger.info(
            f"Manually triggered task '{task_name}' -> Celery task '{celery_task_string_name}' (ID: {celery_task_id}) on queue '{queue}'"
        )
        # Return success status and the Celery task ID
        return {
            "task": task_name,
            "success": True,
            "message": f"Task {task_name} scheduled successfully.",
            "task_id": result.id,  # Celery AsyncResult ID
        }
    except Exception as e:
        # Log error and update status if sending fails
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
    """
    Updates the task scheduling configuration (enabled status, interval) in the database.

    Args:
        task_config_update: A dictionary containing the updates. Can include:
            'globalDisable': Boolean to disable/enable all tasks.
            'tasks': A dictionary where keys are task IDs and values are dictionaries
                     with 'enabled' (bool) or 'interval_minutes' (int) settings.

    Returns:
        A dictionary indicating the status of the update operation.
    """
    try:
        global_disable_update = task_config_update.get("globalDisable")
        tasks_update = task_config_update.get("tasks", {})
        changes = []  # List to track what was changed for logging/response
        update_payload = {}  # MongoDB update document

        # Handle global disable flag update
        if global_disable_update is not None:
            if isinstance(global_disable_update, bool):
                update_payload["disabled"] = global_disable_update
                changes.append(
                    f"Global scheduling disable set to {global_disable_update}"
                )
            else:
                logger.warning(
                    f"Ignoring non-boolean value for globalDisable: {global_disable_update}"
                )

        # Handle individual task updates
        if tasks_update:
            # Get current config to compare against
            current_config = await get_task_config()
            current_tasks = current_config.get("tasks", {})

            for task_id, settings in tasks_update.items():
                # Check if it's a known task
                if task_id in TASK_METADATA:
                    current_settings = current_tasks.get(task_id, {})

                    # Update 'enabled' status if provided and different
                    if "enabled" in settings:
                        new_val = settings["enabled"]
                        if isinstance(new_val, bool):
                            old_val = current_settings.get("enabled", True)
                            if new_val != old_val:
                                # Use dot notation for updating nested fields
                                update_payload[f"tasks.{task_id}.enabled"] = (
                                    new_val
                                )
                                changes.append(
                                    f"Task '{task_id}' enabled status: {old_val} -> {new_val}"
                                )
                        else:
                            logger.warning(
                                f"Ignoring non-boolean value for enabled status of task '{task_id}': {new_val}"
                            )

                    # Update 'interval_minutes' if provided and different
                    if "interval_minutes" in settings:
                        try:
                            new_val = int(settings["interval_minutes"])
                            # Ensure interval is positive
                            if new_val <= 0:
                                logger.warning(
                                    f"Ignoring invalid interval <= 0 for task '{task_id}': {new_val}"
                                )
                                continue  # Skip this setting update
                        except (ValueError, TypeError):
                            # Ignore non-integer values
                            logger.warning(
                                f"Ignoring non-integer interval for task '{task_id}': {settings['interval_minutes']}"
                            )
                            continue  # Skip this setting update

                        # Get old value for comparison
                        old_val = current_settings.get(
                            "interval_minutes",
                            TASK_METADATA[task_id]["default_interval_minutes"],
                        )
                        if new_val != old_val:
                            update_payload[
                                f"tasks.{task_id}.interval_minutes"
                            ] = new_val
                            changes.append(
                                f"Task '{task_id}' interval: {old_val} -> {new_val} mins"
                            )
                else:
                    # Log if trying to update a task not defined in TASK_METADATA
                    logger.warning(
                        f"Attempted to update configuration for unknown task: {task_id}"
                    )

        # If no valid changes were detected, report success without DB update
        if not update_payload:
            logger.info(
                "No valid configuration changes detected in update request."
            )
            return {
                "status": "success",
                "message": "No valid configuration changes detected.",
            }

        # Apply the updates to the database using the retry wrapper
        result = await update_one_with_retry(
            task_config_collection,
            {
                "_id": "global_background_task_config"
            },  # Target the single config document
            {"$set": update_payload},  # Apply the collected updates
            upsert=True,  # Create the document if it doesn't exist
        )

        # Check if the update operation actually modified the document
        if result.modified_count > 0 or result.upserted_id is not None:
            log_msg = (
                f"Task configuration updated: {'; '.join(changes)}"
                if changes
                else "Task configuration updated (specific changes not detailed)."
            )
            logger.info(log_msg)
            return {
                "status": "success",
                "message": "Task configuration updated successfully.",
                "changes": changes,  # Return the list of changes made
            }
        else:
            # This can happen if the requested values were the same as the existing ones
            logger.info(
                "Task configuration update requested, but no document was modified (values might be the same)."
            )
            return {
                "status": "success",
                "message": "No changes applied to task configuration (values may already match).",
            }
    except Exception as e:
        # Log any unexpected errors during the update process
        logger.exception(f"Error updating task schedule: {e}")
        return {
            "status": "error",
            "message": f"Error updating task schedule: {str(e)}",
        }
