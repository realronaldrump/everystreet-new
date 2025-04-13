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
from typing import Any, Dict, List, Optional, Union

from db import run_transaction
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

    Handles strings ending in 'Z' or with timezone offsets.

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
        else:
            dt = dt.astimezone(timezone.utc)
        return dt
    except (ValueError, TypeError) as e:
        logger.error("Error parsing timestamp string '%s': %s", timestamp_str, e)
        return None


def _parse_mongo_date_dict(date_dict: Dict[str, str]) -> Optional[datetime]:
    """Parses a MongoDB extended JSON date dict like {'$date': 'ISO_STRING'}"""
    if isinstance(date_dict, dict) and "$date" in date_dict:
        return _parse_iso_datetime(date_dict["$date"])
    return None


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
    if not vin:
        logger.warning("Missing vin in tripStart event for %s.", transaction_id)

    start_timestamp_str = start_data.get("timestamp")
    start_time_zone = start_data.get("timeZone")
    start_odometer = start_data.get("odometer")

    if start_time_zone is None:
        logger.error(
            "API Error? Missing required 'timeZone' in tripStart payload for %s",
            transaction_id,
        )
        start_time_zone = "UTC"
    if start_odometer is None:
        logger.error(
            "API Error? Missing required 'odometer' in tripStart payload for %s",
            transaction_id,
        )
        start_odometer = None

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
        result = await live_trips_collection.delete_many(
            {"transactionId": transaction_id, "status": "active"},
            session=session,
        )
        if result.deleted_count > 0:
            logger.warning(
                "Deleted %d pre-existing active trip(s) with the same transactionId: %s before inserting new start.",
                result.deleted_count,
                transaction_id,
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
            "Failed to start trip: %s (database transaction failed - check run_transaction logs)",
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
        if archived_live_trips_collection is not None:
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
        new_coords: List[Dict[str, Any]] = sort_and_filter_trip_coordinates(
            trip_data_points
        )
    except Exception as e:
        logger.exception(
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

    existing_coords: List[Dict[str, Any]] = trip_doc.get("coordinates", []) or []

    all_coords_map: Dict[str, Dict[str, Any]] = {
        c["timestamp"].isoformat(): c
        for c in existing_coords
        if isinstance(c.get("timestamp"), datetime)
    }
    for c in new_coords:
        if isinstance(c.get("timestamp"), datetime):
            all_coords_map[c["timestamp"].isoformat()] = c
        else:
            logger.warning(
                "Skipping new coordinate due to invalid timestamp: %s for trip %s",
                c,
                transaction_id,
            )

    sorted_unique_coords = sorted(all_coords_map.values(), key=lambda c: c["timestamp"])

    if not sorted_unique_coords:
        logger.warning(
            "No coordinates available after deduplication for trip %s.",
            transaction_id,
        )
        return

    start_time = trip_doc.get("startTime")
    if not isinstance(start_time, datetime):
        start_time = (
            _parse_mongo_date_dict(start_time) if isinstance(start_time, dict) else None
        )
        if not isinstance(start_time, datetime):
            logger.error(
                "Invalid or missing startTime (%s) in existing trip document for %s. Cannot calculate duration/avgSpeed accurately. Using first coordinate time as fallback.",
                type(trip_doc.get("startTime")).__name__,
                transaction_id,
            )
            start_time = (
                sorted_unique_coords[0].get("timestamp")
                if sorted_unique_coords
                else None
            )

    last_point_time = sorted_unique_coords[-1].get("timestamp")
    duration_seconds = 0
    if isinstance(start_time, datetime) and isinstance(last_point_time, datetime):
        duration_seconds = (last_point_time - start_time).total_seconds()
        if duration_seconds < 0:
            logger.warning(
                "Calculated negative duration (%.1fs) for trip %s. Start: %s, Last Point: %s. Resetting duration to 0.",
                duration_seconds,
                transaction_id,
                start_time,
                last_point_time,
            )
            duration_seconds = 0
    else:
        logger.warning(
            "Cannot calculate duration for trip %s due to missing/invalid start or last point time.",
            transaction_id,
        )

    max_segment_speed = 0.0
    current_speed = 0.0
    full_trip_distance = 0.0
    valid_speeds_for_avg = []

    if len(sorted_unique_coords) >= 2:
        for i in range(1, len(sorted_unique_coords)):
            prev = sorted_unique_coords[i - 1]
            curr = sorted_unique_coords[i]

            if (
                not all(
                    k in prev and prev[k] is not None
                    for k in ("lon", "lat", "timestamp")
                )
                or not all(
                    k in curr and curr[k] is not None
                    for k in ("lon", "lat", "timestamp")
                )
                or not isinstance(prev.get("timestamp"), datetime)
                or not isinstance(curr.get("timestamp"), datetime)
                or not all(isinstance(prev[k], (int, float)) for k in ("lon", "lat"))
                or not all(isinstance(curr[k], (int, float)) for k in ("lon", "lat"))
            ):
                logger.warning(
                    "Skipping recalculation for segment %d-%d in trip %s due to data issue.",
                    i - 1,
                    i,
                    transaction_id,
                )
                continue

            try:
                segment_distance = haversine(
                    prev["lon"],
                    prev["lat"],
                    curr["lon"],
                    curr["lat"],
                    unit="miles",
                )
                if segment_distance > 0:
                    full_trip_distance += segment_distance

                time_diff_seconds = (
                    curr["timestamp"] - prev["timestamp"]
                ).total_seconds()

                if time_diff_seconds > 1:
                    segment_speed_mph = (segment_distance / time_diff_seconds) * 3600
                    if 0 <= segment_speed_mph < 200:
                        max_segment_speed = max(max_segment_speed, segment_speed_mph)
                        valid_speeds_for_avg.append(segment_speed_mph)
                        if i == len(sorted_unique_coords) - 1:
                            current_speed = segment_speed_mph
                    else:
                        logger.warning(
                            "Ignoring unrealistic segment speed %.1f mph during recalculation for trip %s",
                            segment_speed_mph,
                            transaction_id,
                        )
                elif time_diff_seconds < 0:
                    logger.warning(
                        "Negative time difference detected between points during recalculation for trip %s",
                        transaction_id,
                    )

            except (TypeError, ValueError) as calc_err:
                logger.error(
                    "Error during segment calculation for trip %s: %s. Prev: %s, Curr: %s",
                    transaction_id,
                    calc_err,
                    prev,
                    curr,
                )
                continue

    max_speed = max(trip_doc.get("maxSpeed", 0.0), max_segment_speed)

    avg_speed = 0.0
    if duration_seconds > 0:
        duration_hours = duration_seconds / 3600
        avg_speed = full_trip_distance / duration_hours
    elif valid_speeds_for_avg:
        avg_speed = sum(valid_speeds_for_avg) / len(valid_speeds_for_avg)
        logger.info(
            "Calculated fallback average speed %.1f mph for trip %s based on %d segments.",
            avg_speed,
            transaction_id,
            len(valid_speeds_for_avg),
        )

    sequence = max(trip_doc.get("sequence", 0) + 1, int(time.time() * 1000))

    update_result = await live_trips_collection.update_one(
        {"_id": trip_doc["_id"]},
        {
            "$set": {
                "coordinates": sorted_unique_coords,
                "lastUpdate": last_point_time or datetime.now(timezone.utc),
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
            "Failed to find trip %s (using _id %s) for update after processing data. It might have been deleted/archived concurrently.",
            transaction_id,
            trip_doc.get("_id"),
        )
    else:
        logger.info(
            "Trip data for %s processed, but no fields were modified in DB (data might be duplicate or calculation resulted in same values). Sequence updated to %d.",
            transaction_id,
            sequence,
        )
        await live_trips_collection.update_one(
            {"_id": trip_doc["_id"]},
            {
                "$set": {
                    "sequence": sequence,
                    "lastUpdate": last_point_time or datetime.now(timezone.utc),
                }
            },
        )


async def process_trip_metrics(data: Dict[str, Any]) -> None:
    """Process a tripMetrics event from the Bouncie webhook.

    Updates an active trip with summary metrics provided by Bouncie. Prefers
    Bouncie's summary metrics over self-calculated ones if available, except maxSpeed.

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
        if archived_live_trips_collection is not None:
            archived_trip = await archived_live_trips_collection.find_one(
                {"transactionId": transaction_id}
            )
            if archived_trip:
                logger.warning(
                    "Received tripMetrics for already completed/archived trip: %s. Ignoring.",
                    transaction_id,
                )
                return
        logger.warning(
            "Received tripMetrics for unknown or inactive trip: %s. Ignoring metrics.",
            transaction_id,
        )
        return

    logger.info("Processing tripMetrics event for transactionId: %s", transaction_id)

    update_fields = {}
    metrics_timestamp_str = metrics_data.get("timestamp")
    metrics_timestamp = _parse_iso_datetime(metrics_timestamp_str)
    update_fields["lastUpdate"] = metrics_timestamp or trip_doc.get("lastUpdate")

    if "tripTime" in metrics_data:
        try:
            update_fields["duration"] = float(metrics_data["tripTime"])
        except (ValueError, TypeError):
            logger.warning(
                "Invalid tripTime value in metrics for %s: %s",
                transaction_id,
                metrics_data["tripTime"],
            )
    if "tripDistance" in metrics_data:
        try:
            update_fields["distance"] = float(metrics_data["tripDistance"])
        except (ValueError, TypeError):
            logger.warning(
                "Invalid tripDistance value in metrics for %s: %s",
                transaction_id,
                metrics_data["tripDistance"],
            )
    if "totalIdlingTime" in metrics_data:
        try:
            update_fields["totalIdlingTime"] = int(metrics_data["totalIdlingTime"])
        except (ValueError, TypeError):
            logger.warning(
                "Invalid totalIdlingTime value in metrics for %s: %s",
                transaction_id,
                metrics_data["totalIdlingTime"],
            )
    if "maxSpeed" in metrics_data:
        try:
            update_fields["maxSpeed"] = max(
                trip_doc.get("maxSpeed", 0.0), float(metrics_data["maxSpeed"])
            )
        except (ValueError, TypeError):
            logger.warning(
                "Invalid maxSpeed value in metrics for %s: %s",
                transaction_id,
                metrics_data["maxSpeed"],
            )
    if "averageDriveSpeed" in metrics_data:
        try:
            update_fields["avgSpeed"] = float(metrics_data["averageDriveSpeed"])
        except (ValueError, TypeError):
            logger.warning(
                "Invalid averageDriveSpeed value in metrics for %s: %s",
                transaction_id,
                metrics_data["averageDriveSpeed"],
            )
    if "hardBrakingCounts" in metrics_data:
        try:
            update_fields["hardBrakingCounts"] = int(metrics_data["hardBrakingCounts"])
        except (ValueError, TypeError):
            logger.warning(
                "Invalid hardBrakingCounts value in metrics for %s: %s",
                transaction_id,
                metrics_data["hardBrakingCounts"],
            )
    if "hardAccelerationCounts" in metrics_data:
        try:
            update_fields["hardAccelerationCounts"] = int(
                metrics_data["hardAccelerationCounts"]
            )
        except (ValueError, TypeError):
            logger.warning(
                "Invalid hardAccelerationCounts value in metrics for %s: %s",
                transaction_id,
                metrics_data["hardAccelerationCounts"],
            )

    if not update_fields or len(update_fields) == 1 and "lastUpdate" in update_fields:
        logger.warning(
            "No valid metrics found to update in tripMetrics payload for %s.",
            transaction_id,
        )
        return

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
        logger.error(
            "Failed to find trip %s (using _id %s) for metrics update. Possible race condition.",
            transaction_id,
            trip_doc.get("_id"),
        )
    else:
        logger.info(
            "Trip metrics for %s processed, but no fields were modified in DB (metrics may match calculated values). Sequence updated to %d.",
            transaction_id,
            update_fields["sequence"],
        )
        await live_trips_collection.update_one(
            {"_id": trip_doc["_id"]},
            {
                "$set": {
                    "sequence": update_fields["sequence"],
                    "lastUpdate": update_fields["lastUpdate"],
                }
            },
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
    fuel_consumed_raw = end_data.get("fuelConsumed")

    if end_time_zone is None:
        logger.error(
            "API Error? Missing required 'timeZone' in tripEnd payload for %s",
            transaction_id,
        )
        end_time_zone = "UTC"
    if end_odometer is None:
        logger.error(
            "API Error? Missing required 'odometer' in tripEnd payload for %s",
            transaction_id,
        )
        end_odometer = None
    if fuel_consumed_raw is None:
        logger.error(
            "API Error? Missing required 'fuelConsumed' in tripEnd payload for %s",
            transaction_id,
        )
        fuel_consumed = None
    else:
        try:
            fuel_consumed = float(fuel_consumed_raw)
        except (ValueError, TypeError):
            logger.warning(
                "Invalid fuelConsumed value '%s' in tripEnd for %s. Storing as null.",
                fuel_consumed_raw,
                transaction_id,
            )
            fuel_consumed = None

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
    if not isinstance(start_time, datetime):
        start_time = (
            _parse_mongo_date_dict(start_time) if isinstance(start_time, dict) else None
        )

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
        if final_duration_seconds < 0:
            logger.warning(
                "Calculated negative final duration (%.1fs) for ended trip %s. Start: %s, End: %s. Storing 0.",
                final_duration_seconds,
                transaction_id,
                start_time,
                end_time,
            )
            trip_to_archive["duration"] = 0
        else:
            trip_to_archive["duration"] = final_duration_seconds
    else:
        logger.warning(
            "Could not calculate final duration for trip %s due to invalid start (%s) / end (%s) times. Using stored duration: %.1fs",
            transaction_id,
            type(start_time).__name__,
            type(end_time).__name__,
            trip.get("duration", 0),
        )
        trip_to_archive.setdefault("duration", trip.get("duration", 0))

    trip_to_archive.setdefault("distance", trip.get("distance", 0.0))
    trip_to_archive.setdefault("avgSpeed", trip.get("avgSpeed", 0.0))
    trip_to_archive.setdefault("maxSpeed", trip.get("maxSpeed", 0.0))
    trip_to_archive.setdefault("totalIdlingTime", trip.get("totalIdlingTime", 0))
    trip_to_archive.setdefault("hardBrakingCounts", trip.get("hardBrakingCounts", 0))
    trip_to_archive.setdefault(
        "hardAccelerationCounts", trip.get("hardAccelerationCounts", 0)
    )
    trip_to_archive.setdefault("coordinates", trip.get("coordinates", []))
    trip_to_archive.setdefault("pointsRecorded", trip.get("pointsRecorded", 0))
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
        logger.info(
            "Trip %s successfully ended and archived (seq=%d)",
            transaction_id,
            trip_to_archive["sequence"],
        )
    else:
        logger.error(
            "Transaction failed when ending and archiving trip %s - check run_transaction logs",
            transaction_id,
        )


async def get_active_trip(
    since_sequence: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Get the currently active trip document from DB.

    Args:
        since_sequence: If provided, only return trip if its sequence number is greater.

    Returns:
        Dict: The raw active trip document from MongoDB, or None.
    """
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized in get_active_trip")
        return None

    query: Dict[str, Any] = {"status": "active"}
    valid_since_sequence = None
    if since_sequence is not None:
        try:
            valid_since_sequence = int(since_sequence)
        except (ValueError, TypeError):
            logger.warning(...)
            valid_since_sequence = None

    if valid_since_sequence is not None:
        query["sequence"] = {"$gt": valid_since_sequence}
        logger.debug(...)
    else:
        logger.debug("Querying for any active trip (no sequence filter).")

    active_trip_doc = await live_trips_collection.find_one(
        query,
        sort=[("sequence", -1)],
    )

    if active_trip_doc:
        trip_seq = active_trip_doc.get("sequence", "N/A")
        if "_id" in active_trip_doc:
            active_trip_doc["_id"] = str(active_trip_doc["_id"])

        logger.debug(
            "Found active trip matching query %s: %s with sequence %s",
            query,
            active_trip_doc.get("transactionId"),
            trip_seq,
        )
        return active_trip_doc
    else:
        logger.debug("No active trip found matching query: %s", query)
        if valid_since_sequence is not None:
            pass
        return None


async def cleanup_stale_trips_logic(
    live_collection,
    archive_collection,
    stale_minutes: int = 15,
    max_archive_age_days: int = 30,
) -> Dict[str, int]:
    """Archives active trips that haven't been updated recently ('stale') and
    removes very old archived trips. Uses passed collection objects.

    Args:
        live_collection: The MongoDB collection for active live trips.
        archive_collection: The MongoDB collection for archived live trips.
        stale_minutes: Minutes of inactivity (based on lastUpdate) to mark a trip stale.
        max_archive_age_days: Maximum age in days to keep archived trips.

    Returns:
        Dict: Counts of stale trips archived and old archives removed.
    """

    now = datetime.now(timezone.utc)
    stale_threshold = now - timedelta(minutes=stale_minutes)
    archive_threshold = now - timedelta(days=max_archive_age_days)
    stale_archived_count = 0
    old_removed_count = 0

    logger.info(
        "Running cleanup task logic: Stale threshold (lastUpdate < %s), Archive threshold (endTime < %s)",
        stale_threshold.isoformat(),
        archive_threshold.isoformat(),
    )

    try:
        stale_trips_cursor = live_collection.find(
            {"status": "active", "lastUpdate": {"$lt": stale_threshold}}
        )

        async for trip in stale_trips_cursor:
            trip_id = trip.get("_id")
            transaction_id = trip.get("transactionId", "unknown_stale")
            last_update_time = trip.get("lastUpdate")

            if not trip_id:
                logger.error("Found stale trip candidate with missing _id: %s", trip)
                continue

            logger.warning(
                "Found potentially stale trip: %s (_id: %s, lastUpdate: %s)",
                transaction_id,
                trip_id,
                (
                    last_update_time.isoformat()
                    if isinstance(last_update_time, datetime)
                    else last_update_time
                ),
            )

            trip_to_archive = trip.copy()
            if "_id" in trip_to_archive:
                del trip_to_archive["_id"]

            trip_to_archive["status"] = "completed"
            trip_to_archive["endTime"] = last_update_time
            trip_to_archive["closed_reason"] = "stale"
            trip_to_archive["lastUpdate"] = last_update_time

            start_time = trip.get("startTime")
            if isinstance(start_time, datetime) and isinstance(
                last_update_time, datetime
            ):
                duration = (last_update_time - start_time).total_seconds()
                trip_to_archive["duration"] = max(0, duration)
            else:
                trip_to_archive.setdefault("duration", trip.get("duration", 0))

            trip_to_archive.setdefault("distance", trip.get("distance", 0.0))

            trip_to_archive["sequence"] = max(
                trip.get("sequence", 0) + 1, int(time.time() * 1000)
            )

            async def archive_stale_op(session=None):
                await archive_collection.insert_one(trip_to_archive, session=session)

            async def delete_stale_op(session=None):
                await live_collection.delete_one({"_id": trip_id}, session=session)

            success = await run_transaction([archive_stale_op, delete_stale_op])

            if success:
                stale_archived_count += 1
                logger.info(
                    "Archived stale trip: %s (seq=%d)",
                    transaction_id,
                    trip_to_archive["sequence"],
                )
            else:
                logger.error(
                    "Failed to archive stale trip via transaction: %s (_id: %s)",
                    transaction_id,
                    trip_id,
                )

    except Exception as e:
        logger.exception("Error during stale trip archiving phase: %s", str(e))

    try:
        delete_result = await archive_collection.delete_many(
            {"endTime": {"$lt": archive_threshold}}
        )
        old_removed_count = delete_result.deleted_count
        if old_removed_count > 0:
            logger.info(
                "Deleted %d old archived trips (ended before %s)",
                old_removed_count,
                archive_threshold.strftime("%Y-%m-%d %H:%M:%S %Z"),
            )
    except Exception as e:
        logger.exception("Error during old archive cleanup phase: %s", str(e))

    logger.info(
        "Cleanup logic finished: %d stale trips archived, %d old archives removed.",
        stale_archived_count,
        old_removed_count,
    )
    return {
        "stale_trips_archived": stale_archived_count,
        "old_archives_removed": old_removed_count,
    }


async def get_trip_updates(
    last_sequence: Union[int, str, None] = 0,
) -> Dict[str, Any]:
    """API endpoint logic to get updates about the currently active trip.

    Checks for an active trip with a sequence number greater than `last_sequence`.

    Args:
        last_sequence: The last sequence number the client has seen. Defaults to 0.
                       Can be int, string representation of int, or None.

    Returns:
        Dict: Contains status, has_update flag, and trip data if an update is available,
              or current_sequence if no update but an active trip exists.
    """
    if live_trips_collection is None:
        logger.error("Live trips collection not initialized in get_trip_updates")
        return {
            "status": "error",
            "has_update": False,
            "message": "Server error: Database connection not ready.",
        }

    client_sequence: int = 0
    if last_sequence is not None:
        try:
            parsed_sequence = int(last_sequence)
            if parsed_sequence >= 0:
                client_sequence = parsed_sequence
            else:
                logger.warning(
                    "Received negative last_sequence '%s' in API request. Defaulting to 0.",
                    last_sequence,
                )
        except (ValueError, TypeError):
            logger.warning(
                "Invalid last_sequence '%s' received in API request. Defaulting to 0.",
                last_sequence,
            )

    logger.debug("API request for trip updates since sequence: %d", client_sequence)

    try:
        active_trip_update = await get_active_trip(since_sequence=client_sequence)

        if active_trip_update:
            current_server_seq = active_trip_update.get("sequence", 0)
            logger.info(
                "Providing trip update for %s (sequence %d > client %d)",
                active_trip_update.get("transactionId", "unknown"),
                current_server_seq,
                client_sequence,
            )
            return {
                "status": "success",
                "has_update": True,
                "trip": active_trip_update,
            }
        else:
            any_active_trip_doc = await live_trips_collection.find_one(
                {"status": "active"},
                projection={"sequence": 1},
                sort=[("sequence", -1)],
            )

            if any_active_trip_doc:
                current_server_seq = any_active_trip_doc.get("sequence", "N/A")
                logger.info(
                    "No *new* updates since sequence %d. Current active trip sequence: %s.",
                    client_sequence,
                    current_server_seq,
                )
                return {
                    "status": "success",
                    "has_update": False,
                    "message": "No new updates available.",
                    "current_sequence": current_server_seq,
                }
            else:
                logger.info("No active trips found in the database.")
                return {
                    "status": "success",
                    "has_update": False,
                    "message": "No active trips currently.",
                    "current_sequence": 0,
                }

    except Exception as e:
        logger.exception("Error in get_trip_updates API logic: %s", str(e))
        return {
            "status": "error",
            "has_update": False,
            "message": "An internal server error occurred while checking for updates.",
        }
