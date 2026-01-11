"""
Centralized Redis connection configuration.

This module provides a single source of truth for Redis URL construction with proper URL
encoding to handle special characters in passwords.
"""

import logging
import os
from urllib.parse import quote_plus

logger = logging.getLogger(__name__)


def get_redis_url() -> str:
    """
    Get Redis URL from environment with proper URL encoding.

    Constructs Redis URL from environment variables with proper URL encoding
    for credentials to handle special characters (@, :, /, etc.).

    Returns:
        str: Redis URL suitable for connection (e.g., "redis://user:pass@host:port")

    Environment Variables:
        REDIS_URL: Complete Redis URL (if provided, used directly)
        REDISHOST: Redis host
        REDISPORT: Redis port (default: 6379)
        REDISPASSWORD or REDIS_PASSWORD: Redis password
        REDISUSER: Redis username (default: "default")
    """
    redis_url = os.getenv("REDIS_URL")

    if redis_url:
        # Use provided URL as-is (assumed to be already properly formatted)
        logger.debug(
            "Using REDIS_URL from environment: %s",
            redis_url.split("@")[-1] if "@" in redis_url else redis_url,
        )
        return redis_url

    # Construct URL from components
    redis_host = os.getenv("REDISHOST")
    redis_port = os.getenv("REDISPORT", "6379")
    redis_password = os.getenv("REDISPASSWORD") or os.getenv("REDIS_PASSWORD")
    redis_user = os.getenv("REDISUSER", "default")

    if redis_host and redis_password:
        # URL-encode username and password to handle special characters
        encoded_user = quote_plus(redis_user)
        encoded_password = quote_plus(redis_password)
        redis_url = (
            f"redis://{encoded_user}:{encoded_password}@{redis_host}:{redis_port}"
        )
        logger.info(
            "Constructed REDIS_URL from environment variables: redis://%s@%s:%s",
            encoded_user,
            redis_host,
            redis_port,
        )
    else:
        # Fallback to localhost (for development)
        redis_url = "redis://localhost:6379"
        logger.warning(
            "REDIS_URL not provided and required environment variables missing; "
            "defaulting to localhost Redis at %s",
            redis_url,
        )

    return redis_url
