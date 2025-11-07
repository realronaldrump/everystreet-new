import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pymongo
from bson import ObjectId
from pymongo.collection import Collection
from pymongo.results import UpdateResult

from date_utils import parse_timestamp
from db import run_transaction, serialize_document, update_one_with_retry
from trip_event_publisher import (
    publish_trip_delta,
    publish_trip_end,
    publish_trip_start,
)
from utils import haversine

logger = logging.getLogger(__name__)

live_trips_collection_global: Collection | None = None


def initialize_db(db_live_trips, _db_archived_live_trips=None):
    """Initialize the database collections used by this module (primarily
    for non-task access).
    """
    global live_trips_collection_global
    live_trips_collection_global = db_live_trips
    logger.debug("Live tracking global DB collections initialized/updated")


def _parse_iso_datetime(
    timestamp_str: str | None,
) -> datetime | None:
    """Wrapper to parse timestamps using centralized date_utils.parse_timestamp."""
    if not timestamp_str:
        return None
    return parse_timestamp(timestamp_str)


def _parse_mongo_date_dict(
    date_dict: dict[str, str],
) -> datetime | None:
    """Parses a MongoDB extended JSON date dict like {'$date': 'ISO_STRING'}"""
    if isinstance(date_dict, dict) and "$date" in date_dict:
        return _parse_iso_datetime(date_dict["$date"])
    return None


async def process_trip_start(
    data: dict[str, Any],
    live_collection: Collection,
) -> None:
    """Process a tripStart event from the Bouncie webhook.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
        live_collection: The MongoDB collection for active trips.

    """
    transaction_id = data.get("transactionId")
    start_data = data.get("start")
    vin = data.get("vin")
    imei = data.get("imei")

    if not transaction_id:
        logger.error(
            "Missing transactionId in tripStart event. Payload: %s",
            data,
        )
        return
    if not start_data or not isinstance(start_data, dict):
        logger.error(
            "Missing or invalid 'start' object in tripStart event for %s. Payload: %s",
            transaction_id,
            data,
        )
        return

    start_timestamp_str = start_data.get("timestamp")
    start_time_zone = start_data.get("timeZone")
    if start_time_zone is None:
        start_time_zone = start_data.get("timezone")
    start_odometer = start_data.get("odometer")

    if start_time_zone is None:
        logger.error(
            "Missing 'timeZone' in tripStart payload for %s. Defaulting to UTC.",
            transaction_id,
        )
        start_time_zone = "UTC"

    start_time = _parse_iso_datetime(start_timestamp_str)
    if not start_time:
        logger.error(
            "Failed to extract valid start time from tripStart event for %s. Using current time as fallback.",
            transaction_id,
        )
        start_time = datetime.now(timezone.utc)

    logger.info(
        "Processing tripStart event for transactionId: %s",
        transaction_id,
    )

    sequence = int(time.time_ns() / 1000)

    # Note: tripStart doesn't include GPS coordinates according to API spec
    # Initialize with empty coordinates, will be populated by tripData events
    new_trip = {
        "transactionId": transaction_id,
        "vin": vin,
        "imei": imei,
        "status": "active",
        "startTime": start_time,
        "startTimeZone": start_time_zone,
        "startOdometer": start_odometer,
        "coordinates": [],  # Single source of truth for location data
        "lastUpdate": start_time,
        "distance": 0.0,
        "currentSpeed": 0.0,
        "maxSpeed": 0.0,
        "avgSpeed": 0.0,
        "duration": 0.0,
        "pointsRecorded": 0,
        "sequence": sequence,
        "speedSum": 0.0,  # For incremental average speed calculation
        "speedCount": 0,  # For incremental average speed calculation
        "totalIdlingTime": 0.0,
        "hardBrakingCounts": 0,
        "hardAccelerationCounts": 0,
        "fuelConsumed": None,
        "endTime": None,
        "endTimeZone": None,
        "endOdometer": None,
        "closed_reason": None,
    }

    async def delete_existing_op(session=None):
        result = await live_collection.delete_many(
            {
                "transactionId": transaction_id,
                "status": "active",
            },
            session=session,
        )
        if result.deleted_count > 0:
            logger.warning(
                "Deleted %d pre-existing active trip(s) with the same transactionId: %s before inserting new start.",
                result.deleted_count,
                transaction_id,
            )

    async def insert_new_op(session=None):
        await live_collection.insert_one(new_trip, session=session)

    success = await run_transaction([delete_existing_op, insert_new_op])

    if success:
        logger.info(
            "Trip started and created in DB: %s (seq=%s)",
            transaction_id,
            sequence,
        )
        # Publish trip start event
        try:
            # Serialize the trip data for publishing
            trip_for_publish = serialize_document(new_trip)
            await publish_trip_start(transaction_id, trip_for_publish, sequence)
        except Exception as pub_err:
            logger.warning(
                "Failed to publish trip start event for %s: %s",
                transaction_id,
                pub_err,
            )
    else:
        logger.error(
            "Failed to start trip %s due to database transaction failure.",
            transaction_id,
        )


