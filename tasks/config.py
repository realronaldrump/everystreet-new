"""
Task configuration management functions.

This module provides functions for managing task configuration in the
database, including retrieving configuration, checking dependencies, and
updating task history.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from db.models import TaskConfig, TaskHistory
from tasks.registry import TASK_DEFINITIONS, get_dependencies, is_enabled_by_default

logger = logging.getLogger(__name__)

GLOBAL_TASK_ID = "__global__"


async def get_latest_task_history(task_ids: list[str]) -> dict[str, TaskHistory]:
    """Return only the newest history entry for each requested task.

    The task-history index is ordered by ``task_id`` and descending
    ``timestamp``. Querying one task at a time with a limit of one lets MongoDB
    satisfy each lookup from the first index entry instead of loading every
    historical execution and discarding all but the newest one in Python.
    """
    unique_task_ids = list(dict.fromkeys(task_id for task_id in task_ids if task_id))
    if not unique_task_ids:
        return {}

    async def get_latest(task_id: str) -> TaskHistory | None:
        entries = (
            await TaskHistory.find(TaskHistory.task_id == task_id)
            .sort(-TaskHistory.timestamp)
            .limit(1)
            .to_list()
        )
        return entries[0] if entries else None

    entries = await asyncio.gather(*(get_latest(task_id) for task_id in unique_task_ids))
    return {entry.task_id: entry for entry in entries if entry and entry.task_id}


async def _get_or_create_task_config(task_id: str) -> TaskConfig:
    task_config = await TaskConfig.find_one(TaskConfig.task_id == task_id)

    if task_config:
        definition = TASK_DEFINITIONS.get(task_id, {})
        if definition:
            default_interval = int(definition["default_interval_minutes"])
            if not task_config.enabled or task_config.interval_minutes != default_interval:
                task_config.enabled = True
                task_config.interval_minutes = default_interval
                task_config.last_updated = datetime.now(UTC)
                await task_config.save()
                logger.info(
                    "Reconciled automatic task policy for %s (interval=%dm)",
                    task_id,
                    default_interval,
                )
        return task_config

    default_interval = int(
        TASK_DEFINITIONS.get(task_id, {}).get("default_interval_minutes", 0) or 0,
    )
    task_config = TaskConfig(
        task_id=task_id,
        enabled=is_enabled_by_default(task_id),
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
    """Automatic correctness work cannot be disabled from product state."""
    return False


async def set_global_disable(disabled: bool) -> None:
    if disabled:
        msg = "Automatic reconciliation cannot be disabled from the application."
        raise ValueError(msg)

    legacy = await TaskConfig.find_one(TaskConfig.task_id == GLOBAL_TASK_ID)
    if legacy:
        await legacy.delete()


async def reconcile_automatic_task_configs() -> None:
    """Converge persisted scheduler state to the immutable operating policy."""
    legacy = await TaskConfig.find_one(TaskConfig.task_id == GLOBAL_TASK_ID)
    if legacy:
        await legacy.delete()
    for task_id in TASK_DEFINITIONS:
        await _get_or_create_task_config(task_id)


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
        latest_history = await get_latest_task_history(list(TASK_DEFINITIONS))

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
                "waiting_reason": c.config.get("waiting_reason"),
                "retry_after": c.config.get("retry_after"),
                "consecutive_failures": c.config.get("consecutive_failures", 0),
                "status": (
                    latest_history[t_id].status
                    if t_id in latest_history
                    else c.status
                ),
                "last_updated": getattr(c, "last_updated", None),
                "manual_only": bool(t_def.get("manual_only", False)),
            }

        return {
            "disabled": await get_global_disable(),
            "tasks": tasks_output,
        }

    except Exception:
        logger.exception("Error getting task config")
        raise


async def check_dependencies(
    task_id: str,
) -> dict[str, Any]:
    """
    Checks if dependencies for a given task are met.

    Dependencies are considered met if they are not currently running or
    recently failed.
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

        latest_by_task = await get_latest_task_history(dependencies)

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

            if (
                dep_status == "FAILED"
                and history.timestamp
                and (datetime.now(UTC) - history.timestamp < timedelta(hours=1))
            ):
                return {
                    "can_run": False,
                    "reason": f"Dependency '{dep_id}' failed recently",
                }

        can_run = {"can_run": True}

    except Exception as e:
        logger.exception("Error checking dependencies for %s", task_id)
        return {
            "can_run": False,
            "reason": f"Error checking dependencies: {e}",
        }
    else:
        return can_run


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
    """Creates or updates an entry in the task history collection."""
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
    except Exception:
        logger.exception(
            "Error updating task history for %s (%s)",
            job_id,
            task_name,
        )


async def update_task_success(task_id: str, finished_at: datetime) -> None:
    task_config = await _get_or_create_task_config(task_id)
    task_config.config = task_config.config or {}
    task_config.last_run = finished_at
    task_config.last_updated = finished_at
    task_config.config["last_success_time"] = finished_at
    task_config.config["last_finished_at"] = finished_at
    task_config.config["last_error"] = None
    task_config.config["consecutive_failures"] = 0
    task_config.config["retry_after"] = None
    task_config.config["waiting_reason"] = None
    await task_config.save()


async def update_task_failure(task_id: str, error: str, finished_at: datetime) -> None:
    task_config = await _get_or_create_task_config(task_id)
    task_config.config = task_config.config or {}
    task_config.last_updated = finished_at
    task_config.config["last_error"] = error
    task_config.config["last_finished_at"] = finished_at
    failures = int(task_config.config.get("consecutive_failures", 0) or 0) + 1
    retry_delay_minutes = min(360, 5 * (2 ** min(failures - 1, 6)))
    task_config.config["consecutive_failures"] = failures
    task_config.config["retry_after"] = finished_at + timedelta(
        minutes=retry_delay_minutes,
    )
    await task_config.save()


async def update_task_waiting(
    task_id: str,
    reason: str,
    finished_at: datetime,
) -> None:
    """Record a healthy wait for an external user-owned prerequisite."""
    task_config = await _get_or_create_task_config(task_id)
    task_config.config = task_config.config or {}
    task_config.last_run = finished_at
    task_config.last_updated = finished_at
    task_config.config["last_finished_at"] = finished_at
    task_config.config["last_error"] = None
    task_config.config["waiting_reason"] = reason
    task_config.config["retry_after"] = None
    task_config.config["consecutive_failures"] = 0
    await task_config.save()


async def set_last_job_id(task_id: str, job_id: str) -> None:
    task_config = await _get_or_create_task_config(task_id)
    task_config.config = task_config.config or {}
    task_config.config["last_job_id"] = job_id
    task_config.config["last_error"] = None
    task_config.last_updated = datetime.now(UTC)
    await task_config.save()


async def update_task_schedule(task_config_update: dict[str, Any]) -> dict[str, Any]:
    """Preserve compatibility for internal callers without accepting policy changes."""
    del task_config_update
    await reconcile_automatic_task_configs()
    return {
        "status": "success",
        "message": "Automatic task policy is managed by the application.",
        "changes": [],
    }
