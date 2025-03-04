"""
Live tracking module for vehicle monitoring.

This module handles real-time tracking of vehicles using the Bouncie API.
It manages WebSocket connections for delivering updates to clients and processes
incoming webhook events from Bouncie related to trips in progress.

Key components:
- ConnectionManager: Manages WebSocket connections with clients
- Webhook handlers: Process tripStart, tripData, and tripEnd events
- WebSocket endpoint: Provides real-time updates to clients
- API endpoints: For querying active trip status
"""

import os
import uuid
import logging
import asyncio
import json
import time
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from timestamp_utils import get_trip_timestamps, sort_and_filter_trip_coordinates
from utils import haversine

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Initialize db collections as module-level variables
# These will be set when initialize_db is called
live_trips_collection = None
archived_live_trips_collection = None


def initialize_db(db_live_trips, db_archived_live_trips):
    """
    Initialize the database collections used by this module.

    Args:
        db_live_trips: MongoDB collection for active trips
        db_archived_live_trips: MongoDB collection for archived trips
    """
    global live_trips_collection, archived_live_trips_collection
    live_trips_collection = db_live_trips
    archived_live_trips_collection = db_archived_live_trips
    logger.info("Live tracking database collections initialized")


class ConnectionManager:
    """
    Manages WebSocket connections and broadcast messages.
    Tracks connection count and ensures proper cleanup of disconnected clients.
    Includes heartbeat mechanism to detect and clean up stale connections.
    """

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.connection_count = 0
        self._lock = asyncio.Lock()  # Add a lock for thread safety
        self._heartbeat_task = None
        self._connection_metadata = {}  # Store metadata about connections
        self.heartbeat_interval = 30  # seconds

    async def connect(self, websocket: WebSocket) -> str:
        """
        Accept a new WebSocket connection and add it to the active connections list.

        Args:
            websocket (WebSocket): The WebSocket connection to add

        Returns:
            str: A unique client ID for the connection
        """
        await websocket.accept()
        client_id = str(uuid.uuid4())

        async with self._lock:
            self.active_connections.append(websocket)
            self.connection_count += 1
            # Store connection metadata
            self._connection_metadata[id(websocket)] = {
                "client_id": client_id,
                "connected_at": datetime.now(timezone.utc),
                "last_activity": time.time(),
                "client_info": websocket.client,
            }
            logger.info(
                "Client %s connected. Total connections: %s",
                client_id,
                self.connection_count,
            )

        # Start heartbeat task if not already running
        if not self._heartbeat_task or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat_monitor())
            self._heartbeat_task.add_done_callback(self._handle_task_done)

        return client_id

    async def disconnect(self, websocket: WebSocket) -> None:
        """
        Remove a WebSocket connection from the active connections list.

        Args:
            websocket (WebSocket): The WebSocket connection to remove
        """
        async with self._lock:
            if websocket in self.active_connections:
                client_id = self._connection_metadata.get(id(websocket), {}).get(
                    "client_id", "Unknown"
                )
                self.active_connections.remove(websocket)
                if id(websocket) in self._connection_metadata:
                    del self._connection_metadata[id(websocket)]
                self.connection_count -= 1
                logger.info(
                    "Client %s disconnected. Remaining connections: %s",
                    client_id,
                    self.connection_count,
                )

    def _handle_task_done(self, future):
        """Handle completed tasks to catch any exceptions."""
        try:
            future.result()
        except Exception as e:
            logger.error("WebSocket task failed: %s", e, exc_info=True)

    async def _heartbeat_monitor(self):
        """
        Monitor connections and remove stale ones.
        """
        try:
            while True:
                await asyncio.sleep(self.heartbeat_interval)
                await self._check_connections()
        except asyncio.CancelledError:
            logger.info("Heartbeat monitor cancelled")
        except Exception as e:
            logger.error("Error in heartbeat monitor: %s", e, exc_info=True)
            raise

    async def _check_connections(self):
        """Check all connections and remove stale ones."""
        now = time.time()
        stale_threshold = now - (self.heartbeat_interval * 3)  # 3x heartbeat interval

        # Copy to avoid modification during iteration
        connections = list(self.active_connections)
        for ws in connections:
            metadata = self._connection_metadata.get(id(ws), {})
            last_activity = metadata.get("last_activity", 0)

            if last_activity < stale_threshold:
                client_id = metadata.get("client_id", "Unknown")
                logger.warning("Closing stale connection from client %s", client_id)
                try:
                    await ws.close(code=1000, reason="Connection timeout")
                except Exception as e:
                    logger.warning("Error closing stale connection: %s", e)
                finally:
                    await self.disconnect(ws)

    async def broadcast(self, message: str) -> int:
        """
        Broadcast a message to all connected clients.

        Args:
            message (str): The message to broadcast

        Returns:
            int: The number of clients that received the message
        """
        delivered_count = 0
        disconnected = []

        # Make a copy of the connections to avoid modification during iteration
        connections = list(self.active_connections)

        for websocket in connections:
            try:
                await websocket.send_text(message)
                delivered_count += 1

                # Update last activity time
                if id(websocket) in self._connection_metadata:
                    self._connection_metadata[id(websocket)][
                        "last_activity"
                    ] = time.time()
            except Exception as e:
                logger.warning("Error sending message to client: %s", str(e))
                disconnected.append(websocket)

        # Remove any disconnected clients
        for websocket in disconnected:
            await self.disconnect(websocket)

        return delivered_count

    async def send_to_client(self, client_id: str, message: str) -> bool:
        """
        Send a message to a specific client by client_id.

        Args:
            client_id: The client ID to send to
            message: The message to send

        Returns:
            bool: True if message was sent, False otherwise
        """
        # Find the websocket for this client_id
        target_ws = None
        for ws in self.active_connections:
            if self._connection_metadata.get(id(ws), {}).get("client_id") == client_id:
                target_ws = ws
                break

        if not target_ws:
            return False

        try:
            await target_ws.send_text(message)
            # Update last activity time
            if id(target_ws) in self._connection_metadata:
                self._connection_metadata[id(target_ws)]["last_activity"] = time.time()
            return True
        except Exception as e:
            logger.warning("Error sending message to client %s: %s", client_id, e)
            await self.disconnect(target_ws)
            return False

    async def cleanup(self):
        """Close all WebSocket connections and reset state."""
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass

        logger.info("Closing %d active WebSocket connections", self.connection_count)
        connections = list(self.active_connections)
        for websocket in connections:
            try:
                await websocket.close(code=1000, reason="Server shutdown")
            except Exception as e:
                logger.warning("Error closing WebSocket connection: %s", str(e))

        # Reset the manager state
        self.active_connections = []
        self._connection_metadata = {}
        self.connection_count = 0
        logger.info("All WebSocket connections closed")


