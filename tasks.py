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
from pymongo.errors import BulkWriteError, ConnectionFailure

from bouncie_trip_fetcher import (
    AUTH_CODE,
    AUTHORIZED_DEVICES,
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
    fetch_bouncie_trips_in_range,
)
from celery_app import app as celery_app
from db import (
    SerializationHelper,
    count_documents_with_retry,
    coverage_metadata_collection,
    db_manager,
    find_one_with_retry,
    find_with_retry,
    matched_trips_collection,
    progress_collection,
    task_config_collection,
    task_history_collection,
    trips_collection,
    update_one_with_retry,
)
from live_tracking import (
    cleanup_stale_trips_logic,
    process_trip_data,
    process_trip_end,
    process_trip_metrics,
    process_trip_start,
)
from street_coverage_calculation import compute_incremental_coverage
from trip_processor import TripProcessor, TripState
from utils import (
    run_async_from_sync,
)
from utils import (
    validate_trip_data as validate_trip_data_logic,
)

logger = get_task_logger(__name__)
T = TypeVar("T")


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
            elif status == TaskStatus.PENDING.value:
                update_data[f"tasks.{task_id}.start_time"] = now
                update_data[f"tasks.{task_id}.end_time"] = None
                update_data[f"tasks.{task_id}.last_error"] = None
            elif status == TaskStatus.IDLE.value:
                update_data[f"tasks.{task_id}.start_time"] = None
                update_data[f"tasks.{task_id}.end_time"] = None
                update_data[f"tasks.{task_id}.last_error"] = None

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
                        "last_success_time": None,
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
                updated = True

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
                    f"Task {task_id} dependency {dep_id} not found in configuration."
                )
                continue

            dep_status = tasks_config[dep_id].get("status")

            if dep_status in [
                TaskStatus.RUNNING.value,
                TaskStatus.PENDING.value,
            ]:
                return {
                    "can_run": False,
                    "reason": f"Dependency '{dep_id}' is currently {dep_status}",
                }

            if dep_status == TaskStatus.FAILED.value:
                last_updated_any = tasks_config[dep_id].get("last_updated")
                last_updated = None
                if isinstance(last_updated_any, datetime):
                    last_updated = last_updated_any
                elif isinstance(last_updated_any, str):
                    try:
                        last_updated = datetime.fromisoformat(
                            last_updated_any.replace("Z", "+00:00")
                        )
                    except ValueError:
                        pass

                if last_updated and last_updated.tzinfo is None:
                    last_updated = last_updated.replace(tzinfo=timezone.utc)

                if last_updated and (
                    datetime.now(timezone.utc) - last_updated < timedelta(hours=1)
                ):
                    return {
                        "can_run": False,
                        "reason": f"Dependency '{dep_id}' failed recently",
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
            try:
                update_fields["runtime"] = float(runtime_ms)
            except (ValueError, TypeError):
                logger.warning(
                    f"Could not convert runtime {runtime_ms} to float for {celery_task_id}"
                )
                update_fields["runtime"] = None

        if result is not None:
            try:
                serialized_result = SerializationHelper.serialize_document(
                    {"result": result}
                )["result"]
                update_fields["result"] = serialized_result
            except Exception as ser_err:
                logger.warning(
                    f"Could not serialize result for {task_name} ({celery_task_id}) history: {ser_err}"
                )
                update_fields["result"] = (
                    f"<Unserializable Result: {type(result).__name__}>"
                )
        if error is not None:
            update_fields["error"] = str(error)

        await update_one_with_retry(
            task_history_collection,
            {"_id": celery_task_id},
            {"$set": update_fields},
            upsert=True,
        )
    except Exception as e:
        logger.exception(
            f"Error updating task history for {celery_task_id} ({task_name}): {e}"
        )


async def periodic_fetch_trips_async(self) -> Dict[str, Any]:
    """Async logic for fetching periodic trips since the last stored trip."""
    task_name = "periodic_fetch_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    try:
        logger.info(
            f"Task {task_name} ({celery_task_id}) started at {start_time.isoformat()}"
        )
        logger.info(
            f"Environment variables: CLIENT_ID={'set' if CLIENT_ID else 'NOT SET'}, "
            f"CLIENT_SECRET={'set' if CLIENT_SECRET else 'NOT SET'}, "
            f"REDIRECT_URI={'set' if REDIRECT_URI else 'NOT SET'}, "
            f"AUTH_CODE={'set' if AUTH_CODE else 'NOT SET'}, "
            f"AUTHORIZED_DEVICES count: {len(AUTHORIZED_DEVICES)}"
        )

        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=self.request.get("manual_run", False),
            start_time=start_time,
        )

        logger.info("Determining date range for fetching trips...")

        now_utc = datetime.now(timezone.utc)

        try:
            logger.info("Looking for the most recent trip in the database (any source)")
            latest_trip = await find_one_with_retry(
                trips_collection,
                {},
                sort=[("endTime", -1)],
            )

            if latest_trip:
                latest_trip_id = latest_trip.get("transactionId", "unknown")
                latest_trip_source = latest_trip.get("source", "unknown")
                latest_trip_end = latest_trip.get("endTime")

                logger.info(
                    f"Found most recent trip: id={latest_trip_id}, "
                    f"source={latest_trip_source}, "
                    f"endTime={latest_trip_end}"
                )

                if latest_trip_end:
                    if latest_trip_end.tzinfo is None:
                        latest_trip_end = latest_trip_end.replace(tzinfo=timezone.utc)

                    start_date_fetch = latest_trip_end
                    logger.info(
                        f"Using latest trip endTime as start_date_fetch: {start_date_fetch.isoformat()}"
                    )
                else:
                    logger.warning("Latest trip has no endTime, using fallback")
                    start_date_fetch = now_utc - timedelta(hours=48)
                    logger.info(
                        f"Using fallback start date (48 hours ago): {start_date_fetch.isoformat()}"
                    )
            else:
                logger.warning("No trips found in database, using fallback date range")
                start_date_fetch = now_utc - timedelta(hours=48)
                logger.info(
                    f"Using fallback start date (48 hours ago): {start_date_fetch.isoformat()}"
                )

        except Exception as e:
            logger.exception(f"Error finding latest trip: {e}")
            start_date_fetch = now_utc - timedelta(hours=48)
            logger.info(
                f"Using fallback start date after error (48 hours ago): {start_date_fetch.isoformat()}"
            )

        max_lookback = now_utc - timedelta(days=7)
        if start_date_fetch < max_lookback:
            old_start = start_date_fetch
            start_date_fetch = max_lookback
            logger.info(
                f"Limited start date from {old_start.isoformat()} to {start_date_fetch.isoformat()} (7 day max)"
            )

        logger.info(
            f"FINAL DATE RANGE: Fetching Bouncie trips from {start_date_fetch.isoformat()} to {now_utc.isoformat()}"
        )

        logger.info("Calling fetch_bouncie_trips_in_range...")
        try:
            fetched_trips = await fetch_bouncie_trips_in_range(
                start_date_fetch,
                now_utc,
                do_map_match=True,
            )
            logger.info(
                f"fetch_bouncie_trips_in_range returned {len(fetched_trips)} trips"
            )

            if fetched_trips:
                trip_ids = [
                    trip.get("transactionId", "unknown") for trip in fetched_trips
                ]
                logger.info(f"Fetched trip IDs: {trip_ids}")
            else:
                logger.warning("No trips were fetched in the date range")

        except Exception as fetch_err:
            logger.exception(f"Error in fetch_bouncie_trips_in_range: {fetch_err}")
            raise

        logger.info("Updating last_success_time in task config...")
        try:
            update_result = await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": {f"tasks.{task_name}.last_success_time": now_utc}},
                upsert=True,
            )
            logger.info(
                f"Config update result: modified_count={update_result.modified_count}, "
                f"upserted_id={update_result.upserted_id}"
            )
        except Exception as update_err:
            logger.exception(f"Error updating task config: {update_err}")

        try:
            trips_after_fetch = await count_documents_with_retry(
                trips_collection, {"source": "bouncie"}
            )
            logger.info(
                f"Total trips with source='bouncie' after fetch: {trips_after_fetch}"
            )

            trips_recent = await count_documents_with_retry(
                trips_collection,
                {"source": "bouncie", "startTime": {"$gte": start_date_fetch}},
            )
            logger.info(
                f"Trips with source='bouncie' since {start_date_fetch.isoformat()}: {trips_recent}"
            )
        except Exception as count_err:
            logger.exception(f"Error counting trips in database: {count_err}")

        result_data = {
            "status": "success",
            "message": f"Fetched {len(fetched_trips)} trips successfully",
            "trips_fetched": len(fetched_trips),
            "date_range": {
                "start": start_date_fetch.isoformat(),
                "end": now_utc.isoformat(),
            },
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        logger.info(
            f"Task {task_name} completed successfully. Runtime: {runtime:.0f}ms"
        )

        await status_manager.update_status(task_name, TaskStatus.COMPLETED.value)
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
        logger.exception(f"Task {task_name} ({celery_task_id}) failed: {error_msg}")

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
    """Celery task wrapper for fetching periodic trips."""
    return run_async_from_sync(periodic_fetch_trips_async(self))


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

        coverage_areas = await find_with_retry(coverage_metadata_collection, {})
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

            sub_task_id = f"incr_update_{area_id_str}_{uuid.uuid4()}"
            logger.info(
                f"Processing incremental update for '{display_name}' (SubTask: {sub_task_id})"
            )

            try:
                result = await compute_incremental_coverage(location, sub_task_id)

                if result:
                    logger.info(
                        f"Successfully updated coverage for '{display_name}'. New coverage: {result.get('coverage_percentage', 0):.2f}%"
                    )
                    processed_areas += 1
                else:
                    logger.warning(
                        f"Incremental update failed or returned no result for '{display_name}' (SubTask: {sub_task_id}). Check previous logs."
                    )
                    failed_areas += 1

                await asyncio.sleep(0.5)

            except Exception as inner_e:
                logger.error(
                    f"Error during incremental update for '{display_name}': {inner_e}",
                    exc_info=True,
                )
                failed_areas += 1
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
                continue

        logger.info(
            f"Completed automated incremental updates. Processed: {processed_areas}, Failed: {failed_areas}, Skipped: {skipped_areas}"
        )

        result_data = {
            "status": "success",
            "areas_processed": processed_areas,
            "areas_failed": failed_areas,
            "areas_skipped": skipped_areas,
            "message": f"Completed incremental updates. Processed: {processed_areas}, Failed: {failed_areas}, Skipped: {skipped_areas}",
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(task_name, TaskStatus.COMPLETED.value)
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
        logger.exception(f"Task {task_name} ({celery_task_id}) failed: {error_msg}")
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
            raise self.retry(exc=e, countdown=300)
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
    """Celery task wrapper for updating coverage incrementally."""
    return run_async_from_sync(update_coverage_for_new_trips_async(self))


async def cleanup_stale_trips_async(self) -> Dict[str, Any]:
    """Async logic for cleaning up stale live tracking trips.
    Fetches collections explicitly before calling the logic function.
    """
    task_name = "cleanup_stale_trips"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = (
        self.request.id if hasattr(self, "request") else "manual_or_unknown"
    )
    result_data = {}
    manual_run = (
        getattr(self.request, "manual_run", False)
        if hasattr(self, "request")
        else False
    )

    try:
        _ = db_manager.client
        logger.debug("Database client accessed for cleanup task.")

        live_collection = db_manager.get_collection("live_trips")
        archive_collection = db_manager.get_collection("archived_live_trips")

        if live_collection is None or archive_collection is None:
            logger.critical(
                "DB collections ('live_trips' or 'archived_live_trips') could not be obtained in cleanup task!"
            )
            raise ConnectionFailure(
                "Could not get required collections for cleanup task."
            )
        logger.debug(
            "Successfully obtained live_trips and archived_live_trips collections."
        )

        await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.RUNNING.value,
            manual_run=manual_run,
            start_time=start_time,
        )
        logger.info(f"Task {task_name} ({celery_task_id}) started.")

        cleanup_result = await cleanup_stale_trips_logic(
            live_collection=live_collection,
            archive_collection=archive_collection,
        )

        stale_archived_count = cleanup_result.get("stale_trips_archived", 0)
        old_removed_count = cleanup_result.get("old_archives_removed", 0)
        logger.info(
            f"Cleanup logic completed: Archived {stale_archived_count} stale live trips, removed {old_removed_count} old archives."
        )

        result_data = {
            "status": "success",
            "message": f"Cleaned up {stale_archived_count} stale trips, removed {old_removed_count} old archives.",
            "details": cleanup_result,
        }

        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(task_name, TaskStatus.COMPLETED.value)
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.COMPLETED.value,
            result=result_data,
            end_time=end_time,
            runtime_ms=runtime,
        )
        logger.info(
            f"Task {task_name} ({celery_task_id}) completed successfully in {runtime:.0f}ms."
        )
        return result_data

    except ConnectionFailure as db_conn_err:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"DB Connection error in {task_name}: {db_conn_err}"
        logger.critical(error_msg, exc_info=True)
        await status_manager.update_status(
            task_name, TaskStatus.FAILED.value, error=str(db_conn_err)
        )
        await update_task_history_entry(
            celery_task_id=celery_task_id,
            task_name=task_name,
            status=TaskStatus.FAILED.value,
            error=str(db_conn_err),
            end_time=end_time,
            runtime_ms=runtime,
        )
        if hasattr(self, "retry"):
            raise self.retry(exc=db_conn_err, countdown=60)
        else:
            raise db_conn_err

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Unexpected error in {task_name}: {e}"
        logger.exception(f"Task {task_name} ({celery_task_id}) failed: {error_msg}")
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
        if hasattr(self, "retry"):
            try:
                raise self.retry(exc=e, countdown=60)
            except Exception as retry_exc:
                logger.error("Celery retry mechanism failed: %s", retry_exc)
                raise e
        else:
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
    """Celery task wrapper for cleaning up stale live trips."""
    return run_async_from_sync(cleanup_stale_trips_async(self))


