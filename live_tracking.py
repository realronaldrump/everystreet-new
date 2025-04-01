"""Live tracking module for vehicle monitoring using polling instead of
WebSockets.

This module handles real-time tracking of vehicles using the Bouncie API.
It manages data storage and retrieval for real-time updates, processed via
polling from clients rather than WebSocket connections.

Key features:
- Transaction safety for critical operations
- Consistent data serialization
- Memory-efficient processing
- Proper error handling
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from db import SerializationHelper, run_transaction
from timestamp_utils import (
    get_trip_timestamps,
    sort_and_filter_trip_coordinates,
)
from trip_processor import TripProcessor
from utils import haversine

logger = logging.getLogger(__name__)

# Initialize db collections as module-level variables
# These will be set when initialize_db is called
live_trips_collection = None
archived_live_trips_collection = None


def initialize_db(db_live_trips, db_archived_live_trips):
    """Initialize the database collections used by this module.

    Args:
        db_live_trips: MongoDB collection for active trips
        db_archived_live_trips: MongoDB collection for archived trips
    """
    global live_trips_collection, archived_live_trips_collection
    live_trips_collection = db_live_trips
    archived_live_trips_collection = db_archived_live_trips
    logger.info("Live tracking database collections initialized")


async def serialize_live_trip(trip_data: Dict[str, Any]) -> Dict[str, Any]:
    """Convert MongoDB document to JSON-serializable dict for live trips. Uses
    the common serialization helper for consistency.

    Args:
        trip_data: The trip document from MongoDB

    Returns:
        Dict: A JSON-serializable representation of the trip
    """
    if not trip_data:
        return None

    # Use common serialization helper for basic fields
    serialized = SerializationHelper.serialize_document(trip_data)

    # Additional format-specific processing for live trip data
    serialized.setdefault("distance", 0)  # miles
    serialized.setdefault("currentSpeed", 0)  # mph
    serialized.setdefault("maxSpeed", 0)  # mph
    serialized.setdefault("avgSpeed", 0)  # mph
    serialized.setdefault("duration", 0)  # seconds
    serialized.setdefault(
        "pointsRecorded", len(serialized.get("coordinates", []))
    )

    # Calculate formatted duration for display
    duration_seconds = serialized.get("duration", 0)
    hours = int(duration_seconds // 3600)
    minutes = int((duration_seconds % 3600) // 60)
    seconds = int(duration_seconds % 60)
    serialized["durationFormatted"] = f"{hours}:{minutes:02d}:{seconds:02d}"

    # Format time values for display
    if "startTime" in serialized:
        try:
            start_time = (
                datetime.fromisoformat(
                    serialized["startTime"].replace("Z", "+00:00")
                )
                if isinstance(serialized["startTime"], str)
                else serialized["startTime"]
            )
            serialized["startTimeFormatted"] = start_time.strftime(
                "%Y-%m-%d %H:%M:%S"
            )
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
                total_distance += haversine(
                    prev["lon"],
                    prev["lat"],
                    curr["lon"],
                    curr["lat"],
                    unit="miles",
                )
            serialized["distance"] = total_distance

            # Recalculate speeds if needed
            if "startTime" in serialized and "lastUpdate" in serialized:
                try:
                    start = (
                        datetime.fromisoformat(
                            serialized["startTime"].replace("Z", "+00:00")
                        )
                        if isinstance(serialized["startTime"], str)
                        else serialized["startTime"]
                    )
                    last = (
                        datetime.fromisoformat(
                            serialized["lastUpdate"].replace("Z", "+00:00")
                        )
                        if isinstance(serialized["lastUpdate"], str)
                        else serialized["lastUpdate"]
                    )
                    duration_hours = (last - start).total_seconds() / 3600
                    if duration_hours > 0:
                        serialized["avgSpeed"] = (
                            total_distance / duration_hours
                        )
                except (ValueError, AttributeError, TypeError):
                    pass

    # Add a sequence number for client tracking if not present
    if "sequence" not in serialized:
        serialized["sequence"] = int(
            time.time() * 1000
        )  # Millisecond timestamp as sequence

    return serialized


async def process_trip_start(data: Dict[str, Any]) -> None:
    """Process a tripStart event from the Bouncie webhook.

    Args:
        data: The webhook payload
    """

    # Check if live_trips_collection is initialized
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized")
        return

    transaction_id = data.get("transactionId")
    if not transaction_id:
        logger.error("Missing transactionId in tripStart event")
        return

    start_time, _ = get_trip_timestamps(data)
    if not start_time:
        logger.error(
            "Failed to extract start time from tripStart event for %s",
            transaction_id,
        )
        start_time = datetime.now(timezone.utc)

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

    # Transaction-safe operation: delete any existing active trips with this ID and insert new one
    async def operation_a(session=None):
        await live_trips_collection.delete_many(
            {"transactionId": transaction_id, "status": "active"},
            session=session,
        )

    async def operation_b(session=None):
        await live_trips_collection.insert_one(new_trip, session=session)

    success = await run_transaction([operation_a, operation_b])

    if success:
        logger.info(
            "Trip started: %s (verified in database with seq=%s)",
            transaction_id,
            sequence,
        )
    else:
        logger.error(
            "Failed to start trip: %s (transaction failed)", transaction_id
        )


async def process_trip_data(data: Dict[str, Any]) -> None:
    """Process a tripData event from the Bouncie webhook using the
    TripProcessor."""

    # Check if live_trips_collection is initialized
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized")
        return

    transaction_id = data.get("transactionId")
    if not transaction_id:
        logger.error("Missing transactionId in tripData event")
        return

    # Get or create trip document
    trip_doc = await live_trips_collection.find_one(
        {"transactionId": transaction_id, "status": "active"}
    )
    if not trip_doc:
        # Check if a tripStart event was missed by looking for this transaction ID in archived trips
        archived_trip = None
        if archived_live_trips_collection is not None:
            archived_trip = await archived_live_trips_collection.find_one(
                {"transactionId": transaction_id}
            )

        if archived_trip:
            logger.warning(
                "Received data for archived trip: %s, ignoring", transaction_id
            )
            return

        # If no active trip found, create one but log a warning as this is unexpected
        logger.warning(
            "Received trip data for unknown trip: %s, creating new trip",
            transaction_id,
        )
        now = datetime.now(timezone.utc)

        # Try to extract a better start time from the data
        start_time = now
        if "data" in data and data["data"]:
            # Find the earliest timestamp in the data
            timestamps = []
            for point in data["data"]:
                if "timestamp" in point:
                    try:
                        ts = datetime.fromisoformat(
                            point["timestamp"].replace("Z", "+00:00")
                        )
                        timestamps.append(ts)
                    except (ValueError, AttributeError):
                        pass
            if timestamps:
                start_time = min(timestamps)
                logger.info(
                    "Using earliest timestamp from data as start time: %s",
                    start_time,
                )

        sequence = int(time.time() * 1000)

        # Insert new trip document
        trip_doc = {
            "transactionId": transaction_id,
            "status": "active",
            "startTime": start_time,
            "coordinates": [],
            "lastUpdate": now,
            "distance": 0,
            "currentSpeed": 0,
            "maxSpeed": 0,
            "avgSpeed": 0,
            "sequence": sequence,
            "created_from_data": True,  # Flag to indicate this was created from a data event
        }

        await live_trips_collection.insert_one(trip_doc)
        logger.info(
            "Created new trip for existing trip data: %s", transaction_id
        )

    # Process trip data
    if "data" not in data:
        logger.warning("No data in tripData event for %s", transaction_id)
        return

    # First process the coordinates using the existing function
    new_coords = sort_and_filter_trip_coordinates(data["data"])
    if not new_coords:
        logger.warning(
            "No valid coordinates in tripData event for %s", transaction_id
        )
        return

    # Update with the current coordinates
    all_coords = trip_doc.get("coordinates", []) + new_coords

    # Sort by timestamp to ensure correct order
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
        avg_speed = (
            total_distance / duration_hours if duration_hours > 0 else 0
        )

    # Get the current highest sequence number and increment it
    highest_sequence = trip_doc.get("sequence", 0)
    sequence = max(highest_sequence + 1, int(time.time() * 1000))

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
        "Updated trip data: %s with %d new points (total: %d)",
        transaction_id,
        len(new_coords),
        len(all_coords),
    )


async def process_trip_end(data: Dict[str, Any]) -> None:
    """Process a tripEnd event from the Bouncie webhook with transaction
    safety. Archives a trip and removes it from active trips atomically.

    Args:
        data: The webhook payload
    """

    # Check if collections are initialized
    if live_trips_collection is None or archived_live_trips_collection is None:
        logger.error("Live trip collections not initialized")
        return

    transaction_id = data.get("transactionId")
    if not transaction_id:
        logger.error("Missing transactionId in tripEnd event")
        return

    _, end_time = get_trip_timestamps(data)
    if not end_time:
        logger.error(
            "Failed to extract end time from tripEnd event for %s",
            transaction_id,
        )
        end_time = datetime.now(timezone.utc)

    trip = await live_trips_collection.find_one(
        {"transactionId": transaction_id}
    )
    if not trip:
        logger.warning(
            "Received tripEnd event for unknown trip: %s", transaction_id
        )
        return

    trip_id = trip["_id"]
    start_time = trip.get("startTime")

    # Calculate trip metrics for logging
    duration = (end_time - start_time).total_seconds() if start_time else 0
    distance = trip.get("distance", 0)
    avg_speed = trip.get("avgSpeed", 0)
    max_speed = trip.get("maxSpeed", 0)

    logger.info(
        "Ending trip %s: duration=%.1fs, distance=%.2fmi, avg_speed=%.1fmph, max_speed=%.1fmph",
        transaction_id,
        duration,
        distance,
        avg_speed,
        max_speed,
    )

    # Remove _id field before archiving to avoid MongoDB error
    trip_to_archive = trip.copy()
    del trip_to_archive["_id"]

    # Update with end data
    trip_to_archive["endTime"] = end_time
    trip_to_archive["status"] = "completed"
    trip_to_archive["closed_reason"] = "normal"
    # Set final sequence number before archiving
    trip_to_archive["sequence"] = int(time.time() * 1000)

    # Use transaction to ensure atomicity
    async def archive_operation(session=None):
        await archived_live_trips_collection.insert_one(
            trip_to_archive, session=session
        )

    async def delete_operation(session=None):
        await live_trips_collection.delete_one(
            {"_id": trip_id}, session=session
        )

    success = await run_transaction([archive_operation, delete_operation])

    if success:
        logger.info("Trip %s successfully archived", transaction_id)
    else:
        logger.error(
            "Transaction failed when archiving trip %s", transaction_id
        )


async def handle_bouncie_webhook(data: Dict[str, Any]) -> Dict[str, str]:
    """Handle webhook events from Bouncie API.

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
        if (
            event_type in ("tripStart", "tripData", "tripEnd")
            and not transaction_id
        ):
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
    since_sequence: Optional[int] = None,
) -> Dict[str, Any]:
    """Get the currently active trip with optional filtering by sequence
    number.

    Args:
        since_sequence: Only return trip if it's newer than this sequence number

    Returns:
        Dict: The active trip data, serialized for JSON response, or None if no update
    """

    # Check if live_trips_collection is initialized
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized")
        return None

    query = {"status": "active"}

    # If a sequence number is provided, only return newer data
    if since_sequence is not None:
        query["sequence"] = {"$gt": since_sequence}

    # Try to find an active trip
    active_trip = await live_trips_collection.find_one(
        query, sort=[("lastUpdate", -1)]
    )

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
        any_active_trip = await live_trips_collection.find_one(
            {"status": "active"}
        )
        if any_active_trip:
            logger.info(
                "Found active trip but sequence isn't newer than %s. Trip has sequence %s",
                since_sequence,
                any_active_trip.get("sequence"),
            )

    return None