# Create a global instance of the ConnectionManager
manager = ConnectionManager()


async def serialize_live_trip(trip_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert MongoDB document to JSON-serializable dict for live trips

    Args:
        trip_data: The trip document from MongoDB

    Returns:
        Dict: A JSON-serializable representation of the trip
    """
    serialized = dict(trip_data)

    # Convert ObjectId to string
    if "_id" in serialized:
        serialized["_id"] = str(serialized["_id"])

    # Convert datetime objects to ISO format strings
    for key in ("startTime", "lastUpdate", "endTime"):
        if key in serialized and isinstance(serialized[key], datetime):
            serialized[key] = serialized[key].isoformat()

    # Convert timestamps in coordinates
    if "coordinates" in serialized and serialized["coordinates"]:
        for coord in serialized["coordinates"]:
            ts = coord.get("timestamp")
            if isinstance(ts, datetime):
                coord["timestamp"] = ts.isoformat()

    # Ensure all required fields are present
    serialized.setdefault("distance", 0)
    serialized.setdefault("currentSpeed", 0)
    serialized.setdefault("maxSpeed", 0)
    serialized.setdefault("duration", 0)

    return serialized


async def process_trip_start(data: Dict[str, Any]) -> None:
    """
    Process a tripStart event from the Bouncie webhook

    Args:
        data: The webhook payload
    """
    transaction_id = data.get("transactionId")
    start_time, _ = get_trip_timestamps(data)

    # Clear any existing active trips with this transaction ID
    await live_trips_collection.delete_many(
        {"transactionId": transaction_id, "status": "active"}
    )

    # Create new trip
    await live_trips_collection.insert_one(
        {
            "transactionId": transaction_id,
            "status": "active",
            "startTime": start_time,
            "coordinates": [],
            "lastUpdate": start_time,
            "distance": 0,
            "currentSpeed": 0,
            "maxSpeed": 0,
        }
    )
    logger.info("Trip started: %s", transaction_id)


async def process_trip_data(data: Dict[str, Any]) -> None:
    """
    Process a tripData event from the Bouncie webhook

    Args:
        data: The webhook payload
    """
    transaction_id = data.get("transactionId")

    # Get or create trip document
    trip_doc = await live_trips_collection.find_one(
        {"transactionId": transaction_id, "status": "active"}
    )
    if not trip_doc:
        # If no active trip found, create one
        now = datetime.now(timezone.utc)
        await live_trips_collection.insert_one(
            {
                "transactionId": transaction_id,
                "status": "active",
                "startTime": now,
                "coordinates": [],
                "lastUpdate": now,
                "distance": 0,
                "currentSpeed": 0,
                "maxSpeed": 0,
            }
        )
        trip_doc = await live_trips_collection.find_one(
            {"transactionId": transaction_id, "status": "active"}
        )
        logger.info(f"Created new trip for existing trip data: {transaction_id}")

    # Process trip data
    if "data" in data:
        new_coords = sort_and_filter_trip_coordinates(data["data"])
        all_coords = trip_doc.get("coordinates", []) + new_coords
        all_coords.sort(key=lambda c: c["timestamp"])

        # Calculate current speed and distance
        current_speed = 0
        if len(all_coords) >= 2:
            last_point = all_coords[-1]
            prev_point = all_coords[-2]

            # Calculate distance between last two points
            distance = haversine(
                prev_point["lon"],
                prev_point["lat"],
                last_point["lon"],
                last_point["lat"],
                unit="miles",
            )

            # Calculate time difference in hours
            time_diff = (
                last_point["timestamp"] - prev_point["timestamp"]
            ).total_seconds() / 3600

            if time_diff > 0:
                current_speed = distance / time_diff

        # Calculate total distance
        total_distance = trip_doc.get("distance", 0)
        if len(new_coords) >= 2:
            for i in range(1, len(new_coords)):
                prev = new_coords[i - 1]
                curr = new_coords[i]
                total_distance += haversine(
                    prev["lon"],
                    prev["lat"],
                    curr["lon"],
                    curr["lat"],
                    unit="miles",
                )

        # Update max speed if needed
        max_speed = max(trip_doc.get("maxSpeed", 0), current_speed)

        # Calculate duration
        duration = (
            (all_coords[-1]["timestamp"] - trip_doc["startTime"]).total_seconds()
            if all_coords
            else 0
        )

        # Update trip in database
        await live_trips_collection.update_one(
            {"_id": trip_doc["_id"]},
            {
                "$set": {
                    "coordinates": all_coords,
                    "lastUpdate": (
                        all_coords[-1]["timestamp"]
                        if all_coords
                        else trip_doc["startTime"]
                    ),
                    "distance": total_distance,
                    "currentSpeed": current_speed,
                    "maxSpeed": max_speed,
                    "duration": duration,
                }
            },
        )
        logger.debug(
            f"Updated trip data: {transaction_id} with {len(new_coords)} new points"
        )


async def process_trip_end(data: Dict[str, Any]) -> None:
    """
    Process a tripEnd event from the Bouncie webhook

    Args:
        data: The webhook payload
    """
    transaction_id = data.get("transactionId")
    _, end_time = get_trip_timestamps(data)

    trip = await live_trips_collection.find_one({"transactionId": transaction_id})
    if trip:
        trip["endTime"] = end_time
        trip["status"] = "completed"
        await archived_live_trips_collection.insert_one(trip)
        await live_trips_collection.delete_one({"_id": trip["_id"]})
        logger.info("Trip ended: %s", transaction_id)


async def handle_bouncie_webhook(data: Dict[str, Any]) -> Dict[str, str]:
    """
    Handle webhook events from Bouncie API

    Args:
        data: The webhook payload

    Returns:
        Dict: Response to send back to Bouncie
    """
    try:
        event_type = data.get("eventType")
        if not event_type:
            logger.error("Missing eventType in webhook data")
            return {"status": "success", "message": "Event processed"}

        transaction_id = data.get("transactionId")
        if event_type in ("tripStart", "tripData", "tripEnd") and not transaction_id:
            logger.error("Missing transactionId for trip event")
            return {"status": "success", "message": "Event processed"}

        # Handle trip events
        if event_type == "tripStart":
            await process_trip_start(data)
        elif event_type == "tripData":
            await process_trip_data(data)
        elif event_type == "tripEnd":
            await process_trip_end(data)

        # Broadcast updates to all connected clients
        try:
            active_trip = await live_trips_collection.find_one({"status": "active"})
            if active_trip:
                serialized_trip = await serialize_live_trip(active_trip)
                message = {"type": "trip_update", "data": serialized_trip}
            else:
                message = {"type": "heartbeat"}

            # Use the return value to check how many clients received the message
            clients_received = await manager.broadcast(json.dumps(message))
            if clients_received > 0:
                logger.debug("Successfully broadcast to %d clients", clients_received)
            else:
                logger.debug("No active clients to receive broadcast")
        except Exception as broadcast_error:
            logger.exception(
                f"Error broadcasting webhook update: {str(broadcast_error)}"
            )

        return {"status": "success", "message": "Event processed"}
    except Exception as e:
        logger.exception("Error in bouncie_webhook: %s", str(e))
        return {"status": "success", "message": "Event processed with errors"}


async def get_active_trip() -> Dict[str, Any]:
    """
    Get the currently active trip

    Returns:
        Dict: The active trip data, serialized for JSON response

    Raises:
        HTTPException: If no active trip is found
    """
    active_trip = await live_trips_collection.find_one({"status": "active"})
    if active_trip:
        return await serialize_live_trip(active_trip)
    return None


async def handle_live_trip_websocket(websocket: WebSocket):
    """
    WebSocket endpoint for live trip updates.
    Handles connection, initial data sending, and ping/pong for keepalive.

    Args:
        websocket: The WebSocket connection
    """
    client_id = None

    try:
        # Connect the WebSocket and get a client ID
        client_id = await manager.connect(websocket)

        # Send initial trip data when client connects
        active_trip = await live_trips_collection.find_one({"status": "active"})
        if active_trip:
            # Serialize the active trip
            serialized_trip = await serialize_live_trip(active_trip)
            await websocket.send_json({"type": "trip_update", "data": serialized_trip})
        else:
            # Only send heartbeat if the connection is still open
            if websocket.client_state != WebSocketState.DISCONNECTED:
                await websocket.send_json({"type": "heartbeat"})
            else:
                logger.info(
                    f"Client {client_id} connection already closed before initial heartbeat"
                )
                return

        # Keep the connection alive by handling ping/pong
        heartbeat_interval = 30  # seconds
        last_heartbeat = datetime.now(timezone.utc)

        while True:
            try:
                # Set a timeout so we can periodically send heartbeats
                data = await asyncio.wait_for(
                    websocket.receive_text(), timeout=heartbeat_interval
                )

                if data == "ping":
                    # Check if the connection is still open before sending pong
                    if websocket.client_state != WebSocketState.DISCONNECTED:
                        await websocket.send_text("pong")
                        last_heartbeat = datetime.now(timezone.utc)
                    else:
                        logger.info(
                            f"Client {client_id} connection already closed, breaking loop"
                        )
                        break
                elif data:  # Handle any other messages
                    logger.debug(
                        f"Received message from client {client_id}: {data[:100]}"
                    )
                    last_heartbeat = datetime.now(timezone.utc)

            except asyncio.TimeoutError:
                # Time to send a heartbeat
                current_time = datetime.now(timezone.utc)
                if (
                    current_time - last_heartbeat
                ).total_seconds() >= heartbeat_interval:
                    try:
                        # Check if the connection is still open before sending the heartbeat
                        if websocket.client_state != WebSocketState.DISCONNECTED:
                            await websocket.send_json({"type": "heartbeat"})
                            last_heartbeat = current_time
                        else:
                            logger.info(
                                f"Client {client_id} connection already closed, breaking loop"
                            )
                            break
                    except Exception as e:
                        logger.warning(
                            f"Failed to send heartbeat to {client_id}: {str(e)}"
                        )
                        # Connection is probably dead
                        break

            except WebSocketDisconnect:
                logger.info(
                    "Client %s disconnected during receive operation", client_id
                )
                break

            except Exception as e:
                logger.error(
                    "Unexpected error in WebSocket connection for %s: %s",
                    client_id,
                    e,
                    exc_info=True,
                )
                break

            # Small sleep to prevent tight CPU loop
            await asyncio.sleep(0.1)

    except WebSocketDisconnect:
        logger.info("WebSocket client %s disconnected", client_id)
    except Exception as e:
        logger.exception("WebSocket error: %s", str(e))
    finally:
        # Always make sure to disconnect properly
        if client_id:
            await manager.disconnect(websocket)


async def cleanup_stale_trips():
    """
    Cleanup trips that haven't been updated recently

    Returns:
        int: Number of trips cleaned up
    """
    now = datetime.now(timezone.utc)
    stale_threshold = now - timedelta(minutes=5)
    cleanup_count = 0

    while True:
        trip = await live_trips_collection.find_one_and_delete(
            {"lastUpdate": {"$lt": stale_threshold}, "status": "active"},
            projection={"_id": False},
        )
        if not trip:
            break
        trip["status"] = "stale"
        trip["endTime"] = now
        await archived_live_trips_collection.insert_one(trip)
        cleanup_count += 1

    logger.info("Cleaned up %d stale trips", cleanup_count)
    return cleanup_count