async def cleanup_invalid_trips_async(self) -> Dict[str, Any]:
    """Async logic for identifying and marking invalid trip records."""
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

        query = {"invalid": {"$ne": True}}

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
            cursor = trips_collection.find(
                query,
                {
                    "startTime": 1,
                    "endTime": 1,
                    "gps": 1,
                    "_id": 1,
                },
            ).batch_size(batch_size)

            batch_updates = []
            async for trip in cursor:
                processed_count += 1
                valid, message = validate_trip_data_logic(trip)

                if not valid:
                    batch_updates.append(
                        UpdateOne(
                            {"_id": trip["_id"]},
                            {
                                "$set": {
                                    "invalid": True,
                                    "validation_message": message
                                    or "Invalid data detected",
                                    "validated_at": datetime.now(timezone.utc),
                                }
                            },
                        )
                    )
                    modified_count += 1

                if len(batch_updates) >= batch_size:
                    if batch_updates:
                        try:
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
                        except Exception as bulk_err:
                            logger.error(
                                f"Error executing validation batch: {bulk_err}"
                            )
                    batch_updates = []
                    logger.info(
                        f"Processed {processed_count}/{total_docs_to_process} trips for validation."
                    )
                    await asyncio.sleep(0.1)

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
                    logger.error(f"Error executing final validation batch: {bulk_err}")

            result_data = {
                "status": "success",
                "message": f"Processed {processed_count} trips, marked {modified_count} as potentially invalid",
                "processed_count": processed_count,
                "modified_count": modified_count,
            }

        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(task_name, TaskStatus.COMPLETED.value)
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
        logger.exception(f"Task {task_name} ({celery_task_id}) failed: {error_msg}")
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
            raise self.retry(exc=e, countdown=300)
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
    """Celery task wrapper for cleaning up invalid trip data."""
    return run_async_from_sync(cleanup_invalid_trips_async(self))


