"""
Centralized Redis connection configuration and shared client pool.

This module provides a single source of truth for Redis URL
construction and a shared async Redis client singleton.
"""

from __future__ import annotations

import logging
import os
from typing import Final

import redis.asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError

logger = logging.getLogger(__name__)

DEFAULT_REDIS_URL: Final[str] = "redis://redis:6379"
REDIS_URL_ENV_VAR: Final[str] = "REDIS_URL"

_shared_client: aioredis.Redis | None = None


def get_redis_url() -> str:
    """
    Get Redis URL for internal Docker networking.

    Returns:
        str: Redis URL suitable for connection (e.g., "redis://redis:6379")
    """
    redis_url = os.getenv(REDIS_URL_ENV_VAR, "").strip()
    if redis_url:
        return redis_url
    return DEFAULT_REDIS_URL


async def get_shared_redis() -> aioredis.Redis:
    """
    Return a process-wide shared async Redis client.

    The client is lazily created on first call and reused across all
    modules (cache, pub/sub publishing, live trip store).  Connection
    health is verified via ``ping()``; a lost connection is
    automatically re-established.

    For pub/sub *subscribers* that need a dedicated connection (the
    subscription blocks the connection), use :func:`create_pubsub_redis`
    instead.
    """
    global _shared_client
    if _shared_client is not None:
        try:
            await _shared_client.ping()
        except (RedisConnectionError, AttributeError, OSError):
            logger.warning("Shared Redis connection lost, reconnecting...")
            _shared_client = None
        else:
            return _shared_client

    _shared_client = aioredis.from_url(
        get_redis_url(),
        decode_responses=True,
        socket_connect_timeout=2,
    )
    await _shared_client.ping()
    logger.info("Shared Redis client connected")
    return _shared_client


def create_pubsub_redis() -> aioredis.Redis:
    """
    Create a *new* Redis connection intended for pub/sub subscription.

    Pub/sub listeners monopolise their connection, so they must not
    share the process-wide pool.  Callers are responsible for closing
    this client when done.
    """
    return aioredis.from_url(get_redis_url(), decode_responses=True)


async def close_shared_redis() -> None:
    """Close the shared Redis client (call during app shutdown)."""
    global _shared_client
    if _shared_client is not None:
        await _shared_client.close()
        _shared_client = None
        logger.info("Shared Redis client closed")
