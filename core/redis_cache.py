"""
Binary Redis cache helpers.

We keep this separate from trips/events.py because tile bytes must be cached
and retrieved as raw bytes (decode_responses=False).
"""

from __future__ import annotations

import logging
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError

from core.redis import get_redis_url

logger = logging.getLogger(__name__)


class BinaryRedisClientState:
    client: aioredis.Redis | None = None


async def get_binary_redis_client() -> aioredis.Redis:
    """Get or create a singleton Redis client suitable for binary payloads."""
    if BinaryRedisClientState.client is not None:
        try:
            await BinaryRedisClientState.client.ping()
        except (RedisConnectionError, AttributeError):
            logger.warning("Binary Redis client connection lost, reconnecting...")
            BinaryRedisClientState.client = None
        else:
            return BinaryRedisClientState.client

    redis_url = get_redis_url()
    try:
        # redis.asyncio.from_url returns a client instance (not awaitable).
        BinaryRedisClientState.client = aioredis.from_url(
            redis_url,
            decode_responses=False,
        )
        await BinaryRedisClientState.client.ping()
    except RedisConnectionError:
        logger.exception("Failed to connect to Redis for binary cache")
        raise
    else:
        logger.info("Connected to Redis for binary cache")
        return BinaryRedisClientState.client


async def cache_get(key: str) -> bytes | None:
    try:
        client = await get_binary_redis_client()
        value = await client.get(key)
        if value is None:
            return None
        return value if isinstance(value, (bytes, bytearray)) else None
    except Exception:
        logger.debug("Binary cache get failed for key=%s", key, exc_info=True)
        return None


async def cache_set(key: str, value: bytes, ttl_sec: int) -> bool:
    if not isinstance(value, (bytes, bytearray)):
        return False
    try:
        client = await get_binary_redis_client()
        await client.set(key, bytes(value), ex=int(ttl_sec))
        return True
    except Exception:
        logger.debug("Binary cache set failed for key=%s", key, exc_info=True)
        return False


async def cache_incr(key: str) -> int | None:
    """Atomic increment helper used for versioning."""
    try:
        client = await get_binary_redis_client()
        value: Any = await client.incr(key)
        try:
            return int(value)
        except Exception:
            return None
    except Exception:
        logger.debug("Binary cache incr failed for key=%s", key, exc_info=True)
        return None