async def process_trip_data(
    data: dict[str, Any],
    live_collection: Collection,
    archive_collection: Collection,
) -> None:
    """Process a tripData event from the Bouncie webhook.

    Updates coordinates and recalculates live metrics incrementally for an active trip.
    Uses MongoDB atomic operators to avoid reading and rewriting entire arrays.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
        live_collection: The MongoDB collection for active trips.
        archive_collection: The MongoDB collection for archived trips.

    """
    transaction_id = data.get("transactionId")
    trip_data_points = data.get("data")

    if not transaction_id:
        logger.error(
            "Missing transactionId in tripData event. Payload: %s",
            data,
        )
        return
    if not trip_data_points or not isinstance(trip_data_points, list):
        logger.warning(
            "Missing or invalid 'data' array in tripData event for %s. Payload: %s",
            transaction_id,
            data,
        )
        return

    try:
        trip_doc = await live_collection.find_one(
            {
                "transactionId": transaction_id,
                "status": "active",
            },
            projection={
                "_id": 1,
                "coordinates": 1,
                "startTime": 1,
                "distance": 1,
                "maxSpeed": 1,
                "avgSpeed": 1,
                "speedSum": 1,
                "speedCount": 1,
                "sequence": 1,
            },
        )
    except Exception as find_err:
        logger.error(
            "Database error finding active trip %s for tripData: %s",
            transaction_id,
            find_err,
        )
        return

    if not trip_doc:
        try:
            archived_trip = await archive_collection.find_one(
                {"transactionId": transaction_id},
            )
            if archived_trip:
                logger.info(
                    "Received tripData for already completed/archived trip: %s. Ignoring.",
                    transaction_id,
                )
            else:
                logger.warning(
                    "Received tripData for unknown or inactive trip: %s. Ignoring data.",
                    transaction_id,
                )
        except Exception as find_archive_err:
            logger.error(
                "Database error checking archive for trip %s during tripData: %s",
                transaction_id,
                find_archive_err,
            )
        return

    logger.info(
        "Processing tripData event for transactionId: %s with %d points",
        transaction_id,
        len(trip_data_points),
    )

    # Process and normalize the incoming data points
    new_coords = []
    for point in trip_data_points:
        timestamp = None
        lat = None
        lon = None
        speed = None

        # Parse timestamp
        if "timestamp" in point:
            timestamp = _parse_iso_datetime(point["timestamp"])

        # Parse GPS data - handle nested structure
        if "gps" in point and isinstance(point["gps"], dict):
            lat = point["gps"].get("lat")
            lon = point["gps"].get("lon")

        # Parse speed if available
        if "speed" in point:
            speed = point.get("speed")

        # Validate we have minimum required data
        if timestamp and lat is not None and lon is not None:
            coord_data = {"timestamp": timestamp, "lat": lat, "lon": lon}
            if speed is not None:
                coord_data["speed"] = speed
            new_coords.append(coord_data)
        else:
            logger.debug(
                "Skipping invalid data point in tripData for %s: %s",
                transaction_id,
                point,
            )

    if not new_coords:
        logger.info(
            "No valid coordinates found in tripData for %s.",
            transaction_id,
        )
        sequence = max(
            trip_doc.get("sequence", 0) + 1,
            int(time.time_ns() / 1000),
        )
        await update_one_with_retry(
            live_collection,
            {"_id": trip_doc["_id"]},
            {
                "$set": {
                    "sequence": sequence,
                    "lastUpdate": datetime.now(timezone.utc),
                },
            },
        )
        return

    # Sort new coordinates by timestamp
    new_coords.sort(key=lambda x: x["timestamp"])

    # Get the last known coordinate to calculate incremental metrics
    existing_coords = trip_doc.get("coordinates", [])
    last_coord = None
    if existing_coords:
        # Find the last coordinate by timestamp
        # Handle cases where coordinates might not be sorted or have invalid timestamps
        valid_coords_with_ts = [
            c
            for c in existing_coords
            if isinstance(c, dict) and isinstance(c.get("timestamp"), datetime)
        ]
        if valid_coords_with_ts:
            last_coord = max(valid_coords_with_ts, key=lambda c: c["timestamp"])
        elif existing_coords:
            # Fallback: use the last coordinate in the array if no valid timestamps
            last_coord = (
                existing_coords[-1] if isinstance(existing_coords[-1], dict) else None
            )

    # Calculate incremental metrics only for new segments
    incremental_distance = 0.0
    incremental_max_speed = 0.0
    current_speed = 0.0
    speed_values = []  # For calculating average speed incrementally
    start_point = last_coord if last_coord else None

    # Build list of points to process (last point + new points)
    points_to_process = []
    if start_point:
        points_to_process.append(start_point)
    points_to_process.extend(new_coords)

    # Calculate metrics for new segments only
    if len(points_to_process) >= 2:
        for i in range(1, len(points_to_process)):
            prev = points_to_process[i - 1]
            curr = points_to_process[i]

            if all(k in prev for k in ["lon", "lat"]) and all(
                k in curr for k in ["lon", "lat"]
            ):
                segment_distance = haversine(
                    prev["lon"],
                    prev["lat"],
                    curr["lon"],
                    curr["lat"],
                    unit="miles",
                )
                incremental_distance += segment_distance

                # Calculate speed if we have timestamps
                if "timestamp" in prev and "timestamp" in curr:
                    time_diff = (curr["timestamp"] - prev["timestamp"]).total_seconds()
                    if time_diff > 0.5:
                        segment_speed = (segment_distance / time_diff) * 3600
                        if 0 <= segment_speed < 200:  # Reasonable speed range
                            speed_values.append(segment_speed)
                            incremental_max_speed = max(
                                incremental_max_speed, segment_speed
                            )
                            if i == len(points_to_process) - 1:
                                current_speed = segment_speed

    # Use speed from data if available and no calculated speed
    if current_speed == 0 and new_coords and "speed" in new_coords[-1]:
        current_speed = new_coords[-1]["speed"]

    # Get current values for incremental updates
    existing_distance = trip_doc.get("distance", 0.0)
    existing_max_speed = trip_doc.get("maxSpeed", 0.0)
    existing_speed_sum = trip_doc.get("speedSum", 0.0)
    existing_speed_count = trip_doc.get("speedCount", 0)

    # Update speed sum and count for average speed calculation
    new_speed_sum = existing_speed_sum + sum(speed_values)
    new_speed_count = existing_speed_count + len(speed_values)

    # Calculate new average speed
    new_avg_speed = 0.0
    if new_speed_count > 0:
        new_avg_speed = new_speed_sum / new_speed_count
    else:
        # Fallback: calculate from distance/duration
        start_time = trip_doc.get("startTime")
        if not isinstance(start_time, datetime):
            start_time = (
                _parse_mongo_date_dict(start_time)
                if isinstance(start_time, dict)
                else None
            )
        last_point_time = (
            new_coords[-1]["timestamp"] if new_coords else datetime.now(timezone.utc)
        )
        if start_time and isinstance(last_point_time, datetime):
            duration_seconds = max(0.0, (last_point_time - start_time).total_seconds())
            if duration_seconds > 0:
                total_distance = existing_distance + incremental_distance
                new_avg_speed = total_distance / (duration_seconds / 3600)

    # Determine new max speed
    new_max_speed = max(existing_max_speed, incremental_max_speed)

    # Get last point timestamp for duration calculation
    last_point_time = (
        new_coords[-1]["timestamp"] if new_coords else datetime.now(timezone.utc)
    )
    start_time = trip_doc.get("startTime")
    if not isinstance(start_time, datetime):
        start_time = (
            _parse_mongo_date_dict(start_time) if isinstance(start_time, dict) else None
        )
    duration_seconds = 0.0
    if start_time and isinstance(last_point_time, datetime):
        duration_seconds = max(0.0, (last_point_time - start_time).total_seconds())

    sequence = max(
        trip_doc.get("sequence", 0) + 1,
        int(time.time_ns() / 1000),
    )

    # Remove duplicates from new_coords based on timestamp before pushing
    # Use a set to track seen timestamps (as ISO strings for hashing)
    seen_timestamps = set()
    if existing_coords:
        for coord in existing_coords:
            if isinstance(coord, dict) and "timestamp" in coord:
                ts = coord["timestamp"]
                ts_key = ts.isoformat() if isinstance(ts, datetime) else str(ts)
                seen_timestamps.add(ts_key)

    unique_new_coords = []
    for coord in new_coords:
        ts_key = coord["timestamp"].isoformat()
        if ts_key not in seen_timestamps:
            unique_new_coords.append(coord)
            seen_timestamps.add(ts_key)

    if not unique_new_coords:
        logger.debug(
            "All new coordinates were duplicates for %s. Updating sequence only.",
            transaction_id,
        )
        await update_one_with_retry(
            live_collection,
            {"_id": trip_doc["_id"]},
            {
                "$set": {
                    "sequence": sequence,
                    "lastUpdate": last_point_time,
                },
            },
        )
        return

    # Use MongoDB atomic operators for incremental updates
    update_ops = {
        "$push": {
            "coordinates": {
                "$each": unique_new_coords,
                "$sort": {"timestamp": 1},
            },
        },
        "$inc": {
            "distance": incremental_distance,
            "pointsRecorded": len(unique_new_coords),
            "speedSum": sum(speed_values),
            "speedCount": len(speed_values),
        },
        "$set": {
            "lastUpdate": last_point_time,
            "currentSpeed": current_speed,
            "avgSpeed": new_avg_speed,
            "duration": duration_seconds,
            "sequence": sequence,
        },
        "$max": {
            "maxSpeed": incremental_max_speed,
        },
    }

    try:
        # Single atomic update using MongoDB operators
        update_result = await update_one_with_retry(
            live_collection,
            {"_id": trip_doc["_id"], "status": "active"},
            update_ops,
        )

        if update_result.matched_count == 0:
            logger.warning(
                "Failed to find active trip %s for update. May have been archived.",
                transaction_id,
            )
            return

        logger.info(
            "Updated trip data for %s: %d new points processed (seq=%d)",
            transaction_id,
            len(unique_new_coords),
            sequence,
        )

        # Publish delta update with only new data
        try:
            # Serialize coordinates for publishing
            serialized_new_coords = [
                serialize_document(coord) for coord in unique_new_coords
            ]

            delta = {
                "new_coordinates": serialized_new_coords,
                "updated_metrics": {
                    "distance": existing_distance
                    + incremental_distance,  # Absolute distance
                    "currentSpeed": current_speed,
                    "maxSpeed": new_max_speed,
                    "avgSpeed": new_avg_speed,
                    "duration": duration_seconds,
                    "pointsRecorded": trip_doc.get("pointsRecorded", 0)
                    + len(unique_new_coords),
                },
                "lastUpdate": (
                    last_point_time.isoformat()
                    if isinstance(last_point_time, datetime)
                    else last_point_time
                ),
            }

            await publish_trip_delta(transaction_id, delta, sequence)
        except Exception as pub_err:
            logger.warning(
                "Failed to publish trip delta for %s: %s",
                transaction_id,
                pub_err,
            )
    except Exception as update_err:
        logger.error(
            "Database error updating trip %s: %s",
            transaction_id,
            update_err,
        )


