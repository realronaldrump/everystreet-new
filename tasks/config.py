"""Task configuration management functions.

This module provides functions for managing task configuration in the database,
including retrieving configuration, checking dependencies, and updating task history.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from celery.utils.log import get_task_logger

from date_utils import parse_timestamp
from db import (find_one_with_retry, serialize_document,
                task_config_collection, task_history_collection,
                update_one_with_retry)

# Import only for type checking to avoid circular dependency
# (tasks.core imports from tasks.config inside task_runner decorator)

logger = get_task_logger(__name__)


async def get_task_config() -> dict[str, Any]:
    """Retrieves the global task configuration document from the database.

    If the document doesn't exist, it creates a default configuration based
    on TASK_METADATA. It also ensures that all tasks defined in TASK_METADATA
    have a corresponding entry in the configuration.

    Returns:
        The task configuration dictionary. Returns a default structure on error.
    """
    # Import here to avoid circular dependency
    from tasks.core import TASK_METADATA, TaskStatus

    try:
        cfg = await find_one_with_retry(
            task_config_collection,
            {"_id": "global_background_task_config"},
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

            for (
                t_id,
                t_def,
            ) in TASK_METADATA.items():
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
        logger.exception("Error getting task config: %s", e)
        return {
            "_id": "global_background_task_config",
            "disabled": False,
            "tasks": {},
        }


async def check_dependencies(
    task_id: str,
) -> dict[str, Any]:
    """Checks if the dependencies for a given task are met.

    Dependencies are considered met if they are not currently running
    or recently failed.

    Args:
        task_id: The identifier of the task to check dependencies for.

    Returns:
        A dictionary containing:
            'can_run': Boolean indicating if the task can run based on dependencies.
            'reason': String explaining why the task cannot run (if applicable).
    """
    # Import here to avoid circular dependency
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
        result: The result of the task (if completed successfully). Will be serialized.
        error: Error message if the task failed.
        start_time: Timestamp when the task started execution.
        end_time: Timestamp when the task finished execution.
        runtime_ms: Duration of the task execution in milliseconds.
    """
    try:
        now = datetime.now(UTC)
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
                    "Could not convert runtime %s to float for %s",
                    runtime_ms,
                    celery_task_id,
                )
                update_fields["runtime"] = None

        if result is not None:
            try:
                serialized_result = serialize_document(
                    {"result": result},
                )["result"]
                update_fields["result"] = serialized_result
            except Exception as ser_err:
                logger.warning(
                    "Could not serialize result for %s (%s) history: %s",
                    task_name,
                    celery_task_id,
                    ser_err,
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
            "Error updating task history for %s (%s): %s",
            celery_task_id,
            task_name,
            e,
        )
