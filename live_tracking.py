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
- Adherence to Bouncie Webhook API specification
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from db import SerializationHelper, run_transaction
from timestamp_utils import (
    sort_and_filter_trip_coordinates,
)
from utils import haversine

logger = logging.getLogger(__name__)

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


def _parse_iso_datetime(timestamp_str: Optional[str]) -> Optional[datetime]:
    """Safely parse an ISO 8601 timestamp string into a timezone-aware datetime object (UTC).

    Args:
        timestamp_str: The ISO 8601 formatted string.

    Returns:
        A timezone-aware datetime object (UTC) or None if parsing fails.
    """
    if not timestamp_str or not isinstance(timestamp_str, str):
        return None
    try:
        if timestamp_str.endswith("Z"):
            timestamp_str = timestamp_str[:-1] + "+00:00"
        dt = datetime.fromisoformat(timestamp_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError) as e:
        logger.error("Error parsing timestamp string '%s': %s", timestamp_str, e)
        return None


async def serialize_live_trip(
    trip_data: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Convert MongoDB document to JSON-serializable dict for live trips. Uses
    the common serialization helper for consistency.

    Args:
        trip_data: The trip document from MongoDB

    Returns:
        Dict: A JSON-serializable representation of the trip, or None if input is invalid.
    """
    if not trip_data or not isinstance(trip_data, dict):
        logger.warning("serialize_live_trip called with invalid data: %s", trip_data)
        return None

    serialized = SerializationHelper.serialize_document(trip_data)
    transaction_id = serialized.get("transactionId", "N/A")

    serialized.setdefault("distance", 0.0)
    serialized.setdefault("currentSpeed", 0.0)
    serialized.setdefault("maxSpeed", 0.0)
    serialized.setdefault("avgSpeed", 0.0)
    serialized.setdefault("duration", 0)
    serialized.setdefault("status", "unknown")
    coordinates = serialized.get("coordinates", [])
    serialized.setdefault("pointsRecorded", len(coordinates))

    serialized.setdefault("startOdometer", trip_data.get("startOdometer"))
    serialized.setdefault("totalIdlingTime", trip_data.get("totalIdlingTime", 0))
    serialized.setdefault("hardBrakingCounts", trip_data.get("hardBrakingCounts", 0))
    serialized.setdefault(
        "hardAccelerationCounts", trip_data.get("hardAccelerationCounts", 0)
    )

    duration_seconds = serialized.get("duration", 0)
    try:
        duration_seconds = (
            float(duration_seconds) if duration_seconds is not None else 0
        )
        hours = int(duration_seconds // 3600)
        minutes = int((duration_seconds % 3600) // 60)
        seconds = int(duration_seconds % 60)
        serialized["durationFormatted"] = f"{hours}:{minutes:02d}:{seconds:02d}"
    except (ValueError, TypeError):
        logger.error(
            "Invalid duration value '%s' for trip %s, defaulting.",
            serialized.get("duration"),
            transaction_id,
        )
        serialized["duration"] = 0
        serialized["durationFormatted"] = "0:00:00"

    start_time_value = serialized.get("startTime")
    startTimeFormatted = "Awaiting Start..."

    if isinstance(start_time_value, datetime):
        start_time_obj = start_time_value
        if start_time_obj.tzinfo is None:
            start_time_obj = start_time_obj.replace(tzinfo=timezone.utc)
        start_time_obj = start_time_obj.astimezone(timezone.utc)
        try:
            startTimeFormatted = start_time_obj.strftime("%Y-%m-%d %H:%M:%S %Z")
        except Exception as e:
            logger.error(
                "Error formatting valid startTime object %s for trip %s: %s",
                start_time_obj,
                transaction_id,
                e,
            )
            startTimeFormatted = "Error Formatting"
    elif start_time_value is not None:
        logger.warning(
            "Unexpected type for startTime during serialization for trip %s: %s. Expected datetime, got %s.",
            transaction_id,
            start_time_value,
            type(start_time_value).__name__,
        )
        startTimeFormatted = "Invalid Data"

    serialized["startTimeFormatted"] = startTimeFormatted

    if coordinates and serialized.get("distance") == 0 and len(coordinates) >= 2:
        logger.info(
            "Recalculating distance for trip %s as it was 0 despite having coordinates.",
            transaction_id,
        )
        total_distance = 0.0
        max_calculated_speed = 0.0
        valid_speeds = []

        for i in range(1, len(coordinates)):
            prev = coordinates[i - 1]
            curr = coordinates[i]

            if not all(k in prev for k in ("lon", "lat", "timestamp")) or not all(
                k in curr for k in ("lon", "lat", "timestamp")
            ):
                logger.warning(
                    "Skipping coordinate pair due to missing data in recalculation for trip %s",
                    transaction_id,
                )
                continue

            prev_ts = prev["timestamp"]
            curr_ts = curr["timestamp"]
            if not isinstance(prev_ts, datetime) or not isinstance(curr_ts, datetime):
                logger.warning(
                    "Skipping coordinate pair due to invalid timestamp types in recalculation for trip %s",
                    transaction_id,
                )
                continue

            segment_distance = haversine(
                prev["lon"],
                prev["lat"],
                curr["lon"],
                curr["lat"],
                unit="miles",
            )
            total_distance += segment_distance

            time_diff_seconds = (curr_ts - prev_ts).total_seconds()
            if time_diff_seconds > 0:
                segment_speed_mph = (segment_distance / time_diff_seconds) * 3600
                valid_speeds.append(segment_speed_mph)
                max_calculated_speed = max(max_calculated_speed, segment_speed_mph)

        serialized["distance"] = total_distance
        if max_calculated_speed > serialized["maxSpeed"]:
            serialized["maxSpeed"] = max_calculated_speed

        if duration_seconds > 0:
            duration_hours = duration_seconds / 3600
            serialized["avgSpeed"] = total_distance / duration_hours
        elif valid_speeds:
            serialized["avgSpeed"] = sum(valid_speeds) / len(valid_speeds)

    serialized.setdefault("sequence", int(time.time() * 1000))

    return serialized


async def process_trip_start(data: Dict[str, Any]) -> None:
    """Process a tripStart event from the Bouncie webhook.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
    """
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized. Cannot process tripStart.")
        return

    transaction_id = data.get("transactionId")
    start_data = data.get("start")
    vin = data.get("vin")
    imei = data.get("imei")

    if not transaction_id:
        logger.error("Missing transactionId in tripStart event. Payload: %s", data)
        return
    if not start_data or not isinstance(start_data, dict):
        logger.error(
            "Missing or invalid 'start' object in tripStart event for %s. Payload: %s",
            transaction_id,
            data,
        )
        return
    if not vin or not imei:
        logger.warning("Missing vin or imei in tripStart event for %s.", transaction_id)

    start_timestamp_str = start_data.get("timestamp")
    start_time_zone = start_data.get("timeZone")
    start_odometer = start_data.get("odometer")

    start_time = _parse_iso_datetime(start_timestamp_str)

    if not start_time:
        logger.error(
            "Failed to extract valid start time from tripStart event for %s. Timestamp string: '%s'. Using current time as fallback.",
            transaction_id,
            start_timestamp_str,
        )
        start_time = datetime.now(timezone.utc)

    logger.info("Processing tripStart event for transactionId: %s", transaction_id)

    sequence = int(time.time() * 1000)

    new_trip = {
        "transactionId": transaction_id,
        "vin": vin,
        "imei": imei,
        "status": "active",
        "startTime": start_time,
        "startTimeZone": start_time_zone,
        "startOdometer": start_odometer,
        "coordinates": [],
        "lastUpdate": start_time,
        "distance": 0.0,
        "currentSpeed": 0.0,
        "maxSpeed": 0.0,
        "avgSpeed": 0.0,
        "duration": 0,
        "pointsRecorded": 0,
        "sequence": sequence,
        "totalIdlingTime": 0,
        "hardBrakingCounts": 0,
        "hardAccelerationCounts": 0,
        "fuelConsumed": None,
        "endTime": None,
        "endTimeZone": None,
        "endOdometer": None,
        "closed_reason": None,
    }

    async def delete_existing_op(session=None):
        await live_trips_collection.delete_many(
            {"transactionId": transaction_id, "status": "active"},
            session=session,
        )

    async def insert_new_op(session=None):
        await live_trips_collection.insert_one(new_trip, session=session)

    success = await run_transaction([delete_existing_op, insert_new_op])

    if success:
        logger.info(
            "Trip started and created in DB: %s (seq=%s)",
            transaction_id,
            sequence,
        )
    else:
        logger.error(
            "Failed to start trip: %s (database transaction failed)",
            transaction_id,
        )


async def process_trip_data(data: Dict[str, Any]) -> None:
    """Process a tripData event from the Bouncie webhook.

    Updates coordinates and recalculates live metrics for an active trip.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
    """
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized. Cannot process tripData.")
        return

    transaction_id = data.get("transactionId")
    trip_data_points = data.get("data")

    if not transaction_id:
        logger.error("Missing transactionId in tripData event. Payload: %s", data)
        return
    if not trip_data_points or not isinstance(trip_data_points, list):
        logger.warning(
            "Missing or invalid 'data' array in tripData event for %s. Payload: %s",
            transaction_id,
            data,
        )
        return

    trip_doc = await live_trips_collection.find_one(
        {"transactionId": transaction_id, "status": "active"}
    )

    if not trip_doc:
        if archived_live_trips_collection:
            archived_trip = await archived_live_trips_collection.find_one(
                {"transactionId": transaction_id}
            )
            if archived_trip:
                logger.warning(
                    "Received tripData for already completed/archived trip: %s. Ignoring.",
                    transaction_id,
                )
                return

        logger.warning(
            "Received tripData for unknown or inactive trip: %s. Ignoring data as no active trip found.",
            transaction_id,
        )
        return

    logger.info(
        "Processing tripData event for transactionId: %s with %d points",
        transaction_id,
        len(trip_data_points),
    )

    try:
        new_coords = sort_and_filter_trip_coordinates(trip_data_points)
    except Exception as e:
        logger.error(
            "Error processing coordinates from tripData for %s: %s",
            transaction_id,
            e,
        )
        return

    if not new_coords:
        logger.warning(
            "No valid new coordinates found after processing tripData for %s.",
            transaction_id,
        )
        return

    existing_coords = trip_doc.get("coordinates", [])
    all_coords = existing_coords + new_coords

    unique_coords_map = {c["timestamp"].isoformat(): c for c in all_coords}
    sorted_unique_coords = sorted(
        unique_coords_map.values(), key=lambda c: c["timestamp"]
    )

    if not sorted_unique_coords:
        logger.warning(
            "No coordinates available after deduplication for trip %s.",
            transaction_id,
        )
        return

    start_time = trip_doc.get("startTime")
    if not isinstance(start_time, datetime):
        logger.error(
            "Invalid or missing startTime in existing trip document for %s. Cannot calculate duration/avgSpeed accurately.",
            transaction_id,
        )
        start_time = sorted_unique_coords[0]["timestamp"]

    last_point_time = sorted_unique_coords[-1]["timestamp"]
    duration_seconds = (
        (last_point_time - start_time).total_seconds() if start_time else 0
    )

    max_segment_speed = 0.0
    current_speed = 0.0

    if len(sorted_unique_coords) >= 2:
        for i in range(1, len(sorted_unique_coords)):
            prev = sorted_unique_coords[i - 1]
            curr = sorted_unique_coords[i]

            if not all(k in prev for k in ("lon", "lat", "timestamp")) or not all(
                k in curr for k in ("lon", "lat", "timestamp")
            ):
                continue

            segment_distance = haversine(
                prev["lon"],
                prev["lat"],
                curr["lon"],
                curr["lat"],
                unit="miles",
            )

            time_diff_seconds = (curr["timestamp"] - prev["timestamp"]).total_seconds()
            if time_diff_seconds > 0:
                segment_speed_mph = (segment_distance / time_diff_seconds) * 3600
                max_segment_speed = max(max_segment_speed, segment_speed_mph)
                if i == len(sorted_unique_coords) - 1:
                    current_speed = segment_speed_mph

    max_speed = max(trip_doc.get("maxSpeed", 0.0), max_segment_speed)

    full_trip_distance = 0.0
    if len(sorted_unique_coords) >= 2:
        for i in range(1, len(sorted_unique_coords)):
            prev = sorted_unique_coords[i - 1]
            curr = sorted_unique_coords[i]
            if not all(k in prev for k in ("lon", "lat")) or not all(
                k in curr for k in ("lon", "lat")
            ):
                continue
            full_trip_distance += haversine(
                prev["lon"],
                prev["lat"],
                curr["lon"],
                curr["lat"],
                unit="miles",
            )

    avg_speed = 0.0
    if duration_seconds > 0:
        duration_hours = duration_seconds / 3600
        avg_speed = full_trip_distance / duration_hours if duration_hours > 0 else 0.0

    sequence = max(trip_doc.get("sequence", 0) + 1, int(time.time() * 1000))

    update_result = await live_trips_collection.update_one(
        {"_id": trip_doc["_id"]},
        {
            "$set": {
                "coordinates": sorted_unique_coords,
                "lastUpdate": last_point_time,
                "distance": full_trip_distance,
                "currentSpeed": current_speed,
                "maxSpeed": max_speed,
                "avgSpeed": avg_speed,
                "duration": duration_seconds,
                "sequence": sequence,
                "pointsRecorded": len(sorted_unique_coords),
            }
        },
    )

    if update_result.modified_count > 0:
        logger.info(
            "Updated trip data: %s with %d new points (total unique: %d, seq=%d)",
            transaction_id,
            len(new_coords),
            len(sorted_unique_coords),
            sequence,
        )
    elif update_result.matched_count == 0:
        logger.error(
            "Failed to find trip %s for update after processing data.",
            transaction_id,
        )
    else:
        logger.info(
            "Trip data for %s processed, but no fields were modified in DB (data might be duplicate or unchanged).",
            transaction_id,
        )


async def process_trip_metrics(data: Dict[str, Any]) -> None:
    """Process a tripMetrics event from the Bouncie webhook.

    Updates an active trip with summary metrics provided by Bouncie.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
    """
    if live_trips_collection is None:
        logger.error(
            "Live trips collection not initialized. Cannot process tripMetrics."
        )
        return

    transaction_id = data.get("transactionId")
    metrics_data = data.get("metrics")

    if not transaction_id:
        logger.error("Missing transactionId in tripMetrics event. Payload: %s", data)
        return
    if not metrics_data or not isinstance(metrics_data, dict):
        logger.error(
            "Missing or invalid 'metrics' object in tripMetrics event for %s. Payload: %s",
            transaction_id,
            data,
        )
        return

    trip_doc = await live_trips_collection.find_one(
        {"transactionId": transaction_id, "status": "active"}
    )

    if not trip_doc:
        logger.warning(
            "Received tripMetrics for unknown or inactive trip: %s. Ignoring metrics.",
            transaction_id,
        )
        return

    logger.info("Processing tripMetrics event for transactionId: %s", transaction_id)

    update_fields = {}
    metrics_timestamp_str = metrics_data.get("timestamp")
    metrics_timestamp = _parse_iso_datetime(metrics_timestamp_str)

    if "tripTime" in metrics_data:
        update_fields["duration"] = metrics_data["tripTime"]
    if "tripDistance" in metrics_data:
        update_fields["distance"] = metrics_data["tripDistance"]
    if "totalIdlingTime" in metrics_data:
        update_fields["totalIdlingTime"] = metrics_data["totalIdlingTime"]
    if "maxSpeed" in metrics_data:
        update_fields["maxSpeed"] = max(
            trip_doc.get("maxSpeed", 0.0), metrics_data["maxSpeed"]
        )
    if "averageDriveSpeed" in metrics_data:
        update_fields["avgSpeed"] = metrics_data["averageDriveSpeed"]
    if "hardBrakingCounts" in metrics_data:
        update_fields["hardBrakingCounts"] = metrics_data["hardBrakingCounts"]
    if "hardAccelerationCounts" in metrics_data:
        update_fields["hardAccelerationCounts"] = metrics_data["hardAccelerationCounts"]

    if not update_fields:
        logger.warning(
            "No valid metrics found to update in tripMetrics payload for %s.",
            transaction_id,
        )
        return

    update_fields["lastUpdate"] = metrics_timestamp or trip_doc.get("lastUpdate")
    update_fields["sequence"] = max(
        trip_doc.get("sequence", 0) + 1, int(time.time() * 1000)
    )

    update_result = await live_trips_collection.update_one(
        {"_id": trip_doc["_id"]}, {"$set": update_fields}
    )

    if update_result.modified_count > 0:
        logger.info(
            "Updated trip metrics for: %s (seq=%d)",
            transaction_id,
            update_fields["sequence"],
        )
    elif update_result.matched_count == 0:
        logger.error("Failed to find trip %s for metrics update.", transaction_id)
    else:
        logger.info(
            "Trip metrics for %s processed, but no fields were modified in DB.",
            transaction_id,
        )


async def process_trip_end(data: Dict[str, Any]) -> None:
    """Process a tripEnd event from the Bouncie webhook with transaction safety.

    Archives the active trip and adds final details from the payload.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
    """
    if live_trips_collection is None or archived_live_trips_collection is None:
        logger.error(
            "Live or archived trip collections not initialized. Cannot process tripEnd."
        )
        return

    transaction_id = data.get("transactionId")
    end_data = data.get("end")

    if not transaction_id:
        logger.error("Missing transactionId in tripEnd event. Payload: %s", data)
        return
    if not end_data or not isinstance(end_data, dict):
        logger.error(
            "Missing or invalid 'end' object in tripEnd event for %s. Payload: %s",
            transaction_id,
            data,
        )
        return

    end_timestamp_str = end_data.get("timestamp")
    end_time_zone = end_data.get("timeZone")
    end_odometer = end_data.get("odometer")
    fuel_consumed = end_data.get("fuelConsumed")

    end_time = _parse_iso_datetime(end_timestamp_str)

    if not end_time:
        logger.error(
            "Failed to extract valid end time from tripEnd event for %s. Timestamp string: '%s'. Using current time as fallback.",
            transaction_id,
            end_timestamp_str,
        )
        end_time = datetime.now(timezone.utc)

    trip = await live_trips_collection.find_one(
        {
            "transactionId": transaction_id,
            "status": "active",
        }
    )

    if not trip:
        already_archived = await archived_live_trips_collection.find_one(
            {"transactionId": transaction_id}
        )
        if already_archived:
            logger.warning(
                "Received tripEnd event for already completed/archived trip: %s. Ignoring.",
                transaction_id,
            )
        else:
            logger.warning(
                "Received tripEnd event for unknown or inactive trip: %s. Cannot archive.",
                transaction_id,
            )
        return

    logger.info("Processing tripEnd event for transactionId: %s", transaction_id)
    trip_id = trip["_id"]
    start_time = trip.get("startTime")

    trip_to_archive = trip.copy()
    if "_id" in trip_to_archive:
        del trip_to_archive["_id"]

    trip_to_archive["endTime"] = end_time
    trip_to_archive["endTimeZone"] = end_time_zone
    trip_to_archive["endOdometer"] = end_odometer
    trip_to_archive["fuelConsumed"] = fuel_consumed
    trip_to_archive["status"] = "completed"
    trip_to_archive["closed_reason"] = "normal"
    trip_to_archive["lastUpdate"] = end_time

    if isinstance(start_time, datetime) and isinstance(end_time, datetime):
        final_duration_seconds = (end_time - start_time).total_seconds()
        trip_to_archive["duration"] = final_duration_seconds
    else:
        logger.warning(
            "Could not calculate final duration for trip %s due to invalid start/end times.",
            transaction_id,
        )
        trip_to_archive.setdefault("duration", 0)

    trip_to_archive["sequence"] = max(
        trip.get("sequence", 0) + 1, int(time.time() * 1000)
    )

    final_duration = trip_to_archive.get("duration", 0)
    final_distance = trip_to_archive.get("distance", 0)
    final_avg_speed = trip_to_archive.get("avgSpeed", 0)
    final_max_speed = trip_to_archive.get("maxSpeed", 0)
    logger.info(
        "Ending trip %s: duration=%.1fs, distance=%.2fmi, avg_speed=%.1fmph, max_speed=%.1fmph, fuel=%.3fgal",
        transaction_id,
        final_duration,
        final_distance,
        final_avg_speed,
        final_max_speed,
        fuel_consumed if fuel_consumed is not None else 0.0,
    )

    async def archive_operation(session=None):
        await archived_live_trips_collection.insert_one(
            trip_to_archive, session=session
        )

    async def delete_operation(session=None):
        await live_trips_collection.delete_one({"_id": trip_id}, session=session)

    success = await run_transaction([archive_operation, delete_operation])

    if success:
        logger.info("Trip %s successfully ended and archived", transaction_id)
    else:
        logger.error(
            "Transaction failed when ending and archiving trip %s",
            transaction_id,
        )


async def handle_bouncie_webhook(data: Dict[str, Any]) -> Dict[str, str]:
    """Handle webhook events from Bouncie API.

    Routes events to the appropriate processing function.

    Args:
        data: The webhook payload

    Returns:
        Dict: Response to send back to Bouncie (always success to acknowledge receipt)
    """
    event_type = data.get("eventType")
    transaction_id = data.get("transactionId")

    logger.debug(
        "Received webhook event: %s (Transaction ID: %s)",
        event_type,
        transaction_id or "N/A",
    )

    try:
        if not event_type:
            logger.error("Missing eventType in webhook data: %s", data)
            return {
                "status": "success",
                "message": "Event processed (missing eventType)",
            }

        if (
            event_type in ("tripStart", "tripData", "tripMetrics", "tripEnd")
            and not transaction_id
        ):
            logger.error("Missing transactionId for %s event: %s", event_type, data)
            return {
                "status": "success",
                "message": f"Event processed (missing transactionId for {event_type})",
            }

        if event_type == "tripStart":
            await process_trip_start(data)
        elif event_type == "tripData":
            await process_trip_data(data)
        elif event_type == "tripMetrics":
            await process_trip_metrics(data)
        elif event_type == "tripEnd":
            await process_trip_end(data)
        else:
            logger.info("Received unhandled event type: %s", event_type)

        return {"status": "success", "message": "Event processed"}

    except Exception as e:
        logger.exception(
            "Error processing webhook event %s (Transaction ID: %s): %s",
            event_type,
            transaction_id or "N/A",
            str(e),
        )
        return {
            "status": "success",
            "message": "Event processed with internal errors",
        }


async def get_active_trip(
    since_sequence: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Get the currently active trip, optionally filtered by sequence number.

    Args:
        since_sequence: If provided, only return trip if its sequence number is greater.

    Returns:
        Dict: The active trip data, serialized for JSON response, or None if no
              active trip found or no update since the given sequence.
    """
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized in get_active_trip")
        return None

    query = {"status": "active"}

    if since_sequence is not None:
        try:
            since_sequence = int(since_sequence)
            query["sequence"] = {"$gt": since_sequence}
        except (ValueError, TypeError):
            logger.warning(
                "Invalid since_sequence value '%s' received, ignoring.",
                since_sequence,
            )
            if "sequence" in query:
                del query["sequence"]

    active_trip_doc = await live_trips_collection.find_one(
        query,
        sort=[("sequence", -1)],
    )

    if active_trip_doc:
        logger.debug(
            "Found active trip matching query %s: %s with sequence %s",
            query,
            active_trip_doc.get("transactionId"),
            active_trip_doc.get("sequence"),
        )
        serialized_trip = await serialize_live_trip(active_trip_doc)
        return serialized_trip
    else:
        logger.debug("No active trip found matching query: %s", query)

        if since_sequence is not None:
            any_active_trip = await live_trips_collection.find_one(
                {"status": "active"}, sort=[("sequence", -1)]
            )
            if any_active_trip:
                logger.debug(
                    "An active trip exists (seq %s), but it's not newer than the requested sequence %s.",
                    any_active_trip.get("sequence"),
                    since_sequence,
                )
        return None


async def cleanup_stale_trips(
    stale_minutes: int = 15,
    max_archive_age_days: int = 30,
) -> Dict[str, int]:
    """Archives active trips that haven't been updated recently ('stale') and
    removes very old archived trips.

    Args:
        stale_minutes: Minutes of inactivity (based on lastUpdate) to mark a trip stale.
        max_archive_age_days: Maximum age in days to keep archived trips.

    Returns:
        Dict: Counts of stale trips archived and old archives removed.
    """
    if live_trips_collection is None or archived_live_trips_collection is None:
        logger.error(
            "Live or archived trip collections not initialized. Cannot run cleanup."
        )
        return {"stale_trips_archived": 0, "old_archives_removed": 0}

    now = datetime.now(timezone.utc)
    stale_threshold = now - timedelta(minutes=stale_minutes)
    archive_threshold = now - timedelta(days=max_archive_age_days)
    stale_archived_count = 0
    old_removed_count = 0

    logger.info(
        "Running cleanup task: Stale threshold=%s, Archive threshold=%s",
        stale_threshold,
        archive_threshold,
    )

    try:
        stale_trips_cursor = live_trips_collection.find(
            {"lastUpdate": {"$lt": stale_threshold}, "status": "active"}
        )
        async for trip in stale_trips_cursor:
            trip_id = trip.get("_id")
            transaction_id = trip.get("transactionId", "unknown")
            logger.warning(
                "Found potentially stale trip: %s (lastUpdate: %s)",
                transaction_id,
                trip.get("lastUpdate"),
            )

            trip_to_archive = trip.copy()
            if "_id" in trip_to_archive:
                del trip_to_archive["_id"]

            trip_to_archive["status"] = "completed"
            trip_to_archive["endTime"] = trip.get("lastUpdate")
            trip_to_archive["closed_reason"] = "stale"
            trip_to_archive["lastUpdate"] = trip.get("lastUpdate")

            start_time = trip.get("startTime")
            if isinstance(start_time, datetime) and isinstance(
                trip_to_archive["endTime"], datetime
            ):
                trip_to_archive["duration"] = (
                    trip_to_archive["endTime"] - start_time
                ).total_seconds()
            else:
                trip_to_archive.setdefault("duration", 0)

            trip_to_archive["sequence"] = max(
                trip.get("sequence", 0) + 1, int(time.time() * 1000)
            )

            async def archive_stale_op(session=None):
                await archived_live_trips_collection.insert_one(
                    trip_to_archive, session=session
                )

            async def delete_stale_op(session=None):
                await live_trips_collection.delete_one(
                    {"_id": trip_id}, session=session
                )

            success = await run_transaction([archive_stale_op, delete_stale_op])

            if success:
                stale_archived_count += 1
                logger.info("Archived stale trip: %s", transaction_id)
            else:
                logger.error(
                    "Failed to archive stale trip via transaction: %s",
                    transaction_id,
                )

    except Exception as e:
        logger.exception("Error during stale trip archiving: %s", str(e))

    try:
        delete_result = await archived_live_trips_collection.delete_many(
            {"endTime": {"$lt": archive_threshold}}
        )
        old_removed_count = delete_result.deleted_count
        if old_removed_count > 0:
            logger.info(
                "Deleted %d old archived trips (ended before %s)",
                old_removed_count,
                archive_threshold.strftime("%Y-%m-%d"),
            )
    except Exception as e:
        logger.exception("Error during old archive cleanup: %s", str(e))

    logger.info(
        "Cleanup finished: %d stale trips archived, %d old archives removed.",
        stale_archived_count,
        old_removed_count,
    )
    return {
        "stale_trips_archived": stale_archived_count,
        "old_archives_removed": old_removed_count,
    }


async def get_trip_updates(last_sequence: int = 0) -> Dict[str, Any]:
    """API endpoint logic to get updates about the currently active trip.

    Checks for an active trip with a sequence number greater than `last_sequence`.

    Args:
        last_sequence: The last sequence number the client has seen. Defaults to 0.

    Returns:
        Dict: Contains status, has_update flag, and trip data if an update is available.
    """
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized in get_trip_updates")
        return {
            "status": "error",
            "has_update": False,
            "message": "Database connection not ready.",
        }

    try:
        try:
            last_sequence = int(last_sequence) if last_sequence is not None else 0
        except (ValueError, TypeError):
            logger.warning(
                "Invalid last_sequence '%s' received in API request. Defaulting to 0.",
                last_sequence,
            )
            last_sequence = 0

        logger.debug("API request for trip updates since sequence: %d", last_sequence)

        active_trip_update = await get_active_trip(since_sequence=last_sequence)

        if active_trip_update:
            logger.info(
                "Providing trip update for %s (sequence %d > client %d)",
                active_trip_update.get("transactionId", "unknown"),
                active_trip_update.get("sequence", 0),
                last_sequence,
            )
            return {
                "status": "success",
                "has_update": True,
                "trip": active_trip_update,
            }
        else:
            any_active_trip_doc = await live_trips_collection.find_one(
                {"status": "active"}
            )
            if any_active_trip_doc:
                current_seq = any_active_trip_doc.get("sequence", "N/A")
                logger.info(
                    "No *new* updates since sequence %d. Current active trip sequence: %s.",
                    last_sequence,
                    current_seq,
                )
                return {
                    "status": "success",
                    "has_update": False,
                    "message": "No new updates available.",
                    "current_sequence": current_seq,
                }
            else:
                logger.info("No active trips found in the database.")
                return {
                    "status": "success",
                    "has_update": False,
                    "message": "No active trips currently.",
                }

    except Exception as e:
        logger.exception("Error in get_trip_updates API logic: %s", str(e))
        return {
            "status": "error",
            "has_update": False,
            "message": f"An internal error occurred: {str(e)}",
        }