async def process_trip_metrics(
    data: dict[str, Any],
    live_collection: Collection,
    archive_collection: Collection,
) -> None:
    """Process a tripMetrics event from the Bouncie webhook.

    Updates an active trip with summary metrics provided by Bouncie. Prefers
    Bouncie's summary metrics over self-calculated ones if available, except maxSpeed.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
        live_collection: The MongoDB collection for active trips.
        archive_collection: The MongoDB collection for archived trips.

    """
    transaction_id = data.get("transactionId")
    metrics_data = data.get("metrics")

    if not transaction_id:
        logger.error(
            "Missing transactionId in tripMetrics event. Payload: %s",
            data,
        )
        return
    if not metrics_data or not isinstance(metrics_data, dict):
        logger.warning(
            "Missing or invalid 'metrics' object in tripMetrics event for %s. Payload: %s",
            transaction_id,
            data,
        )
        return

    # Top-level try-except for the entire processing logic for this event
    try:
        # Initial fetch to check existence. Updates will be atomic using find_one_and_update.
        initial_trip_doc = await live_collection.find_one(
            {
                "transactionId": transaction_id,
                "status": "active",
            },
        )

        if not initial_trip_doc:
            try:
                archived_trip = await archive_collection.find_one(
                    {"transactionId": transaction_id},
                )
                if archived_trip:
                    logger.info(
                        "Received tripMetrics for already completed/archived trip: %s. Ignoring.",
                        transaction_id,
                    )
                else:
                    logger.warning(
                        "Received tripMetrics for unknown or inactive trip: %s. Ignoring metrics.",
                        transaction_id,
                    )
            except Exception as find_archive_err:
                logger.error(
                    "Database error checking archive for trip %s during tripMetrics: %s",
                    transaction_id,
                    find_archive_err,
                )
            return

        logger.info(
            "Processing tripMetrics event for transactionId: %s",
            transaction_id,
        )

        update_fields = {}
        metrics_timestamp_str = metrics_data.get("timestamp")
        metrics_timestamp = _parse_iso_datetime(metrics_timestamp_str)

        # Use initial_trip_doc's lastUpdate as a fallback if metrics_timestamp is invalid
        last_update_fallback = initial_trip_doc.get(
            "lastUpdate", datetime.now(timezone.utc)
        )
        update_fields["lastUpdate"] = metrics_timestamp or last_update_fallback

        # Helper to safely update fields from metrics_data
        def _safe_update_float(key: str, metric_key: str):
            if metric_key in metrics_data and metrics_data[metric_key] is not None:
                try:
                    update_fields[key] = float(metrics_data[metric_key])
                except (ValueError, TypeError):
                    logger.warning(
                        "Invalid %s value in metrics for %s: %s",
                        metric_key,
                        transaction_id,
                        metrics_data[metric_key],
                    )

        def _safe_update_int(key: str, metric_key: str):
            if metric_key in metrics_data and metrics_data[metric_key] is not None:
                try:
                    update_fields[key] = int(metrics_data[metric_key])
                except (ValueError, TypeError):
                    logger.warning(
                        "Invalid %s value in metrics for %s: %s",
                        metric_key,
                        transaction_id,
                        metrics_data[metric_key],
                    )

        _safe_update_float("currentSpeed", "speed")
        _safe_update_float("avgSpeed", "averageSpeed")
        _safe_update_float("totalIdlingTime", "idlingTime")
        _safe_update_int("hardBrakingCounts", "hardBraking")
        _safe_update_int("hardAccelerationCounts", "hardAcceleration")

        # If Bouncie sends overall distance or fuel, update them.
        # These might be more accurate than our segment calculations in some cases.
        _safe_update_float("distance", "distance")
        _safe_update_float("fuelConsumed", "fuelConsumed")

        # Handle maxSpeed separately using $max for atomic updates
        max_speed_from_bouncie = None
        if "maxSpeed" in metrics_data and metrics_data["maxSpeed"] is not None:
            try:
                max_speed_from_bouncie = float(metrics_data["maxSpeed"])
            except (ValueError, TypeError):
                logger.warning(
                    "Invalid maxSpeed value in metrics for %s: %s",
                    transaction_id,
                    metrics_data["maxSpeed"],
                )

        # Always update sequence number
        sequence = max(
            initial_trip_doc.get("sequence", 0) + 1,
            int(time.time_ns() / 1000),
        )
        update_fields["sequence"] = sequence

        if not update_fields and max_speed_from_bouncie is None:
            logger.info("No fields to update from tripMetrics for %s.", transaction_id)
            return

        trip_id_to_update = initial_trip_doc["_id"]

        # Build update operation with $set and optional $max
        update_operation = {"$set": update_fields}
        if max_speed_from_bouncie is not None:
            update_operation["$max"] = {"maxSpeed": max_speed_from_bouncie}

        updated_trip_doc = await live_collection.find_one_and_update(
            {
                "_id": trip_id_to_update,
                "status": "active",
            },  # Ensure still active
            update_operation,
            return_document=pymongo.ReturnDocument.AFTER,
        )

        if updated_trip_doc:
            logger.info(
                "Updated trip metrics for: %s (seq=%d)",
                transaction_id,
                updated_trip_doc.get("sequence"),
            )
            # Publish delta update with metrics changes
            try:
                delta_metrics = {
                    k: v
                    for k, v in update_fields.items()
                    if k not in ("sequence", "lastUpdate")
                }
                # Include maxSpeed if it was updated from Bouncie
                if max_speed_from_bouncie is not None:
                    delta_metrics["maxSpeed"] = updated_trip_doc.get("maxSpeed")

                delta = {
                    "updated_metrics": delta_metrics,
                    "lastUpdate": update_fields.get("lastUpdate"),
                }
                # Convert datetime to ISO string if needed
                if isinstance(delta["lastUpdate"], datetime):
                    delta["lastUpdate"] = delta["lastUpdate"].isoformat()

                await publish_trip_delta(transaction_id, delta, sequence)
            except Exception as pub_err:
                logger.warning(
                    "Failed to publish trip metrics delta for %s: %s",
                    transaction_id,
                    pub_err,
                )
        else:
            logger.warning(
                "Failed to find active trip %s (_id: %s) for metrics find_one_and_update. It might have been archived/deleted or status changed concurrently.",
                transaction_id,
                trip_id_to_update,
            )
            archived_check = await archive_collection.find_one(
                {"transactionId": transaction_id}
            )
            if archived_check:
                logger.info(
                    "Trip %s was found in archive after failed live metrics update.",
                    transaction_id,
                )
            else:
                logger.warning(
                    "Trip %s not found in live or archive after failed metrics update.",
                    transaction_id,
                )

    except Exception as e:
        logger.exception(
            "Unhandled error in process_trip_metrics for transactionId %s: %s",
            transaction_id,
            e,
        )


