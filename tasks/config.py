"""
Task configuration management functions.

This module provides functions for managing task configuration in the
database, including retrieving configuration, checking dependencies, and
updating task history.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from beanie.operators import In

from db.models import TaskConfig, TaskHistory
from tasks.registry import TASK_DEFINITIONS, get_dependencies

logger = logging.getLogger(__name__)

GLOBAL_TASK_ID = "__global__"


async def _get_or_create_task_config(task_id: str) -> TaskConfig:
    task_config = await TaskConfig.find_one(TaskConfig.task_id == task_id)
    if task_config:
        return task_config

    default_interval = int(
        TASK_DEFINITIONS.get(task_id, {}).get("default_interval_minutes", 0) or 0,
    )
    task_config = TaskConfig(
        task_id=task_id,
        enabled=True,
        interval_minutes=default_interval,
        config={
            "last_error": None,
            "last_success_time": None,
            "last_finished_at": None,
            "last_job_id": None,
        },
    )
    await task_config.save()
    return task_config


async def get_task_config_entry(task_id: str) -> TaskConfig:
    return await _get_or_create_task_config(task_id)


async def get_global_disable() -> bool:
    global_config = await TaskConfig.find_one(TaskConfig.task_id == GLOBAL_TASK_ID)
    if not global_config:
        return False
    return bool(global_config.config.get("disabled", False))


async def set_global_disable(disabled: bool) -> None:
    global_config = await TaskConfig.find_one(TaskConfig.task_id == GLOBAL_TASK_ID)
    if not global_config:
        global_config = TaskConfig(task_id=GLOBAL_TASK_ID, enabled=not disabled)
    global_config.config = global_config.config or {}
    global_config.config["disabled"] = bool(disabled)
    global_config.last_updated = datetime.now(UTC)
    await global_config.save()


async def get_task_config() -> dict[str, Any]:
    """
    Retrieves all task configurations as a dictionary.

    Returns:
        A dictionary where the 'tasks' key contains a map of task_id to its configuration.
    """
    try:
        # Fetch all existing task configs
        all_configs = await TaskConfig.find(
            {"task_id": {"$ne": GLOBAL_TASK_ID}},
        ).to_list()

        config_map = {cfg.task_id: cfg for cfg in all_configs if cfg.task_id}

        tasks_output: dict[str, Any] = {}

        for t_id, t_def in TASK_DEFINITIONS.items():
            if t_id in config_map:
                c = config_map[t_id]
            else:
                c = await _get_or_create_task_config(t_id)

            tasks_output[t_id] = {
                "enabled": c.enabled,
                "interval_minutes": c.interval_minutes,
                "last_run": c.last_run,
                "next_run": c.next_run,
                "last_error": c.config.get("last_error"),
                "last_success_time": c.config.get("last_success_time"),
                "last_finished_at": c.config.get("last_finished_at"),
                "last_job_id": c.config.get("last_job_id"),
                "last_updated": getattr(c, "last_updated", None),
                "manual_only": bool(t_def.get("manual_only", False)),
            }

        return {
            "disabled": await get_global_disable(),
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
    """
    try:
        if task_id not in TASK_DEFINITIONS:
            return {
                "can_run": False,
                "reason": f"Unknown task: {task_id}",
            }

        dependencies = get_dependencies(task_id)
        if not dependencies:
            return {"can_run": True}

        dep_histories = (
            await TaskHistory.find(
                In(TaskHistory.task_id, dependencies),
            )
            .sort(-TaskHistory.timestamp)
            .to_list()
        )

        latest_by_task: dict[str, TaskHistory] = {}
        for history in dep_histories:
            if history.task_id and history.task_id not in latest_by_task:
                latest_by_task[history.task_id] = history

        for dep_id in dependencies:
            history = latest_by_task.get(dep_id)
            if not history:
                continue

            dep_status = history.status or ""
            if dep_status in {"RUNNING", "PENDING"}:
                return {
                    "can_run": False,
                    "reason": f"Dependency '{dep_id}' is currently {dep_status}",
                }

            if dep_status == "FAILED":
                if history.timestamp and (
                    datetime.now(UTC) - history.timestamp < timedelta(hours=1)
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
    job_id: str,
    task_name: str,
    status: str,
    manual_run: bool = False,
    result: Any = None,
    error: str | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    runtime_ms: float | None = None,
) -> None:
    """
    Creates or updates an entry in the task history collection.
    """
    try:
        now = datetime.now(UTC)

        history = await TaskHistory.get(job_id)
        if history:
            history.task_id = task_name
            history.status = status
            history.timestamp = now
            history.manual_run = manual_run
        else:
            history = TaskHistory(
                id=job_id,
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
                    job_id,
                )
                history.runtime = None

        if result is not None:
            try:
                history.result = result
            except Exception as ser_err:
                logger.warning(
                    "Could not serialize result for %s (%s) history: %s",
                    task_name,
                    job_id,
                    ser_err,
                )
                history.result = f"<Unserializable Result: {type(result).__name__}>"
        if error is not None:
            history.error = str(error)

        await history.save()
    except Exception as e:
        logger.exception(
            "Error updating task history for %s (%s): %s",
            job_id,
            task_name,
            e,
        )


