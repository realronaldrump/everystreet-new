"""API endpoints for live trip tracking via WebSocket and polling."""

import contextlib
import json
import logging
import uuid
from datetime import UTC, datetime

import redis.asyncio as aioredis
from fastapi import (
    APIRouter,
    HTTPException,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from starlette.websockets import WebSocketState

from db import db_manager
from db.schemas import (
    ActiveTripResponseUnion,
    ActiveTripSuccessResponse,
    NoActiveTripResponse,
)
from live_tracking import get_active_trip, get_trip_updates
from redis_config import get_redis_url
from trip_event_publisher import TRIP_UPDATES_CHANNEL, json_serializer

logger = logging.getLogger(__name__)
router = APIRouter()


# ============================================================================
# WebSocket Connection Manager
# ============================================================================


class ConnectionManager:
    """Manages WebSocket connections."""

    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)


manager = ConnectionManager()


# ============================================================================
# WebSocket Endpoint
# ============================================================================


@router.websocket("/ws/trips")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time trip updates."""
    await manager.connect(websocket)
    redis_client = None
    pubsub = None

    try:
        # Send initial trip state
        initial_trip = await get_active_trip()
        if initial_trip:
            initial_trip_payload = (
                initial_trip.model_dump()
                if hasattr(initial_trip, "model_dump")
                else dict(initial_trip)
            )
            await websocket.send_text(
                json.dumps(
                    {
                        "type": "trip_state",
                        "trip": initial_trip_payload,
                        "status": initial_trip_payload.get("status", "active"),
                    },
                    default=json_serializer,
                ),
            )

        # Subscribe to Redis updates
        redis_url = get_redis_url()
        redis_client = await aioredis.from_url(redis_url, decode_responses=True)
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(TRIP_UPDATES_CHANNEL)

        logger.info("WebSocket connected to live trip updates")

        # Listen for Redis messages
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue

            try:
                event_data = json.loads(message["data"])

                if event_data.get("event_type") != "trip_state":
                    continue

                trip_payload = event_data.get("trip")
                if not trip_payload:
                    continue

                # Check WebSocket state before sending
                if websocket.application_state != WebSocketState.CONNECTED:
                    break

                await websocket.send_text(
                    json.dumps(
                        {
                            "type": "trip_state",
                            "trip": trip_payload,
                            "status": event_data.get("status", "active"),
                            "transaction_id": event_data.get("transaction_id"),
                        },
                        default=json_serializer,
                    ),
                )

            except json.JSONDecodeError as e:
                logger.warning("Failed to parse Redis message: %s", e)
            except WebSocketDisconnect:
                logger.info("WebSocket disconnected during send")
                break
            except RuntimeError as e:
                if "close message" in str(e):
                    logger.debug("WebSocket closed")
                    break
                raise

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception:
        logger.exception("WebSocket error")
    finally:
        manager.disconnect(websocket)
        if pubsub:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe(TRIP_UPDATES_CHANNEL)
                await pubsub.close()
        if redis_client:
            with contextlib.suppress(Exception):
                await redis_client.close()


# ============================================================================
# REST API Endpoints
# ============================================================================


@router.get(
    "/api/active_trip",
    response_model=ActiveTripResponseUnion,
    summary="Get Currently Active Trip",
)
async def active_trip_endpoint():
    """Get the currently active trip, if any."""
    try:
        active_trip_doc = await get_active_trip()

        if not active_trip_doc:
            return NoActiveTripResponse(server_time=datetime.now(UTC))

        # Use Beanie model directly
        return ActiveTripSuccessResponse(
            trip=active_trip_doc,
            server_time=datetime.now(UTC),
        )

    except Exception:
        error_id = str(uuid.uuid4())
        logger.exception("Error fetching active trip [%s]", error_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "Internal server error",
                "error_id": error_id,
            },
        )


@router.get("/api/trip_updates")
async def trip_updates_endpoint(response: Response):
    """
    Polling fallback endpoint for trip updates.

    Returns current active trip if available.
    """
    try:
        if not db_manager.connection_healthy:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return {
                "status": "error",
                "has_update": False,
                "message": "Database unavailable",
            }

        updates = await get_trip_updates()
        updates["server_time"] = datetime.now(UTC).isoformat()
    except Exception:
        error_id = str(uuid.uuid4())
        logger.exception("Error in trip_updates [%s]", error_id)

        response.status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
        return {
            "status": "error",
            "has_update": False,
            "message": "Internal server error",
            "error_id": error_id,
            "server_time": datetime.now(UTC).isoformat(),
        }
    else:
        return updates