async def process_trip_end(
    data: dict[str, Any],
    live_collection: Collection,
    archive_collection: Collection,
) -> None:
    """Process a tripEnd event from the Bouncie webhook with transaction safety.

    Upserts the trip details into the archive collection based on transactionId
    and removes the corresponding trip from the live collection.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
        live_collection: The MongoDB collection for active trips.
        archive_collection: The MongoDB collection for archived trips.

    """
    transaction_id = data.get("transactionId")
    end_data = data.get("end")

    if not transaction_id:
        logger.error(
            "Missing transactionId in tripEnd event. Payload: %s",
            data,
        )
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
    if end_time_zone is None:  # Try the lowercase version if camelCase is not found
        end_time_zone = end_data.get("timezone")
    end_odometer = end_data.get("odometer")
    fuel_consumed_raw = end_data.get("fuelConsumed")

    if end_time_zone is None:
        logger.error(
            "Missing 'timeZone' in tripEnd payload for %s. Defaulting to UTC. Payload: %s",
            transaction_id,
            str(end_data)[:250],  # Log a portion of the data
        )
        end_time_zone = "UTC"

    if end_odometer is None:
        logger.error(
            "Missing 'odometer' in tripEnd payload for %s. Storing as null. Payload: %s",
            transaction_id,
            str(end_data)[:250],  # Log a portion of the data
        )
        # We keep end_odometer as None as per original logic if it's missing

    fuel_consumed = None
    if fuel_consumed_raw is not None:
        try:
            fuel_consumed = float(fuel_consumed_raw)
        except (ValueError, TypeError):
            logger.warning(
                "Invalid fuelConsumed value '%s' in tripEnd for %s. Storing as null.",
                fuel_consumed_raw,
                transaction_id,
            )
    else:
        logger.error(
            "Missing 'fuelConsumed' in tripEnd payload for %s. Storing as null. Payload: %s",
            transaction_id,
            str(end_data)[:250],  # Log a portion of the data
        )

    end_time = _parse_iso_datetime(end_timestamp_str)

    if not end_time:
        logger.error(
            "Failed to extract valid end time from tripEnd event for %s. Timestamp string: '%s'. Using current time as fallback.",
            transaction_id,
            end_timestamp_str,
        )
        end_time = datetime.now(timezone.utc)

    trip: dict[str, Any] | None = None
    try:
        trip = await live_collection.find_one(
            {
                "transactionId": transaction_id,
                "status": "active",
            },
        )
    except Exception as find_err:
        logger.error(
            "Database error finding active trip %s for tripEnd: %s",
            transaction_id,
            find_err,
        )
        return

    if not trip:
        try:
            already_archived = await archive_collection.find_one(
                {"transactionId": transaction_id},
                projection={"_id": 1},
            )
            if already_archived:
                logger.info(
                    "Received tripEnd event for already archived trip: %s. Attempting upsert to archive.",
                    transaction_id,
                )
            else:
                logger.warning(
                    "Received tripEnd event for unknown trip (not live or archived): %s. Cannot process.",
                    transaction_id,
                )
                return
        except Exception as find_archive_err:
            logger.error(
                "Database error checking archive for trip %s during tripEnd: %s",
                transaction_id,
                find_archive_err,
            )
            return

    logger.info(
        "Processing tripEnd event for transactionId: %s",
        transaction_id,
    )
    base_trip_data = trip if trip else {"transactionId": transaction_id}
    live_trip_id = base_trip_data.get("_id") if trip else None

    start_time = base_trip_data.get("startTime")
    if not isinstance(start_time, datetime):
        start_time = (
            _parse_mongo_date_dict(start_time)
            if isinstance(start_time, dict)
            else (
                _parse_iso_datetime(start_time) if isinstance(start_time, str) else None
            )
        )

    trip_to_archive = base_trip_data.copy()
    if "_id" in trip_to_archive:
        del trip_to_archive["_id"]

    trip_to_archive["endTime"] = end_time
    trip_to_archive["endTimeZone"] = end_time_zone
    trip_to_archive["endOdometer"] = end_odometer
    trip_to_archive["fuelConsumed"] = fuel_consumed
    trip_to_archive["status"] = "completed"
    trip_to_archive.setdefault("closed_reason", "normal")
    trip_to_archive["lastUpdate"] = end_time

    if isinstance(start_time, datetime) and isinstance(end_time, datetime):
        final_duration_seconds = (end_time - start_time).total_seconds()
        if final_duration_seconds < 0:
            logger.warning(
                "Calculated negative final duration (%.1fs) for ended trip %s. Start: %s, End: %s. Storing 0.",
                final_duration_seconds,
                transaction_id,
                (start_time.isoformat() if start_time else "N/A"),
                (end_time.isoformat() if end_time else "N/A"),
            )
            trip_to_archive["duration"] = 0.0
        else:
            trip_to_archive["duration"] = final_duration_seconds
    else:
        stored_duration = base_trip_data.get("duration", 0.0)
        if start_time or end_time:
            logger.warning(
                "Could not calculate final duration for trip %s due to invalid start (%s) / end (%s) times. Using stored duration: %.1fs",
                transaction_id,
                type(start_time).__name__,
                type(end_time).__name__,
                stored_duration,
            )
        trip_to_archive.setdefault("duration", stored_duration)

    trip_to_archive.setdefault(
        "distance",
        base_trip_data.get("distance", 0.0),
    )
    trip_to_archive.setdefault(
        "avgSpeed",
        base_trip_data.get("avgSpeed", 0.0),
    )
    trip_to_archive.setdefault(
        "maxSpeed",
        base_trip_data.get("maxSpeed", 0.0),
    )
    trip_to_archive.setdefault(
        "totalIdlingTime",
        base_trip_data.get("totalIdlingTime", 0.0),
    )
    trip_to_archive.setdefault(
        "hardBrakingCounts",
        base_trip_data.get("hardBrakingCounts", 0),
    )
    trip_to_archive.setdefault(
        "hardAccelerationCounts",
        base_trip_data.get("hardAccelerationCounts", 0),
    )
    trip_to_archive.setdefault(
        "pointsRecorded",
        base_trip_data.get("pointsRecorded", 0),
    )
    if "vin" in base_trip_data:
        trip_to_archive.setdefault("vin", base_trip_data.get("vin"))
    if "imei" in base_trip_data:
        trip_to_archive.setdefault("imei", base_trip_data.get("imei"))
    trip_to_archive["sequence"] = max(
        base_trip_data.get("sequence", 0) + 1,
        int(time.time_ns() / 1000),
    )

    # --- Build GeoJSON LineString from coordinates array before archiving ---
    coordinates = trip_to_archive.get("coordinates", [])
    geojson_coords = []

    # Extract [lon, lat] pairs from coordinates array
    for coord in coordinates:
        if isinstance(coord, dict) and "lon" in coord and "lat" in coord:
            lon = coord.get("lon")
            lat = coord.get("lat")
            if lon is not None and lat is not None:
                geojson_coords.append([lon, lat])

    # Build GeoJSON geometry based on number of points
    if len(geojson_coords) == 0:
        trip_to_archive["gps"] = None
        logger.warning(
            "Trip %s: No valid coordinates found for archiving. Setting gps to null.",
            transaction_id,
        )
    elif len(geojson_coords) == 1:
        trip_to_archive["gps"] = {
            "type": "Point",
            "coordinates": geojson_coords[0],
        }
        logger.info(
            "Trip %s: Only one coordinate point found. Creating Point geometry for archive.",
            transaction_id,
        )
    else:
        # Remove consecutive duplicates to optimize LineString
        distinct_points = [geojson_coords[0]]
        for i in range(1, len(geojson_coords)):
            if geojson_coords[i] != geojson_coords[i - 1]:
                distinct_points.append(geojson_coords[i])

        if len(distinct_points) == 1:
            trip_to_archive["gps"] = {
                "type": "Point",
                "coordinates": distinct_points[0],
            }
            logger.info(
                "Trip %s: After deduplication, only one distinct point. Creating Point geometry for archive.",
                transaction_id,
            )
        else:
            trip_to_archive["gps"] = {
                "type": "LineString",
                "coordinates": distinct_points,
            }

    # Remove coordinates field from archived trip (gps field is now the single source of truth)
    if "coordinates" in trip_to_archive:
        del trip_to_archive["coordinates"]
    # --- End GeoJSON building ---

    final_duration = trip_to_archive.get("duration", 0.0)
    final_distance = trip_to_archive.get("distance", 0.0)
    final_avg_speed = trip_to_archive.get("avgSpeed", 0.0)
    final_max_speed = trip_to_archive.get("maxSpeed", 0.0)
    logger.info(
        "Ending trip %s: duration=%.1fs, distance=%.2fmi, avg_speed=%.1fmph, max_speed=%.1fmph, fuel=%.3fgal",
        transaction_id,
        final_duration,
        final_distance,
        final_avg_speed,
        final_max_speed,
        (fuel_consumed if fuel_consumed is not None else 0.0),
    )

    operations = []

    async def archive_upsert_operation(
        session=None,
    ):
        update_result: UpdateResult = await archive_collection.update_one(
            {"transactionId": transaction_id},
            {"$set": trip_to_archive},
            upsert=True,
            session=session,
        )
        if update_result.upserted_id:
            logger.info(
                "Archived new trip record for %s.",
                transaction_id,
            )
        elif update_result.modified_count > 0:
            logger.info(
                "Updated existing archive record for %s.",
                transaction_id,
            )

    operations.append(archive_upsert_operation)

    if live_trip_id:

        async def delete_live_operation(
            session=None,
        ):
            delete_result = await live_collection.delete_one(
                {"_id": live_trip_id},
                session=session,
            )
            if delete_result.deleted_count == 0:
                logger.warning(
                    "Attempted to delete live trip %s (_id: %s) but it was not found (possibly deleted concurrently).",
                    transaction_id,
                    live_trip_id,
                )

        operations.append(delete_live_operation)
    else:
        logger.info(
            "No corresponding live trip found for %s, only performing archive upsert.",
            transaction_id,
        )

    success = await run_transaction(operations)

    if success:
        action = "ended and archived" if live_trip_id else "archived/updated"
        logger.info(
            "Trip %s successfully %s (seq=%d)",
            transaction_id,
            action,
            trip_to_archive["sequence"],
        )
        # Publish trip end event
        try:
            await publish_trip_end(transaction_id, trip_to_archive["sequence"])
        except Exception as pub_err:
            logger.warning(
                "Failed to publish trip end event for %s: %s",
                transaction_id,
                pub_err,
            )
    else:
        logger.error(
            "Failed to process tripEnd for %s due to transaction failure.",
            transaction_id,
        )


