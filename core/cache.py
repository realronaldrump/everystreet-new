"""
Redis-backed cache for expensive query results.

Provides a simple decorator for caching async function results keyed
by their arguments.  Cache entries expire via Redis TTL — no manual
invalidation is needed for normal operation.
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
from typing import Any

from core.redis import get_shared_redis

logger = logging.getLogger(__name__)


def _make_key(prefix: str, args: tuple, kwargs: dict[str, Any]) -> str:
    """Produce a deterministic cache key from the function arguments."""
    raw = json.dumps({"a": args, "k": kwargs}, sort_keys=True, default=str)
    digest = hashlib.sha256(raw.encode()).hexdigest()[:16]
    return f"cache:{prefix}:{digest}"


def cached(prefix: str, ttl_seconds: int = 300):
    """
    Decorator that caches an async function's return value in Redis.

    Parameters
    ----------
    prefix : str
        Namespace prefix for the Redis key (e.g. ``"driving_insights"``).
    ttl_seconds : int
        How long to keep the cached result (default 5 minutes).
    """

    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            key = _make_key(prefix, args, kwargs)
            try:
                r = await get_shared_redis()
                hit = await r.get(key)
                if hit is not None:
                    return json.loads(hit)
            except Exception:
                logger.debug("Redis cache read failed for %s", key, exc_info=True)

            result = await fn(*args, **kwargs)

            try:
                r = await get_shared_redis()
                await r.set(key, json.dumps(result, default=str), ex=ttl_seconds)
            except Exception:
                logger.debug("Redis cache write failed for %s", key, exc_info=True)

            return result

        return wrapper

    return decorator
