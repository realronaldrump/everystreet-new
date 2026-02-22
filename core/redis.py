"""
Centralized Redis connection configuration.

This module provides a single source of truth for Redis URL
construction.
"""

import os
from typing import Final

DEFAULT_REDIS_URL: Final[str] = "redis://redis:6379"
REDIS_URL_ENV_VAR: Final[str] = "REDIS_URL"


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