async def update_geocoding_async(self) -> Dict[str, Any]:
    """Async logic for updating geocoding for trips missing location data."""
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
                {"startLocation.formatted_address": ""},
                {"destination.formatted_address": ""},
            ],
        }

        trips_to_process = await find_with_retry(trips_collection, query, limit=limit)
        logger.info(
            f"Found {len(trips_to_process)} trips needing geocoding (limit {limit})."
        )

        mapbox_token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
        if not mapbox_token:
            logger.warning("MAPBOX_ACCESS_TOKEN not set, cannot perform geocoding.")
            raise ValueError("MAPBOX_ACCESS_TOKEN is not configured.")

        for trip in trips_to_process:
            trip_id = trip.get("transactionId", str(trip.get("_id")))
            logger.debug(f"Attempting to geocode trip {trip_id}")
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(mapbox_token=mapbox_token, source=source)
                processor.set_trip_data(trip)

                await processor.validate()
                if processor.state == TripState.VALIDATED:
                    await processor.process_basic()

                if processor.state == TripState.PROCESSED:
                    await processor.geocode()

                    if processor.state == TripState.GEOCODED:
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
                        failed_count += 1
                        status_info = processor.get_processing_status()
                        logger.warning(
                            f"Geocoding failed for trip {trip_id}. State: {processor.state.value}, Errors: {status_info.get('errors')}"
                        )
                else:
                    failed_count += 1
                    status_info = processor.get_processing_status()
                    logger.warning(
                        f"Skipping geocoding for trip {trip_id} due to prior processing failure. State: {processor.state.value}, Errors: {status_info.get('errors')}"
                    )

            except Exception as e:
                logger.error(
                    f"Unexpected error geocoding trip {trip_id}: {e}",
                    exc_info=False,
                )
                failed_count += 1
            await asyncio.sleep(0.2)

        logger.info(
            f"Geocoding attempt finished. Succeeded: {geocoded_count}, Failed: {failed_count}"
        )

        result_data = {
            "status": "success",
            "geocoded_count": geocoded_count,
            "failed_count": failed_count,
            "message": f"Attempted geocoding for {len(trips_to_process)} trips. Succeeded: {geocoded_count}, Failed: {failed_count}",
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(task_name, TaskStatus.COMPLETED.value)
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
        logger.exception(f"Task {task_name} ({celery_task_id}) failed: {error_msg}")
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
            raise self.retry(exc=e, countdown=300)
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
    """Celery task wrapper for updating trip geocoding."""
    return run_async_from_sync(update_geocoding_async(self))


async def remap_unmatched_trips_async(self) -> Dict[str, Any]:
    """Async logic for attempting to map-match trips that previously failed or were not matched."""
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
            await status_manager.update_status(task_name, TaskStatus.COMPLETED.value)
            await update_task_history_entry(
                celery_task_id=celery_task_id,
                task_name=task_name,
                status=TaskStatus.COMPLETED.value,
                result=result_data,
                end_time=datetime.now(timezone.utc),
                runtime_ms=0,
            )
            return result_data

        matched_ids_cursor = matched_trips_collection.find(
            {},
            {"transactionId": 1},
        )
        matched_ids = {
            doc["transactionId"]
            async for doc in matched_ids_cursor
            if "transactionId" in doc
        }
        logger.info(f"Found {len(matched_ids)} already matched trip IDs.")

        query = {
            "transactionId": {"$nin": list(matched_ids)},
        }

        trips_to_process = await find_with_retry(trips_collection, query, limit=limit)
        logger.info(
            f"Found {len(trips_to_process)} trips to attempt remapping (limit {limit})."
        )

        mapbox_token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
        if not mapbox_token:
            logger.warning("MAPBOX_ACCESS_TOKEN not set, cannot perform map matching.")
            raise ValueError("MAPBOX_ACCESS_TOKEN is not configured.")

        for trip in trips_to_process:
            trip_id = trip.get("transactionId", str(trip.get("_id")))
            logger.debug(f"Attempting map matching for trip {trip_id}")
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(mapbox_token=mapbox_token, source=source)
                processor.set_trip_data(trip)

                await processor.process(do_map_match=True)

                if (
                    processor.state == TripState.MAP_MATCHED
                    or processor.state == TripState.COMPLETED
                ):
                    save_result = await processor.save(map_match_result=True)
                    if save_result:
                        remap_count += 1
                        logger.debug(f"Successfully remapped and saved trip {trip_id}")
                    else:
                        failed_count += 1
                        logger.warning(
                            f"Remapping succeeded for trip {trip_id}, but save failed."
                        )
                else:
                    failed_count += 1
                    status_info = processor.get_processing_status()
                    logger.warning(
                        f"Failed to remap trip {trip_id}. Final State: {processor.state.value}, Errors: {status_info.get('errors')}"
                    )

            except Exception as e:
                logger.warning(
                    f"Unexpected error remapping trip {trip_id}: {e}",
                    exc_info=False,
                )
                failed_count += 1
            await asyncio.sleep(0.5)

        logger.info(
            f"Remapping attempt finished. Succeeded: {remap_count}, Failed: {failed_count}"
        )

        result_data = {
            "status": "success",
            "remapped_count": remap_count,
            "failed_count": failed_count,
            "message": f"Attempted remapping for {len(trips_to_process)} trips. Succeeded: {remap_count}, Failed: {failed_count}",
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(task_name, TaskStatus.COMPLETED.value)
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
        logger.exception(f"Task {task_name} ({celery_task_id}) failed: {error_msg}")
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
            raise self.retry(exc=e, countdown=300)
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
    """Celery task wrapper for remapping unmatched trips."""
    return run_async_from_sync(remap_unmatched_trips_async(self))


async def validate_trip_data_async(self) -> Dict[str, Any]:
    """Async logic for validating trip data integrity."""
    task_name = "validate_trip_data"
    status_manager = TaskStatusManager.get_instance()
    start_time = datetime.now(timezone.utc)
    celery_task_id = self.request.id
    processed_count = 0
    failed_count = 0
    modified_count = 0
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

        validation_threshold = datetime.now(timezone.utc) - timedelta(days=7)
        query = {
            "$or": [
                {"validated_at": {"$exists": False}},
                {"validated_at": {"$lt": validation_threshold}},
            ]
        }

        trips_to_process = await find_with_retry(trips_collection, query, limit=limit)
        logger.info(
            f"Found {len(trips_to_process)} trips needing validation (limit {limit})."
        )

        mapbox_token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")

        batch_updates = []
        for trip in trips_to_process:
            trip_id = str(trip.get("_id"))
            logger.debug(f"Validating trip {trip_id}")
            processed_count += 1
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(mapbox_token=mapbox_token, source=source)
                processor.set_trip_data(trip)

                await processor.validate()

                status_info = processor.get_processing_status()
                is_valid = processor.state == TripState.VALIDATED
                validation_message = None
                if not is_valid:
                    validation_message = status_info.get("errors", {}).get(
                        TripState.NEW.value, "Validation failed"
                    )

                update_data = {
                    "validated_at": datetime.now(timezone.utc),
                    "validation_status": processor.state.value,
                    "invalid": not is_valid,
                    "validation_message": (
                        validation_message if not is_valid else None
                    ),
                }
                batch_updates.append(
                    UpdateOne({"_id": trip["_id"]}, {"$set": update_data})
                )
                if not is_valid:
                    modified_count += 1

            except Exception as e:
                logger.error(
                    f"Unexpected error validating trip {trip_id}: {e}",
                    exc_info=False,
                )
                failed_count += 1
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
                modified_count += 1

            if len(batch_updates) >= 50:
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
                batch_updates = []
                await asyncio.sleep(0.1)

        if batch_updates:
            try:
                result = await trips_collection.bulk_write(batch_updates, ordered=False)
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

        result_data = {
            "status": "success",
            "processed_count": processed_count,
            "marked_invalid_count": modified_count,
            "failed_count": failed_count,
            "message": f"Validated {processed_count} trips. Marked {modified_count} as invalid, {failed_count} failed processing.",
        }
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        await status_manager.update_status(task_name, TaskStatus.COMPLETED.value)
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
        logger.exception(f"Task {task_name} ({celery_task_id}) failed: {error_msg}")
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
            raise self.retry(exc=e, countdown=300)
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
    """Celery task wrapper for validating trip data."""
    return run_async_from_sync(validate_trip_data_async(self))


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
    status_manager = TaskStatusManager.get_instance()

    try:
        config = await get_task_config()

        if not config or config.get("disabled", False):
            logger.info("Task scheduling is globally disabled. Exiting scheduler task.")
            return

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
                    f"Skipping unknown task_id '{task_id}' found in config during scheduling."
                )
                continue

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

            last_run_any = task_config.get("last_run")
            last_run = None
            if isinstance(last_run_any, datetime):
                last_run = last_run_any
            elif isinstance(last_run_any, str):
                try:
                    last_run = datetime.fromisoformat(
                        last_run_any.replace("Z", "+00:00")
                    )
                except ValueError:
                    logger.warning(
                        f"Could not parse last_run timestamp '{last_run_any}' for task '{task_id}'."
                    )
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
                        f"Task '{task_id}' is due (Last run: {last_run.isoformat()}, Interval: {interval_minutes}m, Due: {next_due_time.isoformat()})"
                    )

            if is_due:
                dependency_check = await check_dependencies(task_id)
                if dependency_check["can_run"]:
                    tasks_to_trigger.append(task_id)
                else:
                    logger.warning(
                        f"Task '{task_id}' is due but dependencies not met: {dependency_check.get('reason')}"
                    )
                    skipped_count += 1
            else:
                skipped_count += 1

        if not tasks_to_trigger:
            logger.debug("No tasks due to trigger this scheduler cycle.")
            return

        logger.info(
            f"Scheduler identified {len(tasks_to_trigger)} tasks to trigger: {', '.join(tasks_to_trigger)}"
        )

        for task_id_to_run in tasks_to_trigger:
            try:
                celery_task_name = task_name_mapping[task_id_to_run]

                priority_enum = TASK_METADATA[task_id_to_run].get(
                    "priority",
                    TaskPriority.MEDIUM,
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
                    f"Triggered task '{task_id_to_run}' -> Celery task '{celery_task_name}' (ID: {celery_task_id}) on queue '{queue}'"
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
                    error=f"Scheduler trigger failed: {trigger_err}",
                )

        logger.info(
            f"Scheduler finished. Triggered: {triggered_count}, Skipped: {skipped_count}"
        )
        return

    except Exception as e:
        logger.exception(f"CRITICAL ERROR in run_task_scheduler_async: {e}")
        raise


