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
from trip_processor import TripProcessor

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

    # Ensure all required fields are present with defaults
    serialized.setdefault("distance", 0)  # miles
    serialized.setdefault("currentSpeed", 0)  # mph
    serialized.setdefault("maxSpeed", 0)  # mph
    serialized.setdefault("avgSpeed", 0)  # mph
    serialized.setdefault("duration", 0)  # seconds
    serialized.setdefault(
        "pointsRecorded", len(
            serialized.get(
                "coordinates", [])))

    # Calculate formatted duration for display
    duration_seconds = serialized.get("duration", 0)
    hours = int(duration_seconds // 3600)
    minutes = int((duration_seconds % 3600) // 60)
    seconds = int(duration_seconds % 60)
    serialized["durationFormatted"] = f"{hours}:{minutes:02d}:{seconds:02d}"

    # Format time values for display
    if "startTime" in serialized:
        try:
            start_time = datetime.fromisoformat(
                serialized["startTime"].replace("Z", "+00:00")
            )
            serialized["startTimeFormatted"] = start_time.strftime(
                "%Y-%m-%d %H:%M:%S")
        except (ValueError, AttributeError):
            serialized["startTimeFormatted"] = "Unknown"

    # If we have coordinates but missing metrics, recalculate them
    if serialized.get("coordinates") and serialized.get("distance") == 0:
        coordinates = serialized.get("coordinates", [])
        if len(coordinates) >= 2:
            # Recalculate distance if needed
            total_distance = 0
            for i in range(1, len(coordinates)):
                prev = coordinates[i - 1]
                curr = coordinates[i]
                total_distance += haversine(prev["lon"],
                                            prev["lat"],
                                            curr["lon"],
                                            curr["lat"],
                                            unit="miles")
            serialized["distance"] = total_distance

            # Recalculate speeds if needed
            if "startTime" in serialized and "lastUpdate" in serialized:
                try:
                    start = datetime.fromisoformat(
                        serialized["startTime"].replace("Z", "+00:00")
                    )
                    last = datetime.fromisoformat(
                        serialized["lastUpdate"].replace("Z", "+00:00")
                    )
                    duration_hours = (last - start).total_seconds() / 3600
                    if duration_hours > 0:
                        serialized["avgSpeed"] = total_distance / \
                            duration_hours
                except (ValueError, AttributeError):
                    pass

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

    # Check if there's already an active trip for this transaction ID
    existing_trip = await live_trips_collection.find_one(
        {"transactionId": transaction_id, "status": "active"}
    )

    if existing_trip:
        logger.info(
            "Updating existing active trip: %s, created at %s",
            transaction_id,
            existing_trip.get("startTime"),
        )
    else:
        logger.info("Creating new active trip: %s", transaction_id)

    # Clear any existing active trips with this transaction ID
    delete_result = await live_trips_collection.delete_many(
        {"transactionId": transaction_id, "status": "active"}
    )

    if delete_result.deleted_count > 0:
        logger.info(
            "Deleted %d existing active trip records for %s",
            delete_result.deleted_count,
            transaction_id,
        )

    # Create new trip with a sequence number for tracking updates
    sequence = int(time.time() * 1000)  # Millisecond timestamp as sequence

    # Create initial trip document with all required fields
    new_trip = {
        "transactionId": transaction_id,
        "status": "active",
        "startTime": start_time,
        "coordinates": [],
        "lastUpdate": start_time,
        "distance": 0,  # miles
        "currentSpeed": 0,  # mph
        "maxSpeed": 0,  # mph
        "avgSpeed": 0,  # mph
        "duration": 0,  # seconds
        "pointsRecorded": 0,  # count
        "sequence": sequence,
    }

    result = await live_trips_collection.insert_one(new_trip)

    # Verify the trip was actually inserted
    if result.inserted_id:
        inserted_trip = await live_trips_collection.find_one(
            {"_id": result.inserted_id}
        )
        if inserted_trip:
            logger.info(
                "Trip started: %s (verified in database with seq=%s)",
                transaction_id,
                sequence,
            )
        else:
            logger.warning(
                "Trip inserted but not found on verification: %s",
                transaction_id)
    else:
        logger.error("Failed to insert trip: %s", transaction_id)


async def process_trip_data(data: Dict[str, Any]) -> None:
    """
    Process a tripData event from the Bouncie webhook using the TripProcessor
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
                "avgSpeed": 0,
                "sequence": sequence,
            }
        )
        trip_doc = await live_trips_collection.find_one(
            {"transactionId": transaction_id, "status": "active"}
        )
        logger.info(
            f"Created new trip for existing trip data: {transaction_id}")

    # Process trip data
    if "data" in data:
        # First process the coordinates using the existing function
        new_coords = sort_and_filter_trip_coordinates(data["data"])

        # Update with the current coordinates
        all_coords = trip_doc.get("coordinates", []) + new_coords
        all_coords.sort(key=lambda c: c["timestamp"])

        # Use the TripProcessor to handle metrics calculations
        # First, create a trip-like object
        trip_like = {
            "transactionId": transaction_id,
            "startTime": trip_doc["startTime"],
            "gps": {
                "type": "LineString",
                "coordinates": [[c["lon"], c["lat"]] for c in all_coords],
            },
        }

        # Process it
        processor = TripProcessor(source="live")
        processor.set_trip_data(trip_like)
        await processor.validate()
        await processor.process_basic()

        # Extract calculated metrics
        current_speed = 0
        total_distance = processor.processed_data.get("distance", 0)

        # Calculate current speed from last two points if available
        if len(all_coords) >= 2:
            last_point = all_coords[-1]
            prev_point = all_coords[-2]

            # Calculate time difference in hours
            time_diff = (
                last_point["timestamp"] - prev_point["timestamp"]
            ).total_seconds() / 3600

            if time_diff > 0:
                # Calculate distance for just this segment
                distance = haversine(
                    prev_point["lon"],
                    prev_point["lat"],
                    last_point["lon"],
                    last_point["lat"],
                    unit="miles",
                )
                current_speed = distance / time_diff

        # Update max speed if needed
        max_speed = max(trip_doc.get("maxSpeed", 0), current_speed)

        # Calculate duration
        duration_seconds = (
            (all_coords[-1]["timestamp"] - trip_doc["startTime"]).total_seconds()
            if all_coords
            else 0
        )

        # Calculate average speed (in mph)
        avg_speed = 0
        if duration_seconds > 0:
            # Convert seconds to hours for mph calculation
            duration_hours = duration_seconds / 3600
            avg_speed = total_distance / duration_hours if duration_hours > 0 else 0

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
                    "avgSpeed": avg_speed,
                    "duration": duration_seconds,
                    "sequence": sequence,
                    "pointsRecorded": len(all_coords),
                }
            },
        )
        logger.info(
            f"Updated trip data: {transaction_id} with {
                len(new_coords)} new points (total: {
                len(all_coords)})"
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
        if event_type in (
            "tripStart",
            "tripData",
                "tripEnd") and not transaction_id:
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


async def get_active_trip(
        since_sequence: Optional[int] = None) -> Dict[str, Any]:
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

    # Try to find an active trip
    active_trip = await live_trips_collection.find_one(query, sort=[("lastUpdate", -1)])

    if active_trip:
        logger.info(
            "Found active trip: %s with sequence %s",
            active_trip.get("transactionId"),
            active_trip.get("sequence"),
        )
        return await serialize_live_trip(active_trip)

    # If no active trip found with the current query, log this for debugging
    logger.info("No active trip found with query: %s", query)

    # If we're looking for updates (since_sequence is set), but didn't find any,
    # check if there are any active trips at all regardless of sequence
    if since_sequence is not None:
        any_active_trip = await live_trips_collection.find_one({"status": "active"})
        if any_active_trip:
            logger.info(
                "Found active trip but sequence isn't newer than %s. Trip has sequence %s",
                since_sequence,
                any_active_trip.get("sequence"),
            )

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

        # Mark the trip as stale instead of active
        trip["status"] = "completed"
        trip["endTime"] = now

        # Calculate final duration before archiving
        if "startTime" in trip and isinstance(trip["startTime"], datetime):
            duration_seconds = (now - trip["startTime"]).total_seconds()
            trip["duration"] = duration_seconds

        await archived_live_trips_collection.insert_one(trip)
        cleanup_count += 1

    logger.info("Cleaned up %d stale trips", cleanup_count)
    return cleanup_count


async def get_trip_updates(last_sequence: int = 0) -> Dict[str, Any]:
    """
    Get updates about the currently active trip since a specified sequence number

    Args:
        last_sequence: Only return updates newer than this sequence

    Returns:
        Dict: Contains status, has_update flag, and trip data if available
    """
    try:
        logger.info("Getting trip updates since sequence: %d", last_sequence)

        # First, check if there are ANY active trips at all
        any_active = await live_trips_collection.find_one({"status": "active"})
        if not any_active:
            logger.info("No active trips found in the database")
            return {
                "status": "success",
                "has_update": False,
                "message": "No active trips",
            }

        # Now check for updates with sequence newer than last_sequence
        active_trip = await get_active_trip(last_sequence)

        if not active_trip:
            # Check if there's an active trip but the sequence isn't newer
            all_trips = await live_trips_collection.find({"status": "active"}).to_list(
                10
            )
            sequences = [t.get("sequence", 0) for t in all_trips]
            logger.info(
                "No newer trip updates. Found %d active trips with sequences: %s. Client has sequence: %d",
                len(all_trips),
                sequences,
                last_sequence,
            )
            return {
                "status": "success",
                "has_update": False,
                "message": "No new updates since last check",
            }

        logger.info(
            "Found trip update: %s with sequence %d (client had %d)",
            active_trip.get("transactionId", "unknown"),
            active_trip.get("sequence", 0),
            last_sequence,
        )

        return {
            "status": "success",
            "has_update": True,
            "trip": active_trip,
        }
    except Exception as e:
        logger.exception("Error getting trip updates: %s", str(e))
        return {
            "status": "error",
            "has_update": False,
            "message": f"Error: {str(e)}",
        }
