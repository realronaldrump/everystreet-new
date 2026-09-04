"""Redis-only completion intents; all history is fetched through Bouncie ingest."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta

from arq import Retry
from arq.constants import result_key_prefix
from arq.jobs import Job as ArqJob
from fastapi import HTTPException

from db.models import Trip
from tasks.arq import get_arq_pool

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 8
RETENTION_SECONDS = 24 * 60 * 60
STATUS_INDEX = "trips:completion-sync:index"
STATUS_PREFIX = "trips:completion-sync:status:"


def sync_job_id(transaction_id: str) -> str:
    return "completed-trip:" + hashlib.sha256(transaction_id.encode()).hexdigest()


async def _set_status(
    transaction_id: str, state: str, *, attempt: int = 0, error: str | None = None
) -> None:
    redis = await get_arq_pool()
    now = datetime.now(UTC)
    key = STATUS_PREFIX + sync_job_id(transaction_id)
    await redis.set(
        key,
        json.dumps(
            {
                "transaction_id": transaction_id,
                "state": state,
                "attempt": attempt,
                "error": error,
                "updated_at": now.isoformat(),
            }
        ),
        ex=RETENTION_SECONDS,
    )
    await redis.zadd(STATUS_INDEX, {key: now.timestamp()})


async def enqueue_completed_trip_sync(
    transaction_id: str, *, force: bool = False
) -> bool:
    tx = str(transaction_id or "").strip()
    if not tx:
        raise ValueError("Historical fetch requires a transaction ID")
    redis = await get_arq_pool()
    job_id = sync_job_id(tx)
    if force:
        await redis.delete(result_key_prefix + job_id)
    job = await redis.enqueue_job(
        "sync_completed_trip",
        tx,
        _job_id=job_id,
        _defer_by=timedelta(seconds=15),
        _expires=timedelta(seconds=RETENTION_SECONDS),
    )
    if job is not None:
        await _set_status(tx, "queued")
    return job is not None


async def sync_completed_trip(ctx: dict, transaction_id: str) -> dict:
    from admin.services.admin_service import AdminService
    from tasks.config import get_global_disable, get_task_config_entry
    from trips.services.bouncie_ingest_runtime import run_ingest_for_transaction_id

    attempt = int(ctx.get("job_try", 1))
    try:
        async with asyncio.timeout(100):
            config = await get_task_config_entry("periodic_fetch_trips")
            if await get_global_disable() or config.enabled is False:
                await _set_status(transaction_id, "paused")
                return {"status": "paused"}
            await _set_status(transaction_id, "processing", attempt=attempt)
            settings = await AdminService.get_persisted_app_settings()
            result = await run_ingest_for_transaction_id(
                transaction_id=transaction_id,
                mode="upsert_bouncie",
                do_map_match=bool(settings.mapMatchTripsOnFetch),
                do_coverage=True,
                sync_mobility=True,
            )
            trip = await Trip.find_one(
                {"transactionId": transaction_id, "source": "bouncie"}
            )
            if trip is None:
                if result.get("counters", {}).get("validation_failed", 0):
                    raise ValueError(  # noqa: TRY301
                        "Bouncie trip failed validation. Review the trip import issues before retrying."
                    )
                raise LookupError(  # noqa: TRY301
                    "Bouncie has not made the completed trip available yet"
                )
    except Exception as exc:
        permanent = isinstance(exc, ValueError) or (
            isinstance(exc, HTTPException)
            and 400 <= exc.status_code < 500
            and exc.status_code not in {404, 408, 429}
        )
        error = str(exc)[:500] or type(exc).__name__
        if attempt >= MAX_ATTEMPTS or permanent:
            await _set_status(transaction_id, "failed", attempt=attempt, error=error)
            logger.warning(
                "Completed trip fetch failed for %s: %s", transaction_id, error
            )
            return {"status": "failed", "error": error}
        await _set_status(transaction_id, "retrying", attempt=attempt, error=error)
        raise Retry(defer=min(300, 15 * 2 ** (attempt - 1))) from exc
    await _set_status(transaction_id, "complete", attempt=attempt)
    return {"status": "complete", "transaction_id": transaction_id}


async def completion_sync_status() -> dict:
    redis = await get_arq_pool()
    await redis.zremrangebyscore(
        STATUS_INDEX, "-inf", datetime.now(UTC).timestamp() - RETENTION_SECONDS
    )
    keys = await redis.zrange(STATUS_INDEX, 0, -1)
    rows = [json.loads(raw) for raw in await redis.mget(keys) if raw] if keys else []
    for row in rows:
        if row["state"] not in {"queued", "processing", "retrying"}:
            continue
        age = datetime.now(UTC) - datetime.fromisoformat(row["updated_at"])
        if age.total_seconds() < 120:
            continue
        result = await ArqJob(
            sync_job_id(row["transaction_id"]), redis=redis
        ).result_info()
        if result is not None:
            state = (
                result.result.get("status")
                if result.success and isinstance(result.result, dict)
                else "failed"
            )
            if state not in {"complete", "paused"}:
                state = "failed"
            await _set_status(
                row["transaction_id"],
                state,
                attempt=row["attempt"],
                error="Drive sync stopped before finishing. Retry updates to resume."
                if state == "failed"
                else None,
            )
            row["state"] = state
    return {
        "pending": sum(
            row["state"] in {"queued", "processing", "retrying"} for row in rows
        ),
        "failed": sum(row["state"] == "failed" for row in rows),
        "failures": [row for row in rows if row["state"] == "failed"],
    }


async def retry_failed_completion_syncs() -> int:
    status = await completion_sync_status()
    count = 0
    for row in status["failures"]:
        count += int(
            await enqueue_completed_trip_sync(row["transaction_id"], force=True)
        )
    return count
