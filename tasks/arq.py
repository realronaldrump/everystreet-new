"""ARQ connection helpers and job status utilities."""

from __future__ import annotations

import asyncio
import inspect
import logging
from urllib.parse import urlparse

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from core.redis import get_redis_url

logger = logging.getLogger(__name__)

_pool: ArqRedis | None = None
_pool_lock = asyncio.Lock()


def get_redis_settings() -> RedisSettings:
    """Build RedisSettings from REDIS_URL or component env vars."""
    redis_url = get_redis_url()
    parsed = urlparse(redis_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 6379
    database = int(parsed.path.lstrip("/") or 0)
    ssl = parsed.scheme == "rediss"
    return RedisSettings(
        host=host,
        port=port,
        database=database,
        username=parsed.username,
        password=parsed.password,
        ssl=ssl,
    )


async def get_arq_pool() -> ArqRedis:
    """Get or create a shared ARQ redis pool."""
    global _pool
    if _pool is not None:
        return _pool

    async with _pool_lock:
        if _pool is None:
            _pool = await create_pool(get_redis_settings())
            logger.info("Created ARQ Redis pool")
    return _pool


async def close_arq_pool() -> None:
    """Close the shared ARQ redis pool."""
    global _pool
    if _pool is None:
        return
    close_fn = getattr(_pool, "close", None)
    if close_fn:
        result = close_fn()
        if inspect.isawaitable(result):
            await result
    _pool = None
    logger.info("Closed ARQ Redis pool")
