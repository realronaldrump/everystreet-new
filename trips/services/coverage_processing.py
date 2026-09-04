"""Durable, leased coverage work attached to authoritative Historical Trips."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from beanie import PydanticObjectId
from pymongo import ReturnDocument

from db.models import Trip

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 8
PROCESSING_TIMEOUT_SECONDS = 240
LEASE_SECONDS = PROCESSING_TIMEOUT_SECONDS + 60
BATCH_SIZE = 5


def prepare_coverage_work(trip: Trip) -> None:
    """Include the work marker in the same write that persists the trip."""
    if trip.coverage_emitted_at or trip.coverage_status in {
        "pending",
        "running",
        "retry",
        "failed",
    }:
        return
    trip.coverage_status = "pending" if trip.gps else "skipped"
    trip.coverage_attempts = 0
    trip.coverage_next_attempt_at = None
    trip.coverage_error = None


def due_coverage_query(now: datetime) -> dict[str, Any]:
    return {
        "coverage_status": {"$in": ["pending", "retry", "running"]},
        "$and": [
            {
                "$or": [
                    {"coverage_next_attempt_at": None},
                    {"coverage_next_attempt_at": {"$lte": now}},
                ]
            },
            {
                "$or": [
                    {"coverage_lease_until": None},
                    {"coverage_lease_until": {"$lte": now}},
                ]
            },
        ],
    }


async def notify_coverage_updated() -> None:
    from core.redis import get_shared_redis
    from core.trip_map_cache import TRIP_MAP_REVISION_KEY

    redis = await get_shared_redis()
    await redis.incr(TRIP_MAP_REVISION_KEY)


async def process_pending_trip_coverage(
    trip_id: PydanticObjectId,
    *,
    coverage_service=None,
) -> bool:
    """Claim, process and acknowledge one trip; cancellation leaves a recoverable lease."""
    from core.coverage import update_coverage_for_trip

    now = datetime.now(UTC)
    token = uuid4().hex
    collection = Trip.get_pymongo_collection()
    claimed = await collection.find_one_and_update(
        {"_id": trip_id, **due_coverage_query(now)},
        {
            "$set": {
                "coverage_status": "running",
                "coverage_lease_token": token,
                "coverage_lease_until": now + timedelta(seconds=LEASE_SECONDS),
            },
            "$inc": {"coverage_attempts": 1},
        },
        return_document=ReturnDocument.AFTER,
    )
    if claimed is None:
        return False
    attempts = int(claimed.get("coverage_attempts", 1))
    try:
        async with asyncio.timeout(PROCESSING_TIMEOUT_SECONDS):
            if attempts > MAX_ATTEMPTS:
                raise RuntimeError(  # noqa: TRY301
                    "Coverage processing stopped repeatedly. Retry updates to resume."
                )
            # Recheck visibility after claiming so inactive trips are never credited.
            if not claimed.get("inactive") and not claimed.get("invalid"):
                await (coverage_service or update_coverage_for_trip)(claimed, trip_id)
            # A failed notification also retries; coverage writes are idempotent.
            await notify_coverage_updated()
    except Exception as exc:
        failed = attempts >= MAX_ATTEMPTS
        await collection.update_one(
            {"_id": trip_id, "coverage_lease_token": token},
            {
                "$set": {
                    "coverage_status": "failed" if failed else "retry",
                    "coverage_error": str(exc)[:1000] or type(exc).__name__,
                    "coverage_next_attempt_at": None
                    if failed
                    else datetime.now(UTC)
                    + timedelta(seconds=min(900, 15 * 2 ** (attempts - 1))),
                    "coverage_lease_until": None,
                    "coverage_lease_token": None,
                }
            },
        )
        logger.warning(
            "Coverage attempt %s failed for historical trip %s: %s",
            attempts,
            trip_id,
            exc,
        )
        return False
    result = await collection.update_one(
        {"_id": trip_id, "coverage_lease_token": token},
        {
            "$set": {
                "coverage_status": "complete",
                "coverage_emitted_at": datetime.now(UTC),
                "coverage_error": None,
                "coverage_next_attempt_at": None,
                "coverage_lease_until": None,
                "coverage_lease_token": None,
            }
        },
    )
    return result.modified_count == 1


async def drain_pending_coverage(_ctx: dict | None = None) -> dict[str, int]:
    trips = (
        await Trip.find(due_coverage_query(datetime.now(UTC)))
        .sort("coverage_next_attempt_at")
        .limit(BATCH_SIZE)
        .to_list()
    )
    completed = 0
    for trip in trips:
        completed += int(await process_pending_trip_coverage(trip.id))
    return {"attempted": len(trips), "completed": completed}


async def coverage_processing_status() -> dict[str, int]:
    return {
        "pending": await Trip.find(
            {"coverage_status": {"$in": ["pending", "running", "retry"]}}
        ).count(),
        "failed": await Trip.find({"coverage_status": "failed"}).count(),
    }


async def retry_failed_coverage() -> int:
    result = await Trip.get_pymongo_collection().update_many(
        {"coverage_status": "failed"},
        {
            "$set": {
                "coverage_status": "pending",
                "coverage_attempts": 0,
                "coverage_next_attempt_at": None,
                "coverage_lease_until": None,
                "coverage_lease_token": None,
                "coverage_error": None,
            }
        },
    )
    return result.modified_count
