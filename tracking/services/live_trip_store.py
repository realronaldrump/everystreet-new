"""Redis-backed ephemeral storage for live trip state."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError

from core.date_utils import parse_timestamp
from core.redis import get_redis_url

logger = logging.getLogger(__name__)

LIVE_TRIP_TTL_SECONDS = 3 * 60 * 60
LIVE_TRIP_STALE_SECONDS = 30 * 60
_ACTIVE_TRIP_TX_KEY = "tracking:live:active_tx"
_TRIP_KEY_PREFIX = "tracking:live:trip:"
_CLOSED_KEY_PREFIX = "tracking:live:closed:"


class _RedisState:
    client: aioredis.Redis | None = None


def _trip_key(transaction_id: str) -> str:
    return f"{_TRIP_KEY_PREFIX}{transaction_id}"


def _closed_key(transaction_id: str) -> str:
    return f"{_CLOSED_KEY_PREFIX}{transaction_id}"


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    msg = f"Type {type(value)} is not JSON serializable"
    raise TypeError(msg)


async def _get_redis_client() -> aioredis.Redis:
    if _RedisState.client is not None:
        try:
            await _RedisState.client.ping()
        except (RedisConnectionError, AttributeError):
            logger.warning("Live trip Redis connection lost, reconnecting...")
            _RedisState.client = None
        else:
            return _RedisState.client

    redis_url = get_redis_url()
    _RedisState.client = aioredis.from_url(redis_url, decode_responses=True)
    await _RedisState.client.ping()
    return _RedisState.client


async def save_trip_snapshot(trip: dict[str, Any]) -> None:
    """Save an active live trip snapshot and mark it as current."""
    transaction_id = str(trip.get("transactionId") or "").strip()
    if not transaction_id:
        msg = "Trip snapshot missing transactionId"
        raise ValueError(msg)

    payload = dict(trip)
    payload["transactionId"] = transaction_id

    serialized = json.dumps(payload, default=_json_default)
    client = await _get_redis_client()
    pipe = client.pipeline()
    pipe.set(_trip_key(transaction_id), serialized, ex=LIVE_TRIP_TTL_SECONDS)
    pipe.set(_ACTIVE_TRIP_TX_KEY, transaction_id, ex=LIVE_TRIP_TTL_SECONDS)
    pipe.delete(_closed_key(transaction_id))
    await pipe.execute()


async def get_trip_snapshot(transaction_id: str) -> dict[str, Any] | None:
    """Load a specific live trip snapshot by transaction ID."""
    tx = str(transaction_id or "").strip()
    if not tx:
        return None

    client = await _get_redis_client()
    raw = await client.get(_trip_key(tx))
    if not raw:
        return None

    try:
        payload = json.loads(raw)
    except Exception:
        logger.warning("Invalid JSON in live trip snapshot for %s; deleting key", tx)
        await client.delete(_trip_key(tx))
        return None

    if not isinstance(payload, dict):
        await client.delete(_trip_key(tx))
        return None

    payload.setdefault("transactionId", tx)
    return payload


async def get_active_trip_snapshot() -> dict[str, Any] | None:
    """Load the currently active live trip snapshot, if any."""
    client = await _get_redis_client()
    active_tx = await client.get(_ACTIVE_TRIP_TX_KEY)
    if not active_tx:
        return None

    trip = await get_trip_snapshot(active_tx)
    if trip is None:
        await client.delete(_ACTIVE_TRIP_TX_KEY)
        return None
    return trip


async def clear_trip_snapshot(
    transaction_id: str,
    *,
    mark_closed: bool = False,
) -> None:
    """Delete a live trip snapshot and clear active pointer when it matches."""
    tx = str(transaction_id or "").strip()
    if not tx:
        return

    client = await _get_redis_client()
    active_tx = await client.get(_ACTIVE_TRIP_TX_KEY)

    pipe = client.pipeline()
    pipe.delete(_trip_key(tx))
    if active_tx == tx:
        pipe.delete(_ACTIVE_TRIP_TX_KEY)
    if mark_closed:
        pipe.set(_closed_key(tx), "1", ex=LIVE_TRIP_TTL_SECONDS)
    await pipe.execute()


async def is_trip_marked_closed(transaction_id: str) -> bool:
    """Return whether a trip was recently finalized and should ignore late events."""
    tx = str(transaction_id or "").strip()
    if not tx:
        return False
    client = await _get_redis_client()
    return bool(await client.exists(_closed_key(tx)))


def live_trip_is_stale(
    trip: dict[str, Any],
    *,
    now: datetime | None = None,
) -> bool:
    """Check if a live trip snapshot is stale."""
    if not isinstance(trip, dict):
        return False
    ts = trip.get("lastUpdate") or trip.get("endTime") or trip.get("startTime")
    parsed = parse_timestamp(ts)
    if not isinstance(parsed, datetime):
        return False
    now_utc = now or datetime.now(UTC)
    return (now_utc - parsed).total_seconds() > LIVE_TRIP_STALE_SECONDS


__all__ = [
    "LIVE_TRIP_STALE_SECONDS",
    "LIVE_TRIP_TTL_SECONDS",
    "clear_trip_snapshot",
    "get_active_trip_snapshot",
    "get_trip_snapshot",
    "is_trip_marked_closed",
    "live_trip_is_stale",
    "save_trip_snapshot",
]
