"""API endpoints for live trip tracking via webhooks and WebSocket."""

import contextlib
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
from fastapi import (
    APIRouter,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketState

from db import db_manager
from db.schemas import (
    ActiveTripResponseUnion,
    ActiveTripSuccessResponse,
    NoActiveTripResponse,
)
from live_tracking import (
    get_active_trip,
    get_trip_updates,
    process_trip_data,
    process_trip_end,
    process_trip_metrics,
    process_trip_start,
)
from redis_config import get_redis_url
from trip_event_publisher import TRIP_UPDATES_CHANNEL

logger = logging.getLogger(__name__)
router = APIRouter()


async def _process_bouncie_event(data: dict[str, Any]) -> dict[str, Any]:
    """
    Process Bouncie webhook event.

    Raises exceptions if processing fails, which are caught by the webhook handler.
    """
    event_type = data.get("eventType")
    transaction_id = data.get("transactionId")

    # Check for non-trip events early (no DB needed)
    if event_type in {"connect", "disconnect", "battery", "mil"}:
        logger.info("Received non-trip event: %s", event_type)
        return {"status": "ignored", "event": event_type}

    if event_type not in {"tripStart", "tripData", "tripMetrics", "tripEnd"}:
        logger.warning("Unknown event type: %s", event_type)
        return {"status": "unknown", "event": event_type}

    # Route to appropriate handler
    if event_type == "tripStart":
        await process_trip_start(data)
    elif event_type == "tripData":
        await process_trip_data(data)
    elif event_type == "tripMetrics":
        await process_trip_metrics(data)
    elif event_type == "tripEnd":
        await process_trip_end(data)

    return {"status": "processed", "event": event_type, "transactionId": transaction_id}


async def _record_webhook_failure(
    data: dict[str, Any],
    error_id: str,
    reason: str,
    error: Exception | None = None,
) -> None:
    """Store failed webhook payloads so they can be inspected or replayed."""
    payload = data if isinstance(data, dict) else {"raw_payload": data}
    failure_payload = {
        "received_at": datetime.now(UTC),
        "eventType": payload.get("eventType") if isinstance(payload, dict) else None,
        "transactionId": payload.get("transactionId") if isinstance(payload, dict) else None,
        "reason": reason,
        "error_id": error_id,
        "error": str(error) if error else None,
        "payload": payload,
    }
    with contextlib.suppress(Exception):
        await db_manager.db["webhook_failures"].insert_one(failure_payload)


# ============================================================================
# WebSocket Connection Manager
# ============================================================================


class ConnectionManager:
    """Manages WebSocket connections."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
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
            await websocket.send_text(
                json.dumps(
                    {
                        "type": "trip_state",
                        "trip": initial_trip,
                        "status": initial_trip.get("status", "active"),
                    },
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
    except Exception as e:
        logger.error("WebSocket error: %s", e, exc_info=True)
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


@router.post("/webhook/bouncie")
async def bouncie_webhook(request: Request):
    """
    Receive and process Bouncie webhook events.

    Always returns 200 OK to prevent Bouncie from deactivating the webhook. Processing
    happens asynchronously with internal retries and failure capture.
    """
    try:
        data = await request.json()
        event_type = data.get("eventType")
        transaction_id = data.get("transactionId")

        if not event_type:
            logger.warning("Webhook missing eventType")
            return JSONResponse(
                content={"status": "accepted", "message": "Missing eventType"},
                status_code=200,
            )

        logger.info("Webhook received: %s (Trip: %s)", event_type, transaction_id)

        try:
            from tasks import process_webhook_event_task

            task = process_webhook_event_task.delay(data)
            return JSONResponse(
                content={
                    "status": "accepted",
                    "message": "Event queued",
                    "task_id": task.id,
                },
                status_code=200,
            )
        except Exception as enqueue_error:
            error_id = str(uuid.uuid4())
            logger.exception(
                "Failed to enqueue webhook event [%s]: %s (Trip: %s) - Error: %s",
                error_id,
                event_type,
                transaction_id,
                enqueue_error,
            )
            try:
                result = await _process_bouncie_event(data)
                return JSONResponse(
                    content={
                        "status": "ok",
                        "detail": result,
                        "warning": "Processed inline after queue failure",
                        "error_id": error_id,
                    },
                    status_code=200,
                )
            except Exception as processing_error:
                logger.exception(
                    "Failed to process webhook event after queue failure [%s]: %s (Trip: %s) - Error: %s",
                    error_id,
                    event_type,
                    transaction_id,
                    processing_error,
                )
                await _record_webhook_failure(
                    data,
                    error_id=error_id,
                    reason="enqueue_failed_and_processing_failed",
                    error=processing_error,
                )
                return JSONResponse(
                    content={
                        "status": "accepted",
                        "message": "Event received but processing failed",
                        "error_id": error_id,
                    },
                    status_code=200,
                )

    except json.JSONDecodeError:
        logger.exception("Invalid JSON in webhook")
        return JSONResponse(
            content={"status": "accepted", "message": "Invalid JSON payload"},
            status_code=200,
        )
    except Exception as e:
        # Catch-all for any unexpected errors
        error_id = str(uuid.uuid4())
        logger.exception("Unexpected webhook error [%s]: %s", error_id, e)
        await _record_webhook_failure(
            data if "data" in locals() else {},
            error_id=error_id,
            reason="unexpected_exception",
            error=e,
        )
        return JSONResponse(
            content={
                "status": "accepted",
                "message": "Event received but encountered error",
                "error_id": error_id,
            },
            status_code=200,
        )


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

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception("Error fetching active trip [%s]: %s", error_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "Internal server error",
                "error_id": error_id,
            },
        )


@router.get("/api/trip_updates")
async def trip_updates_endpoint():
    """
    Polling fallback endpoint for trip updates.

    Returns current active trip if available.
    """
    try:
        if not db_manager.connection_healthy:
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={
                    "status": "error",
                    "has_update": False,
                    "message": "Database unavailable",
                },
            )

        updates = await get_trip_updates()
        updates["server_time"] = datetime.now(UTC).isoformat()
        return updates

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception("Error in trip_updates [%s]: %s", error_id, e)

        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "status": "error",
                "has_update": False,
                "message": "Internal server error",
                "error_id": error_id,
                "server_time": datetime.now(UTC).isoformat(),
            },
        )
