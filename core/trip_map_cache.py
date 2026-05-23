"""Shared cache revision helpers for historical trip map bundles."""

from __future__ import annotations

import logging

from core.redis import get_shared_redis

logger = logging.getLogger(__name__)

TRIP_MAP_CACHE_PREFIX = "trip_map_bundle"
TRIP_MAP_REVISION_KEY = "trip_map:revision"


async def get_trip_map_revision() -> str:
    """Return the current coarse revision token for historical trip map data."""
    try:
        redis = await get_shared_redis()
        value = await redis.get(TRIP_MAP_REVISION_KEY)
        if value is None:
            await redis.set(TRIP_MAP_REVISION_KEY, "0")
            return "0"
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return str(value)
    except Exception:
        logger.debug("Unable to read trip map revision", exc_info=True)
        return "0"


async def bump_trip_map_revision() -> str | None:
    """
    Increment the historical trip map revision.

    Bundle cache keys include this token, so older cached bodies become
    unreachable immediately and expire naturally by TTL.
    """
    try:
        redis = await get_shared_redis()
        revision = await redis.incr(TRIP_MAP_REVISION_KEY)
        return str(revision)
    except Exception:
        logger.debug("Unable to bump trip map revision", exc_info=True)
        return None


__all__ = [
    "TRIP_MAP_CACHE_PREFIX",
    "TRIP_MAP_REVISION_KEY",
    "bump_trip_map_revision",
    "get_trip_map_revision",
]
