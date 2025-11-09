import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from fastapi import (
    APIRouter,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketState

from db import BSONJSONEncoder, db_manager, serialize_document
from live_tracking import (
    get_active_trip,
    get_trip_updates,
    process_trip_data,
    process_trip_end,
    process_trip_metrics,
    process_trip_start,
)
from models import (
    ActiveTripResponseUnion,
    ActiveTripSuccessResponse,
    NoActiveTripResponse,
)
from redis_config import get_redis_url
from trip_event_publisher import TRIP_UPDATES_CHANNEL

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()


async def _process_bouncie_event_inline(data: dict[str, Any]) -> dict[str, Any]:
    """Handle a webhook payload synchronously using live tracking helpers."""
    event_type = data.get("eventType")
    transaction_id = data.get("transactionId")

    live_collection = db_manager.get_collection("live_trips")
    archive_collection = db_manager.get_collection("archived_live_trips")

    if live_collection is None or archive_collection is None:
        raise RuntimeError("Database collections for live tracking are not ready.")

    if event_type == "tripStart":
        await process_trip_start(data, live_collection)
        return {
            "status": "processed",
            "event": event_type,
            "transactionId": transaction_id,
        }
    if event_type == "tripData":
        await process_trip_data(data, live_collection)
        return {
            "status": "processed",
            "event": event_type,
            "transactionId": transaction_id,
        }
    if event_type == "tripMetrics":
        await process_trip_metrics(data, live_collection, archive_collection)
        return {
            "status": "processed",
            "event": event_type,
            "transactionId": transaction_id,
        }
    if event_type == "tripEnd":
        await process_trip_end(data, live_collection, archive_collection)
        return {
            "status": "processed",
            "event": event_type,
            "transactionId": transaction_id,
        }
    if event_type in {"connect", "disconnect", "battery", "mil"}:
        logger.info(
            "Received non-trip event type %s (TxID=%s); skipping inline processing.",
            event_type,
            transaction_id or "N/A",
        )
        return {
            "status": "ignored",
            "event": event_type,
            "transactionId": transaction_id,
        }

    logger.warning(
        "Received unknown event type %s (TxID=%s); ignoring.",
        event_type,
        transaction_id or "N/A",
    )
    return {
        "status": "unknown_event",
        "event": event_type,
        "transactionId": transaction_id,
    }


# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)


manager = ConnectionManager()


# WebSocket Endpoint
@router.websocket("/ws/trips")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    last_sequence = 0
    redis_client = None
    pubsub = None
    listen_task = None

    async def listen_for_updates():
        """Listen for Redis messages and send them to the websocket."""
        nonlocal last_sequence
        try:
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue

                try:
                    event_data = json.loads(message["data"])

                    # Check if this update is newer than what the client has
                    event_sequence = event_data.get("sequence", 0)
                    if event_sequence <= last_sequence:
                        continue

                    event_type = event_data.get("event_type")

                    if event_type != "trip_state":
                        logger.debug(
                            "Skipping unknown trip event type %s from pubsub",
                            event_type,
                        )
                        continue

                    trip_payload = event_data.get("trip")
                    if not trip_payload:
                        logger.debug("Trip state event missing payload, skipping.")
                        continue

                    status = event_data.get("status", "active")

                    if websocket.application_state != WebSocketState.CONNECTED:
                        logger.debug(
                            "WebSocket state is %s; stopping listener.",
                            websocket.application_state,
                        )
                        break

                    try:
                        await websocket.send_text(
                            json.dumps(
                                {
                                    "type": "trip_state",
                                    "trip": trip_payload,
                                    "sequence": event_sequence,
                                    "status": status,
                                    "transaction_id": event_data.get("transaction_id"),
                                },
                                cls=BSONJSONEncoder,
                            )
                        )
                        last_sequence = event_sequence
                    except WebSocketDisconnect:
                        logger.info(
                            "WebSocket disconnected while sending update; stopping listener."
                        )
                        break
                    except RuntimeError as send_error:
                        error_message = str(send_error)
                        if (
                            'Cannot call "send" once a close message has been sent.'
                            in error_message
                        ):
                            logger.debug(
                                "WebSocket closed before sending update; stopping listener."
                            )
                            break
                        raise

                except json.JSONDecodeError as e:
                    logger.warning("Failed to parse Redis message: %s", e)
                except Exception as e:
                    logger.error("Error processing Redis message: %s", e, exc_info=True)
        except Exception as e:
            # This will catch WebSocket disconnects and other errors
            logger.debug("Redis listening task ended: %s", e)
            raise

    try:
        # Load initial trip state on connection
        initial_trip = await get_active_trip()
        if initial_trip:
            serialized_trip = serialize_document(initial_trip)
            last_sequence = initial_trip.get("sequence", 0)
            await websocket.send_text(
                json.dumps(
                    {
                        "type": "trip_state",
                        "trip": serialized_trip,
                        "sequence": last_sequence,
                        "status": serialized_trip.get("status", "active"),
                    },
                    cls=BSONJSONEncoder,
                )
            )

        # Connect to Redis and subscribe to trip updates channel
        redis_url = get_redis_url()
        redis_client = await aioredis.from_url(redis_url, decode_responses=True)
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(TRIP_UPDATES_CHANNEL)

        logger.info("WebSocket connected and subscribed to Redis channel")

        # Start listening for updates in a separate task
        import asyncio

        listen_task = asyncio.create_task(listen_for_updates())

        # Wait for either the listen task to complete or websocket to disconnect
        try:
            await listen_task
        except Exception:
            # listen_task will raise exceptions including WebSocketDisconnect
            pass

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error("WebSocket error: %s", e, exc_info=True)
    finally:
        # Cancel the listening task if it's still running
        if listen_task and not listen_task.done():
            listen_task.cancel()
            try:
                await listen_task
            except asyncio.CancelledError:
                pass

        manager.disconnect(websocket)
        if pubsub:
            try:
                await pubsub.unsubscribe(TRIP_UPDATES_CHANNEL)
                await pubsub.close()
            except Exception as e:
                logger.warning("Error closing Redis pubsub: %s", e)
        if redis_client:
            try:
                await redis_client.close()
            except Exception as e:
                logger.warning("Error closing Redis client: %s", e)


# API Endpoints


@router.post("/webhook/bouncie")
async def bouncie_webhook(request: Request):
    """Receives webhook events from Bouncie, acknowledges immediately,
    and schedules background processing via Celery.
    """
    try:
        raw_body = await request.body()
        try:
            data = json.loads(raw_body)
        except json.JSONDecodeError:
            logger.error(
                "Failed to parse JSON from Bouncie webhook request body.",
            )
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "Invalid JSON body",
                },
                status_code=400,
            )

        event_type = data.get("eventType")
        transaction_id = data.get("transactionId")

        if not event_type:
            logger.warning(
                "Webhook received with missing eventType. Acknowledging but not queuing. Body: %s",
                raw_body[:500],
            )
            return JSONResponse(
                content={"status": "acknowledged_invalid_event"},
                status_code=200,
            )

        logger.info(
            "Webhook received: Type=%s, TransactionID=%s. Processing inline.",
            event_type,
            transaction_id or "N/A",
        )

        try:
            inline_result = await _process_bouncie_event_inline(data)
            logger.debug(
                "Inline processing result for webhook: %s",
                inline_result,
            )
        except Exception as inline_err:
            error_id = str(uuid.uuid4())
            logger.exception(
                "Failed to process webhook inline [%s]: Type=%s, TxID=%s, Error: %s",
                error_id,
                event_type,
                transaction_id or "N/A",
                inline_err,
            )
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "Failed to process webhook",
                    "error_id": error_id,
                },
                status_code=500,
            )

        return JSONResponse(
            content={"status": "processed", "detail": inline_result},
            status_code=200,
        )

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception(
            "Critical error handling webhook request before queuing [%s]: %s",
            error_id,
            e,
        )
        return JSONResponse(
            content={
                "status": "error",
                "message": "Internal server error",
                "error_id": error_id,
            },
            status_code=500,
        )


