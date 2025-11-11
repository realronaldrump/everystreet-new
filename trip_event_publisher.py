"""Redis Pub/Sub event publisher for trip updates.

This module provides an event-driven mechanism for publishing trip updates
to connected WebSocket clients, eliminating the need for constant database polling.

This module uses async Redis operations to avoid blocking the event loop.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError

from db import BSONJSONEncoder
from redis_config import get_redis_url

logger = logging.getLogger(__name__)

# Redis channel name for trip updates
TRIP_UPDATES_CHANNEL = "trip_updates"


# Singleton async Redis client instance
_redis_client: aioredis.Redis | None = None


async def get_redis_client() -> aioredis.Redis:
    """Get or create a singleton async Redis client instance.

    Returns:
        Async Redis client instance configured for Pub/Sub.

    Raises:
        RedisConnectionError: If unable to connect to Redis.
    """
    global _redis_client

    if _redis_client is not None:
        try:
            await _redis_client.ping()
            return _redis_client
        except (RedisConnectionError, AttributeError):
            logger.warning("Redis client connection lost, reconnecting...")
            _redis_client = None

    # Get Redis URL using centralized configuration
    redis_url = get_redis_url()

    try:
        _redis_client = await aioredis.from_url(redis_url, decode_responses=True)
        await _redis_client.ping()
        logger.info("Connected to Redis for trip event publishing")
        return _redis_client
    except RedisConnectionError as e:
        logger.error("Failed to connect to Redis: %s", e)
        raise


async def publish_trip_state(
    transaction_id: str,
    trip_data: dict[str, Any],
    *,
    status: str = "active",
) -> bool:
    """Publish a full trip snapshot to Redis Pub/Sub.

    Args:
        transaction_id: Trip identifier.
        trip_data: Complete trip payload (already serialized).
        status: Trip status (`active`, `completed`, etc.).

    Returns:
        True if published successfully, False otherwise.
    """

    try:
        client = await get_redis_client()

        event_data = {
            "transaction_id": transaction_id,
            "event_type": "trip_state",
            "status": status,
            "trip": trip_data,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        message = json.dumps(event_data, cls=BSONJSONEncoder)
        subscribers = await client.publish(TRIP_UPDATES_CHANNEL, message)

        logger.debug(
            "Published trip state for %s (status=%s) to %d subscriber(s)",
            transaction_id,
            status,
            subscribers,
        )

        return True

    except Exception as e:
        logger.error(
            "Failed to publish trip state for %s: %s",
            transaction_id,
            e,
        )
        return False