# In live_tracking.py - Replace the get_active_trip function
async def get_active_trip(
    since_sequence: int | None = None,
) -> dict[str, Any] | None:
    """Get the currently active trip document from DB.

    Uses the global collection variable set during initialization.

    Args:
        since_sequence: If provided, only return trip if its sequence number is greater.

    Returns:
        Dict: The active trip document with coordinates field for frontend compatibility.

    """
    if live_trips_collection_global is None:
        logger.error(
            "Live trips collection global not initialized in get_active_trip",
        )
        return None

    query: dict[str, Any] = {"status": "active"}
    valid_since_sequence: int | None = None
    if since_sequence is not None:
        try:
            parsed_sequence = int(since_sequence)
            if parsed_sequence >= 0:
                valid_since_sequence = parsed_sequence
            else:
                logger.warning(
                    "Received negative last_sequence '%s' in get_active_trip. Ignoring.",
                    since_sequence,
                )
        except (ValueError, TypeError):
            logger.warning(
                "Invalid last_sequence '%s' received in get_active_trip. Ignoring.",
                since_sequence,
            )

    if valid_since_sequence is not None:
        query["sequence"] = {"$gt": valid_since_sequence}
        logger.debug(
            "Querying for active trip with sequence > %d",
            valid_since_sequence,
        )
    else:
        logger.debug("Querying for any active trip (no sequence filter).")

    try:
        active_trip_doc = await live_trips_collection_global.find_one(
            query,
            sort=[("sequence", -1)],
        )
    except Exception as find_err:
        logger.error(
            "Database error finding active trip: %s",
            find_err,
        )
        return None

    if active_trip_doc:
        trip_seq = active_trip_doc.get("sequence", "N/A")
        if "_id" in active_trip_doc and isinstance(
            active_trip_doc["_id"],
            ObjectId,
        ):
            active_trip_doc["_id"] = str(active_trip_doc["_id"])

        # Ensure coordinates field exists for frontend compatibility
        if "coordinates" not in active_trip_doc:
            active_trip_doc["coordinates"] = []

        logger.debug(
            "Found active trip matching query %s: %s with sequence %s",
            query,
            active_trip_doc.get("transactionId"),
            trip_seq,
        )
        return active_trip_doc

    logger.debug(
        "No active trip found matching query: %s",
        query,
    )
    return None