async def cleanup_stale_trips(
    stale_minutes: int = 5, max_archive_age_days: int = 30
) -> Dict[str, int]:
    """Cleanup trips that haven't been updated recently and limit archived
    trips.

    Args:
        stale_minutes: Number of minutes of inactivity to consider a trip stale
        max_archive_age_days: Maximum age in days to keep archived trips

    Returns:
        Dict: Containing counts of stale trips moved and old archived trips removed
    """

    # Check if collections are initialized
    if live_trips_collection is None or archived_live_trips_collection is None:
        logger.error("Live trip collections not initialized")
        return {"stale_trips_archived": 0, "old_archives_removed": 0}

    now = datetime.now(timezone.utc)
    stale_threshold = now - timedelta(minutes=stale_minutes)
    archive_threshold = now - timedelta(days=max_archive_age_days)
    cleanup_count = 0
    archive_cleanup_count = 0

    # Cleanup stale active trips with transaction safety
    try:
        # Find all stale trips
        stale_trips = await live_trips_collection.find(
            {"lastUpdate": {"$lt": stale_threshold}, "status": "active"}
        ).to_list(length=100)  # Limit to avoid potential memory issues

        for trip in stale_trips:
            trip_id = trip.get("_id")
            transaction_id = trip.get("transactionId", "unknown")

            # Mark the trip as stale instead of active and prepare for archiving
            trip["status"] = "completed"
            trip["endTime"] = now
            trip["closed_reason"] = "stale"

            # Calculate final duration before archiving
            if "startTime" in trip and isinstance(trip["startTime"], datetime):
                duration_seconds = (now - trip["startTime"]).total_seconds()
                trip["duration"] = duration_seconds

            # Remove _id to avoid duplicate key issues
            trip_to_archive = trip.copy()
            del trip_to_archive["_id"]

            # Use transaction for safety
            async def archive_stale_op():
                await archived_live_trips_collection.insert_one(
                    trip_to_archive
                )

            async def delete_stale_op():
                await live_trips_collection.delete_one({"_id": trip_id})

            success = await run_transaction(
                [archive_stale_op, delete_stale_op]
            )

            if success:
                cleanup_count += 1
                logger.info("Archived stale trip: %s", transaction_id)
            else:
                logger.error(
                    "Failed to archive stale trip: %s", transaction_id
                )

        # Also cleanup old archived trips
        old_archive_result = await archived_live_trips_collection.delete_many(
            {"endTime": {"$lt": archive_threshold}}
        )
        archive_cleanup_count = old_archive_result.deleted_count

        if archive_cleanup_count > 0:
            logger.info(
                "Deleted %d old archived trips (older than %d days)",
                archive_cleanup_count,
                max_archive_age_days,
            )

    except Exception as e:
        logger.exception("Error during stale trip cleanup: %s", str(e))

    logger.info("Cleaned up %s stale trips", cleanup_count)
    return {
        "stale_trips_archived": cleanup_count,
        "old_archives_removed": archive_cleanup_count,
    }


async def get_trip_updates(last_sequence: int = 0) -> Dict[str, Any]:
    """Get updates about the currently active trip since a specified sequence
    number.

    Args:
        last_sequence: Only return updates newer than this sequence

    Returns:
        Dict: Contains status, has_update flag, and trip data if available
    """

    # Check if live_trips_collection is initialized
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized")
        return {
            "status": "error",
            "has_update": False,
            "message": "Database not initialized",
        }

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
            all_trips = await live_trips_collection.find(
                {"status": "active"}
            ).to_list(10)
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
