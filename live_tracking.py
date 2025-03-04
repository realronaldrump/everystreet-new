"""
Live tracking module for vehicle monitoring using polling instead of WebSockets.

This module handles real-time tracking of vehicles using the Bouncie API.
It manages data storage and retrieval for real-time updates, processed via
polling from clients rather than WebSocket connections.

Key components:
- Trip data management: Store active and archived trip data
- Data processing: Handle incoming webhook events from Bouncie
- API endpoints: Provide data retrieval for polling clients
"""

import os
import uuid
import logging
import json
import time
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional

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


async def serialize_live_trip(trip_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert MongoDB document to JSON-serializable dict for live trips

    Args:
        trip_data: The trip document from MongoDB

    Returns:
        Dict: A JSON-serializable representation of the trip
    """
    if not trip_data:
        return None

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

    # Add a sequence number for client tracking if not present
    if "sequence" not in serialized:
        serialized["sequence"] = int(
            time.time() * 1000
        )  # Millisecond timestamp as sequence

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

    # Create new trip with a sequence number for tracking updates
    sequence = int(time.time() * 1000)  # Millisecond timestamp as sequence

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
            "sequence": sequence,
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
        sequence = int(time.time() * 1000)  # Millisecond timestamp as sequence

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
                "sequence": sequence,
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

        # Generate a new sequence number for this update
        sequence = int(time.time() * 1000)

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
                    "sequence": sequence,
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
        # Set final sequence number before archiving
        trip["sequence"] = int(time.time() * 1000)

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

        return {"status": "success", "message": "Event processed"}
    except Exception as e:
        logger.exception("Error in bouncie_webhook: %s", str(e))
        return {"status": "success", "message": "Event processed with errors"}


async def get_active_trip(since_sequence: Optional[int] = None) -> Dict[str, Any]:
    """
    Get the currently active trip with optional filtering by sequence number

    Args:
        since_sequence: Only return trip if it's newer than this sequence number

    Returns:
        Dict: The active trip data, serialized for JSON response, or None if no update

    Raises:
        HTTPException: If no active trip is found
    """
    query = {"status": "active"}

    # If a sequence number is provided, only return newer data
    if since_sequence is not None:
        query["sequence"] = {"$gt": since_sequence}

    active_trip = await live_trips_collection.find_one(query)
    if active_trip:
        return await serialize_live_trip(active_trip)
    return None


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


async def get_trip_updates(last_sequence: int = 0) -> Dict[str, Any]:
    """
    Get trip updates since a specific sequence number

    Args:
        last_sequence: The last sequence number client has seen

    Returns:
        Dict: Contains active trip data if newer than provided sequence,
              status information, and server timestamp
    """
    try:
        # Get active trip only if newer than the provided sequence
        active_trip = await get_active_trip(last_sequence)

        # Get current server time for synchronization
        server_time = datetime.now(timezone.utc).isoformat()

        if active_trip:
            return {
                "status": "success",
                "has_update": True,
                "trip": active_trip,
                "server_time": server_time,
            }
        else:
            # Check if there's any active trip at all
            any_active_trip = await live_trips_collection.find_one({"status": "active"})

            if any_active_trip:
                # There is an active trip, but no new updates since the last sequence
                return {
                    "status": "success",
                    "has_update": False,
                    "message": "No new updates",
                    "server_time": server_time,
                }
            else:
                # No active trips at all
                return {
                    "status": "success",
                    "has_update": False,
                    "message": "No active trips",
                    "server_time": server_time,
                }

    except Exception as e:
        logger.exception("Error in get_trip_updates: %s", str(e))
        return {
            "status": "error",
            "message": "Error retrieving trip updates",
            "server_time": datetime.now(timezone.utc).isoformat(),
        }