async def cleanup_stale_trips_logic(
    live_collection: Collection,
    archive_collection: Collection,
    stale_minutes: int = 15,
    max_archive_age_days: int = 30,
) -> dict[str, int]:
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
            {
                "status": "active",
                "lastUpdate": {"$lt": stale_threshold},
            },
        )

        async for trip in stale_trips_cursor:
            trip_id = trip.get("_id")
            transaction_id = trip.get("transactionId", "unknown_stale")
            last_update_time = trip.get("lastUpdate")

            if not trip_id or not isinstance(trip_id, ObjectId):
                logger.error(
                    "Found stale trip candidate with missing or invalid _id: %s",
                    trip,
                )
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
                last_update_time,
                datetime,
            ):
                duration = max(
                    0.0,
                    (last_update_time - start_time).total_seconds(),
                )
                trip_to_archive["duration"] = duration
            else:
                trip_to_archive.setdefault(
                    "duration",
                    trip.get("duration", 0.0),
                )

            trip_to_archive.setdefault(
                "distance",
                trip.get("distance", 0.0),
            )
            trip_to_archive["sequence"] = max(
                trip.get("sequence", 0) + 1,
                int(time.time_ns() / 1000),
            )

            # --- Build GeoJSON LineString from coordinates array before archiving stale trip ---
            coordinates = trip_to_archive.get("coordinates", [])
            geojson_coords = []

            # Extract [lon, lat] pairs from coordinates array
            for coord in coordinates:
                if isinstance(coord, dict) and "lon" in coord and "lat" in coord:
                    lon = coord.get("lon")
                    lat = coord.get("lat")
                    if lon is not None and lat is not None:
                        geojson_coords.append([lon, lat])

            # Build GeoJSON geometry based on number of points
            if len(geojson_coords) == 0:
                trip_to_archive["gps"] = None
                logger.warning(
                    "Stale Trip %s: No valid coordinates found for archiving. Setting gps to null.",
                    transaction_id,
                )
            elif len(geojson_coords) == 1:
                trip_to_archive["gps"] = {
                    "type": "Point",
                    "coordinates": geojson_coords[0],
                }
                logger.info(
                    "Stale Trip %s: Only one coordinate point found. Creating Point geometry for archive.",
                    transaction_id,
                )
            else:
                # Remove consecutive duplicates to optimize LineString
                distinct_points = [geojson_coords[0]]
                for i in range(1, len(geojson_coords)):
                    if geojson_coords[i] != geojson_coords[i - 1]:
                        distinct_points.append(geojson_coords[i])

                if len(distinct_points) == 1:
                    trip_to_archive["gps"] = {
                        "type": "Point",
                        "coordinates": distinct_points[0],
                    }
                    logger.info(
                        "Stale Trip %s: After deduplication, only one distinct point. Creating Point geometry for archive.",
                        transaction_id,
                    )
                else:
                    trip_to_archive["gps"] = {
                        "type": "LineString",
                        "coordinates": distinct_points,
                    }

            # Remove coordinates field from archived trip (gps field is now the single source of truth)
            if "coordinates" in trip_to_archive:
                del trip_to_archive["coordinates"]
            # --- End GeoJSON building for stale trips ---

            async def archive_stale_op(
                session=None,
            ):
                await archive_collection.update_one(
                    {"transactionId": transaction_id},
                    {"$set": trip_to_archive},
                    upsert=True,
                    session=session,
                )

            async def delete_stale_op(
                session=None,
            ):
                await live_collection.delete_one(
                    {"_id": trip_id},
                    session=session,
                )

            success = await run_transaction(
                [
                    archive_stale_op,
                    delete_stale_op,
                ],
            )

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
            await asyncio.sleep(0.01)

    except Exception as e:
        logger.exception(
            "Error during stale trip archiving phase: %s",
            str(e),
        )

    try:
        delete_result = await archive_collection.delete_many(
            {"endTime": {"$lt": archive_threshold}},
        )
        old_removed_count = delete_result.deleted_count
        if old_removed_count > 0:
            logger.info(
                "Deleted %d old archived trips (ended before %s)",
                old_removed_count,
                archive_threshold.isoformat(),
            )
    except Exception as e:
        logger.exception(
            "Error during old archive cleanup phase: %s",
            str(e),
        )

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
    last_sequence: int | str | None = 0,
) -> dict[str, Any]:
    """API endpoint logic to get updates about the currently active trip.

    Uses the global collection variable set during initialization.

    Args:
        last_sequence: The last sequence number the client has seen. Defaults to 0.

    Returns:
        Dict: Contains status, has_update flag, and trip data if an update is available,
              or current_sequence if no update but an active trip exists.

    """
    if live_trips_collection_global is None:
        logger.error(
            "Live trips collection global not initialized in get_trip_updates",
        )
        return {
            "status": "error",
            "has_update": False,
            "message": "Server error: Database connection not ready.",
        }

    client_sequence: int = 0
    if last_sequence is not None:
        try:
            parsed_sequence = int(float(last_sequence))
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

    logger.debug(
        "API request for trip updates since sequence: %d",
        client_sequence,
    )

    try:
        active_trip_update = await get_active_trip(
            since_sequence=client_sequence,
        )

        if active_trip_update:
            current_server_seq = active_trip_update.get("sequence", 0)
            logger.info(
                "Providing trip update for %s (sequence %s > client %d)",
                active_trip_update.get("transactionId", "unknown"),
                current_server_seq,
                client_sequence,
            )
            # Ensure _id is str, and other fields like datetimes are serialized
            serialized_trip_update = serialize_document(active_trip_update)

            return {
                "status": "success",
                "has_update": True,
                "trip": serialized_trip_update,  # Use serialized version
            }
        try:
            any_active_trip_doc = await live_trips_collection_global.find_one(
                {"status": "active"},
                projection={"sequence": 1},
                sort=[("sequence", -1)],
            )
        except Exception as find_err:
            logger.error(
                "Database error checking for any active trip sequence: %s",
                find_err,
            )
            return {
                "status": "success",
                "has_update": False,
                "message": "No new updates available (error checking current state).",
                "current_sequence": client_sequence,
            }

        if any_active_trip_doc:
            current_server_seq = any_active_trip_doc.get("sequence", 0)
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
        logger.info("No active trips found in the database.")
        return {
            "status": "success",
            "has_update": False,
            "message": "No active trips currently.",
            "current_sequence": 0,
        }

    except Exception as e:
        logger.exception(
            "Error in get_trip_updates API logic: %s",
            str(e),
        )
        return {
            "status": "error",
            "has_update": False,
            "message": "An internal server error occurred while checking for updates.",
        }
