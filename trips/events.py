"""
Redis Pub/Sub event publisher for trip updates.

This module provides an event-driven mechanism for publishing trip
updates to connected WebSocket clients, eliminating the need for
constant database polling.

This module uses async Redis operations to avoid blocking the event
loop.
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
from beanie import PydanticObjectId
from redis.exceptions import ConnectionError as RedisConnectionError

from core.redis import get_redis_url

logger = logging.getLogger(__name__)

# Redis channel name for trip updates
TRIP_UPDATES_CHANNEL = "trip_updates"


class RedisClientState:
    """State container for Redis client to avoid global variables."""

    client: aioredis.Redis | None = None


async def get_redis_client() -> aioredis.Redis:
    """
    Get or create a singleton async Redis client instance.

    Returns:
        Async Redis client instance configured for Pub/Sub.

    Raises:
        RedisConnectionError: If unable to connect to Redis.
    """
    if RedisClientState.client is not None:
        try:
            await RedisClientState.client.ping()
        except (RedisConnectionError, AttributeError):
            logger.warning("Redis client connection lost, reconnecting...")
            RedisClientState.client = None
        else:
            return RedisClientState.client

    # Get Redis URL using centralized configuration
    redis_url = get_redis_url()

    try:
        RedisClientState.client = await aioredis.from_url(
            redis_url,
            decode_responses=True,
        )
        await RedisClientState.client.ping()
    except RedisConnectionError:
        logger.exception("Failed to connect to Redis")
        raise
    else:
        logger.info("Connected to Redis for trip event publishing")
        return RedisClientState.client


def json_serializer(obj: Any) -> Any:
    """JSON serializer for objects not serializable by default json code."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, PydanticObjectId):
        return str(obj)
    msg = f"Type {type(obj)} not serializable"
    raise TypeError(msg)


async def publish_trip_state(
    transaction_id: str,
    trip_data: dict[str, Any],
    *,
    status: str = "active",
) -> bool:
    """
    Publish a full trip snapshot to Redis Pub/Sub.

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
            "timestamp": datetime.now(UTC),
        }

        message = json.dumps(event_data, default=json_serializer)
        subscribers = await client.publish(TRIP_UPDATES_CHANNEL, message)

        logger.debug(
            "Published trip state for %s (status=%s) to %d subscriber(s)",
            transaction_id,
            status,
            subscribers,
        )
    except Exception:
        logger.exception(
            "Failed to publish trip state for %s",
            transaction_id,
        )
        return False
    else:
        return True
