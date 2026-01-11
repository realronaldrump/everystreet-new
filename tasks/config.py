"""
Task configuration management functions.

This module provides functions for managing task configuration in the database,
including retrieving configuration, checking dependencies, and updating task history.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from beanie.operators import In
from celery.utils.log import get_task_logger

from db.models import TaskConfig, TaskHistory

logger = get_task_logger(__name__)


async def get_task_config() -> dict[str, Any]:
    """
    Retrieves all task configurations as a dictionary.

    Returns:
        A dictionary where the 'tasks' key contains a map of task_id to its configuration.
    """
    from tasks.core import TASK_METADATA, TaskStatus

    try:
        # Fetch all existing task configs
        all_configs = await TaskConfig.find_all().to_list()

        # Create a map for easy lookup
        config_map = {cfg.task_id: cfg for cfg in all_configs if cfg.task_id}

        tasks_output = {}

        for t_id, t_def in TASK_METADATA.items():
            if t_id in config_map:
                # Use existing config
                c = config_map[t_id]
                tasks_output[t_id] = {
                    "enabled": c.enabled,
                    "interval_minutes": c.interval_minutes,
                    "status": c.status,
                    "last_run": c.last_run,
                    "next_run": c.next_run,
                    # Retrieve the extra fields we stored in config dict
                    "last_error": c.config.get("last_error"),
                    "start_time": c.config.get("start_time"),
                    "end_time": c.config.get("end_time"),
                    "last_updated": c.last_updated,
                    "last_success_time": c.config.get("last_success_time"),
                }
            else:
                # Create default if missing
                default_interval = t_def["default_interval_minutes"]
                new_config = TaskConfig(
                    task_id=t_id,
                    enabled=True,
                    interval_minutes=default_interval,
                    status=TaskStatus.IDLE.value,
                    config={
                        "last_error": None,
                        "start_time": None,
                        "end_time": None,
                        "last_success_time": None,
                    },
                )
                await new_config.save()

                tasks_output[t_id] = {
                    "enabled": True,
                    "interval_minutes": default_interval,
                    "status": TaskStatus.IDLE.value,
                    "last_run": None,
                    "next_run": None,
                    "last_error": None,
                    "start_time": None,
                    "end_time": None,
                    "last_updated": None,
                    "last_success_time": None,
                }

        return {
            "disabled": False,  # Global disable flag logic might need a dedicated place if needed, or we assume False
            "tasks": tasks_output,
        }

    except Exception as e:
        logger.exception("Error getting task config: %s", e)
        return {
            "disabled": False,
            "tasks": {},
        }


async def check_dependencies(
    task_id: str,
) -> dict[str, Any]:
    """
    Checks if dependencies for a given task are met.

    Dependencies are considered met if they are not currently running
    or recently failed.

    Args:
        task_id: The identifier of the task to check dependencies for.

    Returns:
        A dictionary containing:
            'can_run': Boolean indicating if the task can run based on dependencies.
            'reason': String explaining why the task cannot run (if applicable).
    """
    from tasks.core import TASK_METADATA, TaskStatus

    try:
        if task_id not in TASK_METADATA:
            return {
                "can_run": False,
                "reason": f"Unknown task: {task_id}",
            }

        dependencies = TASK_METADATA[task_id].get("dependencies", [])
        if not dependencies:
            return {"can_run": True}

        # Query all dependencies at once
        dep_configs = await TaskConfig.find(
            In(TaskConfig.task_id, dependencies),
        ).to_list()
        dep_map = {d.task_id: d for d in dep_configs}

        for dep_id in dependencies:
            if dep_id not in dep_map:
                logger.warning(
                    "Task %s dependency %s not found in database.",
                    task_id,
                    dep_id,
                )
                continue

            dep_config = dep_map[dep_id]
            dep_status = dep_config.status

            if dep_status in [
                TaskStatus.RUNNING.value,
                TaskStatus.PENDING.value,
            ]:
                return {
                    "can_run": False,
                    "reason": f"Dependency '{dep_id}' is currently {dep_status}",
                }

            if dep_status == TaskStatus.FAILED.value:
                last_updated = dep_config.last_updated

                if last_updated and (
                    datetime.now(UTC) - last_updated < timedelta(hours=1)
                ):
                    return {
                        "can_run": False,
                        "reason": f"Dependency '{dep_id}' failed recently",
                    }

        return {"can_run": True}

    except Exception as e:
        logger.exception("Error checking dependencies for %s: %s", task_id, e)
        return {
            "can_run": False,
            "reason": f"Error checking dependencies: {e}",
        }


async def update_task_history_entry(
    celery_task_id: str,
    task_name: str,
    status: str,
    manual_run: bool = False,
    result: Any = None,
    error: str | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    runtime_ms: float | None = None,
):
    """
    Creates or updates an entry in the task history collection.

    Args:
        celery_task_id: The unique ID assigned by Celery to this task instance.
        task_name: The application-specific name of the task
            (e.g., 'periodic_fetch_trips').
        status: The current status of the task instance
            (e.g., 'RUNNING', 'COMPLETED', 'FAILED').
        manual_run: Boolean indicating if the task was triggered manually.
        result: The result of the task (if completed successfully).
        error: Error message if the task failed.
        start_time: Timestamp when the task started execution.
        end_time: Timestamp when the task finished execution.
        runtime_ms: Duration of the task execution in milliseconds.
    """
    try:
        now = datetime.now(UTC)

        history = await TaskHistory.get(celery_task_id)
        if history:
            history.task_id = task_name
            history.status = status
            history.timestamp = now
            history.manual_run = manual_run
        else:
            history = TaskHistory(
                id=celery_task_id,
                task_id=task_name,
                status=status,
                timestamp=now,
                manual_run=manual_run,
            )

        if start_time:
            history.start_time = start_time
        if end_time:
            history.end_time = end_time
        if runtime_ms is not None:
            try:
                history.runtime = float(runtime_ms)
            except (ValueError, TypeError):
                logger.warning(
                    "Could not convert runtime %s to float for %s",
                    runtime_ms,
                    celery_task_id,
                )
                history.runtime = None

        if result is not None:
            try:
                history.result = result
            except Exception as ser_err:
                logger.warning(
                    "Could not serialize result for %s (%s) history: %s",
                    task_name,
                    celery_task_id,
                    ser_err,
                )
                history.result = f"<Unserializable Result: {type(result).__name__}>"
        if error is not None:
            history.error = str(error)

        await history.save()
    except Exception as e:
        logger.exception(
            "Error updating task history for %s (%s): %s",
            celery_task_id,
            task_name,
            e,
        )