@shared_task(
    bind=True,
    name="tasks.run_task_scheduler",
    queue="high_priority",
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
)
def run_task_scheduler(self):
    """Celery task wrapper for the main task scheduler."""
    run_async_from_sync(run_task_scheduler_async(self))


async def get_all_task_metadata() -> Dict[str, Any]:
    """
    Retrieves metadata for all defined tasks, enriched with current status
    and configuration from the database.

    Returns:
        A dictionary where keys are task IDs and values are dictionaries
        containing task metadata and current status information.
    """
    try:
        task_config = await get_task_config()
        task_metadata_with_status = {}

        for task_id, metadata in TASK_METADATA.items():
            task_entry = metadata.copy()

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
                estimated_next_run = last_run + timedelta(minutes=interval_minutes)

            priority_enum = metadata.get("priority", TaskPriority.MEDIUM)
            priority_name = (
                priority_enum.name
                if isinstance(priority_enum, TaskPriority)
                else str(priority_enum)
            )

            task_entry.update(
                {
                    "enabled": config_data.get("enabled", True),
                    "interval_minutes": interval_minutes,
                    "status": config_data.get("status", TaskStatus.IDLE.value),
                    "last_run": SerializationHelper.serialize_datetime(last_run),
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
            task_metadata_with_status[task_id] = task_entry

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
        logger.info(f"Manual run requested for ALL enabled tasks: {enabled_tasks}")
        results = []
        for task_name in enabled_tasks:
            single_result = await _send_manual_task(task_name, task_mapping[task_name])
            results.append(single_result)
            await asyncio.sleep(0.1)

        success = all(r.get("success", False) for r in results)
        return {
            "status": "success" if success else "partial_error",
            "message": f"Triggered {len(results)} tasks.",
            "results": results,
        }
    elif task_id in task_mapping:
        logger.info(f"Manual run requested for task: {task_id}")
        result = await _send_manual_task(task_id, task_mapping[task_id])
        return {
            "status": "success" if result.get("success") else "error",
            "message": result.get("message", f"Failed to schedule task {task_id}"),
            "task_id": result.get("task_id"),
        }
    else:
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
        dependency_check = await check_dependencies(task_name)
        if not dependency_check["can_run"]:
            reason = dependency_check.get("reason", "Dependencies not met")
            logger.warning(f"Manual run for {task_name} skipped: {reason}")
            return {"task": task_name, "success": False, "message": reason}

        priority_enum = TASK_METADATA[task_name].get("priority", TaskPriority.MEDIUM)
        priority_name = priority_enum.name.lower()
        queue = (
            f"{priority_name}_priority"
            if priority_name in ["high", "low"]
            else "default"
        )

        celery_task_id = f"{task_name}_manual_{uuid.uuid4()}"

        result = celery_app.send_task(
            celery_task_string_name,
            task_id=celery_task_id,
            queue=queue,
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
            f"Manually triggered task '{task_name}' -> Celery task '{celery_task_string_name}' (ID: {celery_task_id}) on queue '{queue}'"
        )
        return {
            "task": task_name,
            "success": True,
            "message": f"Task {task_name} scheduled successfully.",
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
        changes = []
        update_payload = {}

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

        if tasks_update:
            current_config = await get_task_config()
            current_tasks = current_config.get("tasks", {})

            for task_id, settings in tasks_update.items():
                if task_id in TASK_METADATA:
                    current_settings = current_tasks.get(task_id, {})

                    if "enabled" in settings:
                        new_val = settings["enabled"]
                        if isinstance(new_val, bool):
                            old_val = current_settings.get("enabled", True)
                            if new_val != old_val:
                                update_payload[f"tasks.{task_id}.enabled"] = new_val
                                changes.append(
                                    f"Task '{task_id}' enabled status: {old_val} -> {new_val}"
                                )
                        else:
                            logger.warning(
                                f"Ignoring non-boolean value for enabled status of task '{task_id}': {new_val}"
                            )

                    if "interval_minutes" in settings:
                        try:
                            new_val = int(settings["interval_minutes"])
                            if new_val <= 0:
                                logger.warning(
                                    f"Ignoring invalid interval <= 0 for task '{task_id}': {new_val}"
                                )
                                continue
                        except (ValueError, TypeError):
                            logger.warning(
                                f"Ignoring non-integer interval for task '{task_id}': {settings['interval_minutes']}"
                            )
                            continue

                        old_val = current_settings.get(
                            "interval_minutes",
                            TASK_METADATA[task_id]["default_interval_minutes"],
                        )
                        if new_val != old_val:
                            update_payload[f"tasks.{task_id}.interval_minutes"] = (
                                new_val
                            )
                            changes.append(
                                f"Task '{task_id}' interval: {old_val} -> {new_val} mins"
                            )
                else:
                    logger.warning(
                        f"Attempted to update configuration for unknown task: {task_id}"
                    )

        if not update_payload:
            logger.info("No valid configuration changes detected in update request.")
            return {
                "status": "success",
                "message": "No valid configuration changes detected.",
            }

        result = await update_one_with_retry(
            task_config_collection,
            {"_id": "global_background_task_config"},
            {"$set": update_payload},
            upsert=True,
        )

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
                "changes": changes,
            }
        else:
            logger.info(
                "Task configuration update requested, but no document was modified (values might be the same)."
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


@shared_task(
    bind=True,
    name="tasks.process_webhook_event_task",
    max_retries=3,
    default_retry_delay=90,
    time_limit=300,
    soft_time_limit=240,
    acks_late=True,
    queue="default",
)
def process_webhook_event_task(self, data: Dict[str, Any]):
    """
    Celery task to process Bouncie webhook data asynchronously.
    Obtains DB collections reliably at the start of execution via db_manager.
    """
    task_name = "process_webhook_event_task"
    celery_task_id = self.request.id
    start_time = datetime.now(timezone.utc)
    event_type = data.get("eventType")
    transaction_id = data.get("transactionId")

    logger.info(
        "Celery Task %s (%s) started processing webhook: Type=%s, TransactionID=%s",
        task_name,
        celery_task_id,
        event_type or "Unknown",
        transaction_id or "N/A",
    )

    live_collection = None
    archive_collection = None

    try:
        logger.debug(
            "Task %s: Attempting to get DB collections via db_manager.",
            celery_task_id,
        )
        _ = db_manager.client
        if not db_manager._connection_healthy:
            logger.warning(
                "Task %s: DB Manager connection unhealthy, attempting re-init.",
                celery_task_id,
            )
            db_manager._initialize_client()
            if not db_manager._connection_healthy:
                logger.critical(
                    "Task %s: DB Manager re-initialization failed.",
                    celery_task_id,
                )
                raise ConnectionFailure(
                    "DB Manager connection unhealthy after re-init attempt."
                )

        live_collection = db_manager.get_collection("live_trips")
        archive_collection = db_manager.get_collection("archived_live_trips")

        if live_collection is None or archive_collection is None:
            logger.critical(
                "Task %s: Failed to obtain required DB collections ('live_trips' or 'archived_live_trips') via db_manager.",
                celery_task_id,
            )
            raise ConnectionFailure("Failed to obtain DB collections via db_manager.")
        logger.debug("Task %s: Successfully obtained DB collections.", celery_task_id)

        if not event_type:
            logger.error(
                "Task %s: Missing eventType in webhook data: %s",
                celery_task_id,
                data,
            )
            return {"status": "error", "message": "Missing eventType"}

        if (
            event_type in ("tripStart", "tripData", "tripMetrics", "tripEnd")
            and not transaction_id
        ):
            logger.error(
                "Task %s: Missing transactionId for required event type %s: %s",
                celery_task_id,
                event_type,
                data,
            )
            return {
                "status": "error",
                "message": f"Missing transactionId for {event_type}",
            }

        if event_type == "tripStart":
            run_async_from_sync(process_trip_start(data, live_collection))
        elif event_type == "tripData":
            run_async_from_sync(
                process_trip_data(data, live_collection, archive_collection)
            )
        elif event_type == "tripMetrics":
            run_async_from_sync(
                process_trip_metrics(data, live_collection, archive_collection)
            )
        elif event_type == "tripEnd":
            run_async_from_sync(
                process_trip_end(data, live_collection, archive_collection)
            )
        elif event_type in ("connect", "disconnect", "battery", "mil"):
            logger.info(
                "Task %s: Received non-trip event type: %s. Ignoring. Payload: %s",
                celery_task_id,
                event_type,
                data,
            )
        else:
            logger.warning(
                "Task %s: Received unknown event type: %s. Payload: %s",
                celery_task_id,
                event_type,
                data,
            )

        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        logger.info(
            "Celery Task %s (%s) successfully processed webhook: Type=%s, TransactionID=%s in %.0fms",
            task_name,
            celery_task_id,
            event_type,
            transaction_id or "N/A",
            runtime,
        )
        return {"status": "success", "message": "Event processed successfully"}

    except ConnectionFailure as db_err:
        logger.error(
            "Task %s (%s): Database connection error during processing: %s",
            task_name,
            celery_task_id,
            db_err,
            exc_info=False,
        )
        if (
            hasattr(self, "request")
            and hasattr(self.request, "retries")
            and hasattr(self, "default_retry_delay")
        ):
            countdown = int(self.default_retry_delay * (2**self.request.retries))
            logger.info(
                "Retrying task %s in %d seconds due to DB connection error.",
                celery_task_id,
                countdown,
            )
            try:
                self.retry(exc=db_err, countdown=countdown)
            except Exception as retry_exc:
                logger.critical(
                    "Failed to *initiate* retry for task %s: %s",
                    celery_task_id,
                    retry_exc,
                )
                raise db_err from retry_exc
        else:
            logger.error(
                "Cannot retry task %s as Celery retry context is missing.",
                celery_task_id,
            )
            raise db_err

    except Exception as e:
        end_time = datetime.now(timezone.utc)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = f"Unhandled error processing webhook event {event_type or 'Unknown'} (TxID: {transaction_id or 'N/A'})"
        logger.exception(
            "Celery Task %s (%s) FAILED processing webhook: %s. Runtime: %.0fms",
            task_name,
            celery_task_id,
            error_msg,
            runtime,
            exc_info=e,
        )
        if (
            hasattr(self, "request")
            and hasattr(self.request, "retries")
            and hasattr(self, "default_retry_delay")
        ):
            countdown = int(self.default_retry_delay * (2**self.request.retries))
            logger.info(
                "Retrying task %s in %d seconds due to generic error: %s",
                celery_task_id,
                countdown,
                e,
            )
            try:
                self.retry(exc=e, countdown=countdown)
            except Exception as retry_exc:
                logger.critical(
                    "Failed to *initiate* retry for task %s after generic error: %s",
                    celery_task_id,
                    retry_exc,
                )
                raise e from retry_exc
        else:
            logger.error(
                "Cannot retry task %s for generic error as Celery retry context is missing.",
                celery_task_id,
            )
            raise e
