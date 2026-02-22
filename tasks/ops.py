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

_TRIP_SYNC_MUTEX_TASK_IDS = {
    "periodic_fetch_trips",
    "manual_fetch_trips_range",
    "fetch_all_missing_trips",
    "fetch_trip_by_transaction_id",
}
_TRIP_SYNC_LOCK_KEY = "locks:trip_sync_ingest"
_TRIP_SYNC_LOCK_DEFAULT_TTL_SECONDS = 15 * 60
_TRIP_SYNC_LOCK_TTL_SECONDS_BY_TASK_ID: dict[str, int] = {
    "periodic_fetch_trips": 20 * 60,
    "manual_fetch_trips_range": 8 * 60 * 60,
    "fetch_all_missing_trips": 26 * 60 * 60,
    "fetch_trip_by_transaction_id": 20 * 60,
}
_TRIP_SYNC_LOCK_RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


def _get_job_id(ctx: dict[str, Any]) -> str:
    job_id = None
    if isinstance(ctx, dict):
        job_id = ctx.get("job_id") or ctx.get("id")
    return job_id or str(uuid.uuid4())


def _decode_redis_value(value: Any) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="replace")
        except Exception:
            return "<bytes>"
    return str(value)


async def _acquire_trip_sync_lock(
    *,
    task_id: str,
    job_id: str,
) -> tuple[tuple[str, str] | None, str | None]:
    """
    Try to acquire a cross-task trip-ingest mutex.

    Returns:
        (lock_handle, holder)
        - lock_handle: (key, token) when acquired
        - holder: lock owner string when acquisition was blocked
    """
    lock_ttl = int(
        _TRIP_SYNC_LOCK_TTL_SECONDS_BY_TASK_ID.get(
            task_id,
            _TRIP_SYNC_LOCK_DEFAULT_TTL_SECONDS,
        ),
    )
    lock_ttl = max(30, lock_ttl)
    lock_token = f"{task_id}:{job_id}:{uuid.uuid4()}"

    try:
        redis = await get_arq_pool()
        acquired = await redis.set(
            _TRIP_SYNC_LOCK_KEY,
            lock_token,
            ex=lock_ttl,
            nx=True,
        )
    except Exception:
        # Fail-open if lock plumbing itself is unavailable.
        logger.exception("Failed to acquire trip-ingest mutex for task %s", task_id)
        return None, None
    if acquired:
        return (_TRIP_SYNC_LOCK_KEY, lock_token), None
    try:
        current_holder = await redis.get(_TRIP_SYNC_LOCK_KEY)
    except Exception:
        current_holder = None
    holder = (
        _decode_redis_value(current_holder)
        if current_holder is not None
        else "unknown"
    )
    return None, holder


async def _release_trip_sync_lock(lock_handle: tuple[str, str]) -> None:
    lock_key, lock_token = lock_handle
    try:
        redis = await get_arq_pool()
        await redis.eval(_TRIP_SYNC_LOCK_RELEASE_SCRIPT, 1, lock_key, lock_token)
    except Exception:
        logger.exception("Failed to release trip-ingest mutex for key %s", lock_key)


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
    lock_handle: tuple[str, str] | None = None

    if task_id in _TRIP_SYNC_MUTEX_TASK_IDS:
        lock_handle, lock_holder = await _acquire_trip_sync_lock(
            task_id=task_id,
            job_id=job_id,
        )
        if lock_holder is not None:
            skip_result = {
                "status": "skipped",
                "reason": "trip_sync_locked",
                "message": (
                    "Skipped trip sync task because another trip-ingest job is running."
                ),
                "lock_holder": lock_holder,
                "task_id": task_id,
            }
            await update_task_history_entry(
                job_id=job_id,
                task_name=task_id,
                status="COMPLETED",
                manual_run=manual_run,
                result=skip_result,
                start_time=start_time,
                end_time=start_time,
                runtime_ms=0.0,
            )
            logger.info(
                "Skipped %s due to active trip-ingest mutex held by %s",
                task_id,
                lock_holder,
            )
            return skip_result

    try:
        await update_task_history_entry(
            job_id=job_id,
            task_name=task_id,
            status="RUNNING",
            manual_run=manual_run,
            start_time=start_time,
        )

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
    finally:
        if lock_handle is not None:
            await _release_trip_sync_lock(lock_handle)

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
