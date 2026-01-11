"""Task configuration management functions.

This module provides functions for managing task configuration in the database,
including retrieving configuration, checking dependencies, and updating task history.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from celery.utils.log import get_task_logger

from date_utils import parse_timestamp
from db.models import TaskConfig, TaskHistory
from db import db_manager

logger = get_task_logger(__name__)


async def get_task_config() -> dict[str, Any]:
    """Retrieves global task configuration document from database.

    If document doesn't exist, it creates a default configuration based
    on TASK_METADATA. It also ensures that all tasks defined in TASK_METADATA
    have a corresponding entry in the configuration.

    Returns:
        The task configuration dictionary. Returns a default structure on error.
    """
    from tasks.core import TASK_METADATA, TaskStatus

    try:
        cfg = await TaskConfig.get("global_background_task_config")

        if not cfg:
            logger.info("No task config found, creating default.")
            cfg_dict = {
                "id": "global_background_task_config",
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
            await TaskConfig(**cfg_dict).insert()
            cfg_dict["_id"] = cfg_dict.pop("id")
            return cfg_dict

        cfg_dict = cfg.model_dump()
        cfg_dict["_id"] = cfg_dict.pop("id")

        updated = False
        if "tasks" not in cfg_dict:
            cfg_dict["tasks"] = {}
            updated = True

        for t_id, t_def in TASK_METADATA.items():
            if t_id not in cfg_dict["tasks"]:
                cfg_dict["tasks"][t_id] = {
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
            await TaskConfig(
                id="global_background_task_config",
                disabled=cfg_dict["disabled"],
                tasks=cfg_dict["tasks"],
            ).save()

        return cfg_dict
    except Exception as e:
        logger.exception("Error getting task config: %s", e)
        return {
            "_id": "global_background_task_config",
            "disabled": False,
            "tasks": {},
        }


async def check_dependencies(
    task_id: str,
) -> dict[str, Any]:
    """Checks if dependencies for a given task are met.

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

        config = await get_task_config()
        tasks_config = config.get("tasks", {})

        for dep_id in dependencies:
            if dep_id not in tasks_config:
                logger.warning(
                    "Task %s dependency %s not found in configuration.",
                    task_id,
                    dep_id,
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
                last_updated = parse_timestamp(last_updated_any)

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
    """Creates or updates an entry in the task history collection.

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