@router.get(
    "/api/active_trip",
    response_model=ActiveTripResponseUnion,
    summary="Get Currently Active Trip",
    description="Retrieves the latest active trip, optionally filtering if it's newer than a given sequence number.",
)
async def active_trip_endpoint():
    """Get the currently active trip, if any."""
    try:
        logger.info("Fetching active trip data")
        active_trip_doc = await get_active_trip()

        if not active_trip_doc:
            logger.debug("No active trip found (or not newer than sequence)")
            return NoActiveTripResponse(server_time=datetime.now(timezone.utc))

        logger.info(
            "Returning active trip: %s",
            active_trip_doc.get("transactionId", "unknown"),
        )
        return ActiveTripSuccessResponse(
            trip=active_trip_doc,
            server_time=datetime.now(timezone.utc),
        )

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception(
            "Internal error fetching active trip [%s]: %s",
            error_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "An internal error occurred while retrieving the active trip.",
                "error_id": error_id,
            },
        )


@router.get("/api/trip_updates")
async def trip_updates_endpoint(last_sequence: int = Query(0, ge=0)):
    """Get trip updates since a specific sequence number.

    Args:
        last_sequence: Only return updates newer than this sequence

    Returns:
        Dict: Contains status, has_update flag, and trip data if available

    """
    try:
        logger.debug(
            "Fetching trip updates since sequence %d",
            last_sequence,
        )

        if not db_manager.connection_healthy:  # type: ignore
            logger.error("Database connection is unhealthy")
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={
                    "status": "error",
                    "has_update": False,
                    "message": "Database connection error",
                    "error_code": "DB_CONNECTION_ERROR",
                    "server_time": datetime.now(timezone.utc).isoformat(),
                },
            )

        updates = await get_trip_updates(last_sequence)

        if updates.get("has_update"):
            logger.info(
                "Returning trip update with sequence %d",
                updates.get("trip", {}).get("sequence", 0),
            )
        else:
            logger.debug(
                "No trip updates found since sequence %d",
                last_sequence,
            )

        updates["server_time"] = datetime.now(timezone.utc).isoformat()
        return updates

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception(
            "Error in trip_updates endpoint [%s]: %s",
            error_id,
            str(e),
        )

        error_message = str(e)
        error_code = "INTERNAL_ERROR"
        status_code_val = status.HTTP_500_INTERNAL_SERVER_ERROR

        if (
            "Cannot connect to database" in error_message
            or "ServerSelectionTimeoutError" in error_message
        ):
            error_code = "DB_CONNECTION_ERROR"
            status_code_val = status.HTTP_503_SERVICE_UNAVAILABLE
        elif "Memory" in error_message:  # type: ignore
            error_code = "MEMORY_ERROR"

        return JSONResponse(
            status_code=status_code_val,
            content={
                "status": "error",
                "has_update": False,
                "message": f"Error retrieving trip updates: {error_message}",
                "error_id": error_id,
                "error_code": error_code,
                "server_time": datetime.now(timezone.utc).isoformat(),
            },
        )
