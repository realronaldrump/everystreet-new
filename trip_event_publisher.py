"""Redis Pub/Sub event publisher for trip updates.

This module provides an event-driven mechanism for publishing trip updates
to connected WebSocket clients, eliminating the need for constant database polling.

This module uses async Redis operations to avoid blocking the event loop.
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError

logger = logging.getLogger(__name__)

# Redis channel name for trip updates
TRIP_UPDATES_CHANNEL = "trip_updates"

# Singleton async Redis client instance
_redis_client: aioredis.Redis | None = None


def get_redis_client() -> redis.Redis:
    """Get or create a singleton Redis client instance.

    Returns:
        Redis client instance configured for Pub/Sub.

    Raises:
        RedisConnectionError: If unable to connect to Redis.
    """
    global _redis_client

    if _redis_client is not None:
        try:
            _redis_client.ping()
            return _redis_client
        except (RedisConnectionError, AttributeError):
            logger.warning("Redis client connection lost, reconnecting...")
            _redis_client = None

    # Get Redis URL from environment (same logic as celery_app.py)
    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        redis_host = os.getenv("REDISHOST") or os.getenv("RAILWAY_PRIVATE_DOMAIN")
        redis_port = os.getenv("REDISPORT", "6379")
        redis_password = os.getenv("REDISPASSWORD") or os.getenv("REDIS_PASSWORD")
        redis_user = os.getenv("REDISUSER", "default")

        if redis_host and redis_password:
            redis_url = (
                f"redis://{redis_user}:{redis_password}@{redis_host}:{redis_port}"
            )
        else:
            redis_url = "redis://localhost:6379"

    try:
        _redis_client = redis.from_url(redis_url, decode_responses=True)
        _redis_client.ping()
        logger.info("Connected to Redis for trip event publishing")
        return _redis_client
    except RedisConnectionError as e:
        logger.error("Failed to connect to Redis: %s", e)
        raise


def publish_trip_delta(
    transaction_id: str,
    delta: dict[str, Any],
    sequence: int,
) -> bool:
    """Publish a trip delta update to Redis Pub/Sub.

    Args:
        transaction_id: The trip's transaction ID.
        delta: Dictionary containing only the changed/new data fields.
                Should include:
                - new_coordinates: List of new coordinate points
                - updated_metrics: Dict with updated metric values
                - status: Trip status (if changed)
                - etc.
        sequence: The sequence number for this update.

    Returns:
        True if published successfully, False otherwise.
    """
    try:
        client = get_redis_client()

        event_data = {
            "transaction_id": transaction_id,
            "sequence": sequence,
            "delta": delta,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        message = json.dumps(event_data)
        subscribers = client.publish(TRIP_UPDATES_CHANNEL, message)

        logger.debug(
            "Published trip delta for %s (seq=%d) to %d subscribers",
            transaction_id,
            sequence,
            subscribers,
        )

        return True

    except Exception as e:
        logger.error(
            "Failed to publish trip delta for %s: %s",
            transaction_id,
            e,
            exc_info=True,
        )
        return False


def publish_trip_start(
    transaction_id: str,
    trip_data: dict[str, Any],
    sequence: int,
) -> bool:
    """Publish a trip start event to Redis Pub/Sub.

    Args:
        transaction_id: The trip's transaction ID.
        trip_data: Complete trip data (for new trips, we send full data).
        sequence: The sequence number for this update.

    Returns:
        True if published successfully, False otherwise.
    """
    try:
        client = get_redis_client()

        event_data = {
            "transaction_id": transaction_id,
            "sequence": sequence,
            "event_type": "trip_start",
            "trip": trip_data,  # Full trip data for new trips
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        message = json.dumps(event_data)
        subscribers = client.publish(TRIP_UPDATES_CHANNEL, message)

        logger.debug(
            "Published trip start for %s (seq=%d) to %d subscribers",
            transaction_id,
            sequence,
            subscribers,
        )

        return True

    except Exception as e:
        logger.error(
            "Failed to publish trip start for %s: %s",
            transaction_id,
            e,
            exc_info=True,
        )
        return False


def publish_trip_end(
    transaction_id: str,
    sequence: int,
) -> bool:
    """Publish a trip end event to Redis Pub/Sub.

    Args:
        transaction_id: The trip's transaction ID.
        sequence: The sequence number for this update.

    Returns:
        True if published successfully, False otherwise.
    """
    try:
        client = get_redis_client()

        event_data = {
            "transaction_id": transaction_id,
            "sequence": sequence,
            "event_type": "trip_end",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        message = json.dumps(event_data)
        subscribers = client.publish(TRIP_UPDATES_CHANNEL, message)

        logger.debug(
            "Published trip end for %s (seq=%d) to %d subscribers",
            transaction_id,
            sequence,
            subscribers,
        )

        return True

    except Exception as e:
        logger.error(
            "Failed to publish trip end for %s: %s",
            transaction_id,
            e,
            exc_info=True,
        )
        return False
