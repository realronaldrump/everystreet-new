"""Core task infrastructure: status enum, metadata, manager, and decorators.

This module provides the foundational components used by all task modules:
- TaskStatus: Enum for task states
- TASK_METADATA: Task definitions and configuration
- TaskStatusManager: Singleton for managing task status in the database
- task_runner: Decorator for wrapping async task logic with lifecycle management
"""

from __future__ import annotations

import functools
import os
from datetime import UTC, datetime
from enum import Enum
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from collections.abc import Callable

from celery.utils.log import get_task_logger


logger = get_task_logger(__name__)
T = TypeVar("T")


class TaskStatus(Enum):
    """Enumeration of possible task states."""

    IDLE = "IDLE"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    PENDING = "PENDING"


TASK_METADATA = {
    "periodic_fetch_trips": {
        "display_name": "Periodic Trip Fetch",
        "default_interval_minutes": int(
            os.environ.get(
                "TRIP_FETCH_INTERVAL_MINUTES",
                "720",
            ),
        ),
        "dependencies": [],
        "description": "Fetches trips from the Bouncie API periodically",
    },
    "cleanup_stale_trips": {
        "display_name": "Cleanup Stale Trips",
        "default_interval_minutes": 60,
        "dependencies": [],
        "description": "Archives trips that haven't been updated recently",
    },
    "validate_trips": {
        "display_name": "Validate Trips",
        "default_interval_minutes": 720,
        "dependencies": [],
        "description": (
            "Scans all trips and validates their data. A trip is marked invalid if: "
            "(1) it's missing required data like GPS coordinates, start time, or end "
            "time, (2) it has malformed or out-of-range GPS data, OR (3) the car was "
            "turned on briefly without actually driving (zero distance, same start/end "
            "location, no movement, and lasted less than 5 minutes). Longer idle "
            "sessions are preserved. This task also updates validation timestamps "
            "and syncs invalid status to matched trips."
        ),
    },
    "remap_unmatched_trips": {
        "display_name": "Remap Unmatched Trips",
        "default_interval_minutes": 360,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Attempts to map-match trips that previously failed",
    },
    "update_coverage_for_new_trips": {
        "display_name": "Incremental Progress Updates",
        "default_interval_minutes": 180,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Updates coverage calculations incrementally for new trips",
    },
    "manual_fetch_trips_range": {
        "display_name": "Fetch Trips (Custom Range)",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Fetches Bouncie trips for a specific date range on-demand",
        "manual_only": True,
    },
    "fetch_all_missing_trips": {
        "display_name": "Fetch All Missing Trips",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Fetches all trips from 2020-01-01 to now to fill gaps",
        "manual_only": True,
    },
    "generate_optimal_route": {
        "display_name": "Generate Optimal Route",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Computes optimal completion route for a coverage area using RPP algorithm",
        "manual_only": True,
    },
}