async def update_task_success(task_id: str, finished_at: datetime) -> None:
    task_config = await _get_or_create_task_config(task_id)
    task_config.config = task_config.config or {}
    task_config.last_run = finished_at
    task_config.last_updated = finished_at
    task_config.config["last_success_time"] = finished_at
    task_config.config["last_finished_at"] = finished_at
    task_config.config["last_error"] = None
    await task_config.save()


async def update_task_failure(task_id: str, error: str, finished_at: datetime) -> None:
    task_config = await _get_or_create_task_config(task_id)
    task_config.config = task_config.config or {}
    task_config.last_updated = finished_at
    task_config.config["last_error"] = error
    task_config.config["last_finished_at"] = finished_at
    await task_config.save()


async def set_last_job_id(task_id: str, job_id: str) -> None:
    task_config = await _get_or_create_task_config(task_id)
    task_config.config = task_config.config or {}
    task_config.config["last_job_id"] = job_id
    task_config.config["last_error"] = None
    task_config.last_updated = datetime.now(UTC)
    await task_config.save()


async def update_task_schedule(task_config_update: dict[str, Any]) -> dict[str, Any]:
    """
    Updates the task scheduling configuration (enabled status, interval) in the
    database.
    """
    try:
        changes: list[str] = []

        global_disable_update = task_config_update.get("globalDisable")
        if isinstance(global_disable_update, bool):
            await set_global_disable(global_disable_update)
            changes.append(f"Global scheduling disable set to {global_disable_update}")

        tasks_update = task_config_update.get("tasks", {})
        if tasks_update:
            for task_id, settings in tasks_update.items():
                if task_id not in TASK_DEFINITIONS:
                    logger.warning(
                        "Attempted to update configuration for unknown task: %s",
                        task_id,
                    )
                    continue

                task_config = await _get_or_create_task_config(task_id)

                if "enabled" in settings:
                    new_val = settings["enabled"]
                    if isinstance(new_val, bool):
                        old_val = task_config.enabled
                        if new_val != old_val:
                            task_config.enabled = new_val
                            changes.append(
                                f"Task '{task_id}' enabled status: {old_val} -> {new_val}",
                            )
                    else:
                        logger.warning(
                            "Ignoring non-boolean value for enabled status of task '%s': %s",
                            task_id,
                            new_val,
                        )

                if "interval_minutes" in settings:
                    try:
                        new_val = int(settings["interval_minutes"])
                        if new_val < 0:
                            logger.warning(
                                "Ignoring invalid interval < 0 for task '%s': %s",
                                task_id,
                                new_val,
                            )
                            continue
                    except (ValueError, TypeError):
                        logger.warning(
                            "Ignoring non-integer interval for task '%s': %s",
                            task_id,
                            settings["interval_minutes"],
                        )
                        continue

                    old_val = task_config.interval_minutes
                    if new_val != old_val:
                        task_config.interval_minutes = new_val
                        changes.append(
                            f"Task '{task_id}' interval: {old_val} -> {new_val} mins",
                        )

                await task_config.save()

        if not changes:
            logger.info("No valid configuration changes detected in update request.")
            return {
                "status": "success",
                "message": "No valid configuration changes detected.",
            }

        logger.info("Task configuration updated: %s", "; ".join(changes))
        return {
            "status": "success",
            "message": "Task configuration updated successfully.",
            "changes": changes,
        }

    except Exception as e:
        logger.exception("Error updating task schedule: %s", e)
        return {
            "status": "error",
            "message": f"Error updating task schedule: {e}",
        }
