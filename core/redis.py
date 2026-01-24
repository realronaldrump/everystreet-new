"""
Centralized Redis connection configuration.

This module provides a single source of truth for Redis URL construction
with proper URL encoding to handle special characters in passwords.
"""

import logging
import os
from typing import Final

logger = logging.getLogger(__name__)

DEFAULT_REDIS_URL: Final[str] = "redis://redis:6379"
REDIS_URL_ENV_VAR: Final[str] = "REDIS_URL"
_DEPRECATED_REDIS_ENV_VARS: Final[tuple[str, ...]] = (
    "REDISHOST",
    "REDISPORT",
    "REDISPASSWORD",
    "REDIS_PASSWORD",
    "REDISUSER",
)
_redis_env_warned = False


def _warn_deprecated_redis_env() -> None:
    global _redis_env_warned
    if _redis_env_warned:
        return
    configured = [env for env in _DEPRECATED_REDIS_ENV_VARS if os.getenv(env)]
    if configured:
        logger.warning(
            "Deprecated Redis env vars are ignored: %s. "
            "Set %s to override the Redis connection.",
            ", ".join(configured),
            REDIS_URL_ENV_VAR,
        )
    _redis_env_warned = True


def get_redis_url() -> str:
    """
    Get Redis URL for internal Docker networking.

    Returns:
        str: Redis URL suitable for connection (e.g., "redis://redis:6379")
    """
    redis_url = os.getenv(REDIS_URL_ENV_VAR, "").strip()
    if redis_url:
        return redis_url
    _warn_deprecated_redis_env()
    return DEFAULT_REDIS_URL