class TaskStatusManager:
    """Centralized task status management using db_manager.

    This is a singleton class that provides methods for updating task status
    in the global task configuration document stored in MongoDB.
    """

    _instance = None

    @classmethod
    def get_instance(cls):
        """Get the singleton instance of TaskStatusManager."""
        if cls._instance is None:
            cls._instance = TaskStatusManager()
        return cls._instance

    @staticmethod
    async def update_status(
        task_id: str,
        status: str,
        error: str | None = None,
    ) -> bool:
        """Updates the status of a specific task using the TaskConfig Beanie model.

        Args:
            task_id: The identifier of the task (e.g., 'periodic_fetch_trips').
            status: The new status string (should match TaskStatus enum values).
            error: An optional error message if the status is FAILED.

        Returns:
            True if the update was successful, False otherwise.
        """
        try:
            from db.models import TaskConfig

            now = datetime.now(UTC)

            # Find existing config or create new one
            task_config = await TaskConfig.find_one(TaskConfig.task_id == task_id)
            if not task_config:
                task_config = TaskConfig(task_id=task_id)

            task_config.status = status
            task_config.last_updated = now

            if status == TaskStatus.RUNNING.value:
                # For RUNNING, we set the start time in the 'config' dict or a specific field?
                # The model has 'last_run', 'next_run', 'status' fields.
                # It does NOT have start_time/end_time/last_error top-level fields in the model definition I saw earlier,
                # except 'last_run'.
                # Let me re-read the model.
                # Model has: task_id, enabled, interval_minutes, last_run, next_run, status, config.
                # It does NOT have execution-specific fields like start_time, end_time at root.
                # I should probably store these in the 'config' dict or update the model.
                # Actually, looking at the previous code, it stored them in tasks.{task_id}.start_time etc.
                # Let's put them in the 'config' dict for now to avoid changing the model definition if possible,
                # OR update the model to include them.
                # Updating the model is cleaner.
                # logic:
                task_config.config["start_time"] = now
                task_config.config["end_time"] = None
                task_config.config["last_error"] = None

            elif status == TaskStatus.COMPLETED.value:
                task_config.last_run = now
                task_config.config["end_time"] = now
                task_config.config["last_error"] = None

            elif status == TaskStatus.FAILED.value:
                task_config.config["last_error"] = error
                task_config.config["end_time"] = now

            elif status == TaskStatus.PENDING.value:
                task_config.config["start_time"] = now
                task_config.config["end_time"] = None
                task_config.config["last_error"] = None

            elif status == TaskStatus.IDLE.value:
                task_config.config["start_time"] = None
                task_config.config["end_time"] = None
                task_config.config["last_error"] = None

            await task_config.save()
            return True

        except Exception as e:
            logger.exception("Error updating task status for %s: %s", task_id, e)
            return False


def task_runner(func: Callable) -> Callable:
    """Decorator that handles all common task lifecycle management.

    This decorator wraps async task functions to provide consistent:
    - Status updates (RUNNING, COMPLETED, FAILED)
    - Task history tracking
    - Error handling and retry logic
    - Runtime calculation

    The decorated function should only contain the core business logic.
    """
    # Import here to avoid circular imports
    from tasks.config import update_task_history_entry

    @functools.wraps(func)
    async def wrapper(self, *args, **kwargs) -> dict[str, Any]:
        # Extract task name from function name (remove '_async' suffix)
        task_name = func.__name__.replace("_async", "")

        # Get necessary task metadata
        status_manager = TaskStatusManager.get_instance()
        start_time = datetime.now(UTC)
        celery_task_id = self.request.id
        manual_run = (
            kwargs.get("manual_run", False)
            or getattr(self.request, "kwargs", {}).get("manual_run", False)
            or getattr(self.request, "manual_run", False)
        )

        try:
            # Task startup: update status to RUNNING
            logger.info(
                "Task %s (%s) started at %s",
                task_name,
                celery_task_id,
                start_time.isoformat(),
            )

            await status_manager.update_status(task_name, TaskStatus.RUNNING.value)
            await update_task_history_entry(
                celery_task_id=celery_task_id,
                task_name=task_name,
                status=TaskStatus.RUNNING.value,
                manual_run=manual_run,
                start_time=start_time,
            )

            # Execute the actual task logic
            result_data = await func(self, *args, **kwargs)

            # Task completion on success
            end_time = datetime.now(UTC)
            runtime = (end_time - start_time).total_seconds() * 1000

            logger.info(
                "Task %s (%s) completed successfully. Runtime: %.0fms",
                task_name,
                celery_task_id,
                runtime,
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

            return result_data

        except Exception as e:
            # Task completion on failure
            end_time = datetime.now(UTC)
            runtime = (end_time - start_time).total_seconds() * 1000
            logger.exception(
                "Task %s (%s) failed: Error in %s: %s",
                task_name,
                celery_task_id,
                task_name,
                e,
            )

            await status_manager.update_status(
                task_name,
                TaskStatus.FAILED.value,
                error=str(e),
            )

            await update_task_history_entry(
                celery_task_id=celery_task_id,
                task_name=task_name,
                status=TaskStatus.FAILED.value,
                error=str(e),
                end_time=end_time,
                runtime_ms=runtime,
            )

            # Attempt retry if this is a retryable task
            try:
                # Default retry delay
                countdown = 60
                raise self.retry(exc=e, countdown=countdown)
            except Exception:
                # If retry fails or is not available, re-raise the original exception
                raise e

    return wrapper
