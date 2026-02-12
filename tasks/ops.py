"""Task execution helpers for ARQ jobs."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from tasks.arq import get_arq_pool
from tasks.config import (
    check_dependencies,
    get_global_disable,
    get_task_config_entry,
    set_last_job_id,
    update_task_failure,
    update_task_history_entry,
    update_task_success,
)
from tasks.registry import is_manual_only

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from arq.connections import ArqRedis

logger = logging.getLogger(__name__)


def _get_job_id(ctx: dict[str, Any]) -> str:
    job_id = None
    if isinstance(ctx, dict):
        job_id = ctx.get("job_id") or ctx.get("id")
    return job_id or str(uuid.uuid4())


async def enqueue_task(
    task_id: str,
    *args: Any,
    manual_run: bool = False,
    **kwargs: Any,
) -> dict[str, Any]:
    """Enqueue a task and record a pending history entry."""
    redis = await get_arq_pool()
    job_kwargs = dict(kwargs)
    job_kwargs.setdefault("manual_run", manual_run)
    job = await redis.enqueue_job(task_id, *args, **job_kwargs)
    job_id = getattr(job, "job_id", None) or getattr(job, "id", None) or str(job)
    now = datetime.now(UTC)

    await set_last_job_id(task_id, job_id)
    await update_task_history_entry(
        job_id=job_id,
        task_name=task_id,
        status="PENDING",
        manual_run=manual_run,
        start_time=now,
    )

    return {
        "job_id": job_id,
        "status": "success",
    }


async def run_task_with_history(
    ctx: dict[str, Any],
    task_id: str,
    func: Callable[[], Awaitable[dict[str, Any]]],
    *,
    manual_run: bool = False,
) -> dict[str, Any]:
    """Run task logic with history and config updates."""
    job_id = _get_job_id(ctx)
    start_time = datetime.now(UTC)

    await update_task_history_entry(
        job_id=job_id,
        task_name=task_id,
        status="RUNNING",
        manual_run=manual_run,
        start_time=start_time,
    )

    try:
        result_data = await func()
    except asyncio.CancelledError:
        end_time = datetime.now(UTC)
        runtime_ms = (end_time - start_time).total_seconds() * 1000
        await update_task_history_entry(
            job_id=job_id,
            task_name=task_id,
            status="CANCELLED",
            manual_run=manual_run,
            error="Task cancelled before completion.",
            end_time=end_time,
            runtime_ms=runtime_ms,
        )
        logger.warning("Task %s cancelled", task_id)
        raise
    except Exception as exc:
        end_time = datetime.now(UTC)
        runtime_ms = (end_time - start_time).total_seconds() * 1000
        await update_task_history_entry(
            job_id=job_id,
            task_name=task_id,
            status="FAILED",
            manual_run=manual_run,
            error=str(exc),
            end_time=end_time,
            runtime_ms=runtime_ms,
        )
        await update_task_failure(task_id, str(exc), end_time)
        logger.exception("Task %s failed", task_id)
        raise

    end_time = datetime.now(UTC)
    runtime_ms = (end_time - start_time).total_seconds() * 1000
    await update_task_history_entry(
        job_id=job_id,
        task_name=task_id,
        status="COMPLETED",
        manual_run=manual_run,
        result=result_data,
        end_time=end_time,
        runtime_ms=runtime_ms,
    )
    await update_task_success(task_id, end_time)
    return result_data


async def run_task_if_due(
    _ctx: dict[str, Any],
    task_id: str,
    func: Callable[[], Awaitable[dict[str, Any]]],
    *,
    manual_run: bool = False,
) -> dict[str, Any] | None:
    """Run a task only if it is due based on config, dependencies, and global state."""
    if await get_global_disable():
        logger.info("Skipping %s (globally disabled)", task_id)
        return None

    if is_manual_only(task_id):
        logger.info("Skipping %s (manual only)", task_id)
        return None

    task_config = await get_task_config_entry(task_id)
    if not task_config.enabled:
        logger.info("Skipping %s (disabled)", task_id)
        return None

    interval_minutes = task_config.interval_minutes
    if interval_minutes is None or interval_minutes <= 0:
        logger.info("Skipping %s (interval not configured)", task_id)
        return None

    last_run = task_config.last_run
    now = datetime.now(UTC)
    if last_run:
        next_due = last_run + timedelta(minutes=interval_minutes)
        if now < next_due:
            return None

    dependency_check = await check_dependencies(task_id)
    if not dependency_check.get("can_run", False):
        logger.info(
            "Skipping %s (dependency check failed): %s",
            task_id,
            dependency_check.get("reason"),
        )
        return None

    if manual_run:
        logger.debug("Running %s as manual run", task_id)
    return await func()


async def abort_job(job_id: str) -> bool:
    """Request an ARQ job abort by job id."""
    redis: ArqRedis = await get_arq_pool()

    # arq 0.26.x exposes abort on Job instances, not on the redis pool.
    try:
        from arq.jobs import Job as ArqJob

        job = ArqJob(job_id, redis)
        try:
            # We want to send the abort signal without blocking the API for long.
            # If the abort isn't confirmed quickly, treat it as "requested".
            return await job.abort(timeout=0.5)
        except TimeoutError:
            return True
    except Exception:
        logger.exception("Failed to abort ARQ job %s", job_id)
        return False
