"""
Task scheduler for triggering background tasks.

This module provides the main scheduler that runs periodically and
triggers other tasks based on their configured schedules and
dependencies.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from celery import shared_task
from celery.utils.log import get_task_logger

from celery_app import app as celery_app
from core.async_bridge import run_async_from_sync
from date_utils import parse_timestamp
from tasks.config import check_dependencies, get_task_config, update_task_history_entry
from tasks.core import TaskStatus, TaskStatusManager

logger = get_task_logger(__name__)


async def run_task_scheduler_async() -> None:
    """
    Async logic for the main task scheduler.

    This task runs periodically (e.g., every minute) and triggers other tasks
    based on their configured schedules and dependencies.

    Note: This function does NOT use the task_runner decorator because it has
    different behavior - it doesn't update its own status in the same way.
    """
    triggered_count = 0
    skipped_count = 0
    now_utc = datetime.now(UTC)
    logger.debug("Scheduler task running at %s", now_utc.isoformat())
    status_manager = TaskStatusManager.get_instance()

    try:
        config = await get_task_config()

        if not config or config.get("disabled", False):
            logger.info(
                "Task scheduling is globally disabled. Exiting scheduler task.",
            )
            return

        tasks_to_check = config.get("tasks", {})

        task_name_mapping = {
            "periodic_fetch_trips": "tasks.periodic_fetch_trips",
            "cleanup_stale_trips": "tasks.cleanup_stale_trips",
            "validate_trips": "tasks.validate_trips",
            "remap_unmatched_trips": "tasks.remap_unmatched_trips",
            "update_coverage_for_new_trips": "tasks.update_coverage_for_new_trips",
        }

        tasks_to_trigger = []

        for task_id, task_config in tasks_to_check.items():
            if task_id not in task_name_mapping:
                logger.debug(
                    "Skipping unknown task_id '%s' found in config during scheduling.",
                    task_id,
                )
                continue

            is_enabled = task_config.get("enabled", True)
            current_status = task_config.get("status")
            interval_minutes = task_config.get("interval_minutes")

            if not is_enabled:
                logger.debug("Task '%s' skipped (disabled).", task_id)
                skipped_count += 1
                continue
            if current_status == TaskStatus.RUNNING.value:
                logger.debug("Task '%s' skipped (already running).", task_id)
                skipped_count += 1
                continue
            if current_status == TaskStatus.PENDING.value:
                logger.debug("Task '%s' skipped (already pending).", task_id)
                skipped_count += 1
                continue
            if interval_minutes is None or interval_minutes <= 0:
                logger.debug(
                    "Task '%s' skipped (invalid or zero interval: %s).",
                    task_id,
                    interval_minutes,
                )
                skipped_count += 1
                continue

            last_run_any = task_config.get("last_run")
            last_run = parse_timestamp(last_run_any)
            if last_run_any and not last_run:
                logger.warning(
                    "Could not parse last_run timestamp '%s' for task '%s'.",
                    last_run_any,
                    task_id,
                )

            is_due = False
            if last_run is None:
                is_due = True
                logger.debug("Task '%s' is due (never run).", task_id)
            else:
                next_due_time = last_run + timedelta(minutes=interval_minutes)
                if now_utc >= next_due_time:
                    is_due = True
                    logger.debug(
                        "Task '%s' is due (Last run: %s, Interval: %dm, Due: %s)",
                        task_id,
                        last_run.isoformat(),
                        interval_minutes,
                        next_due_time.isoformat(),
                    )

            if is_due:
                dependency_check = await check_dependencies(task_id)
                if dependency_check["can_run"]:
                    tasks_to_trigger.append(task_id)
                else:
                    logger.warning(
                        "Task '%s' is due but dependencies not met: %s",
                        task_id,
                        dependency_check.get("reason"),
                    )
                    skipped_count += 1
            else:
                skipped_count += 1

        if not tasks_to_trigger:
            logger.debug("No tasks due to trigger this scheduler cycle.")
            return

        logger.info(
            "Scheduler identified %d tasks to trigger: %s",
            len(tasks_to_trigger),
            ", ".join(tasks_to_trigger),
        )

        for task_id_to_run in tasks_to_trigger:
            try:
                celery_task_name = task_name_mapping[task_id_to_run]

                celery_task_id = f"{task_id_to_run}_scheduled_{uuid.uuid4()}"

                celery_app.send_task(
                    celery_task_name,
                    task_id=celery_task_id,
                    queue="default",
                )

                await status_manager.update_status(
                    task_id_to_run,
                    TaskStatus.PENDING.value,
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
                    "Triggered task '%s' -> Celery task '%s' (ID: %s)",
                    task_id_to_run,
                    celery_task_name,
                    celery_task_id,
                )

                await asyncio.sleep(0.1)

            except Exception as trigger_err:
                logger.error(
                    "Failed to trigger task '%s': %s",
                    task_id_to_run,
                    trigger_err,
                    exc_info=True,
                )
                await status_manager.update_status(
                    task_id_to_run,
                    TaskStatus.FAILED.value,
                    error=f"Scheduler trigger failed: {trigger_err}",
                )

        logger.info(
            "Scheduler finished. Triggered: %d, Skipped: %d",
            triggered_count,
            skipped_count,
        )
        return

    except Exception as e:
        logger.exception("CRITICAL ERROR in run_task_scheduler_async: %s", e)
        raise


@shared_task(
    bind=True,
    name="tasks.run_task_scheduler",
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
)
def run_task_scheduler(_self, *_args, **_kwargs) -> None:
    """Celery task wrapper for the main task scheduler."""
    run_async_from_sync(run_task_scheduler_async())
