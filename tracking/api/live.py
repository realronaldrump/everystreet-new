"""API endpoints for live trip tracking via WebSocket and polling."""

import contextlib
import json
import logging
from datetime import UTC, datetime

from fastapi import (
    APIRouter,
    WebSocket,
    WebSocketDisconnect,
)
from starlette.websockets import WebSocketState

from core.api import api_route
from core.redis import create_pubsub_redis
from db.schemas import (
    ActiveTripResponseUnion,
    ActiveTripSuccessResponse,
    NoActiveTripResponse,
)
from tracking.services.tracking_service import TrackingService
from trips.events import TRIP_UPDATES_CHANNEL, json_serializer

logger = logging.getLogger(__name__)
router = APIRouter()


# ============================================================================
# WebSocket Endpoint
# ============================================================================


@router.websocket("/ws/trips")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time trip updates."""
    await websocket.accept()
    redis_client = None
    pubsub = None

    try:
        # Send initial trip state
        initial_trip = await TrackingService.get_active_trip()
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
        redis_client = create_pubsub_redis()
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
@api_route(logger)
async def active_trip_endpoint():
    """Get the currently active trip, if any."""
    active_trip_doc = await TrackingService.get_active_trip()

    if not active_trip_doc:
        return NoActiveTripResponse(server_time=datetime.now(UTC))

    active_trip_payload = (
        active_trip_doc.model_dump()
        if hasattr(active_trip_doc, "model_dump")
        else dict(active_trip_doc)
    )

    return ActiveTripSuccessResponse(
        trip=active_trip_payload,
        server_time=datetime.now(UTC),
    )


@router.get("/api/trip_updates", response_model=dict[str, object])
@api_route(logger)
async def trip_updates_endpoint():
    """
    Polling endpoint for trip updates.

    Returns current active trip if available.
    """
    updates = await TrackingService.get_trip_updates()
    updates["server_time"] = datetime.now(UTC).isoformat()
    return updates
