import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from pymongo.collection import Collection
from pymongo.results import UpdateResult

from db import run_transaction
from timestamp_utils import sort_and_filter_trip_coordinates
from utils import haversine

logger = logging.getLogger(__name__)

live_trips_collection_global: Collection | None = None
archived_live_trips_collection_global: Collection | None = None


def initialize_db(db_live_trips, db_archived_live_trips):
    """Initialize the database collections used by this module (primarily
    for non-task access).
    """
    global live_trips_collection_global, archived_live_trips_collection_global
    live_trips_collection_global = db_live_trips
    archived_live_trips_collection_global = db_archived_live_trips
    logger.debug("Live tracking global DB collections initialized/updated")


def _parse_iso_datetime(
    timestamp_str: str | None,
) -> datetime | None:
    """Safely parse an ISO 8601 timestamp string into a timezone-aware datetime object
    (UTC).
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
        logger.error(
            "Error parsing timestamp string '%s': %s",
            timestamp_str,
            e,
        )
        return None


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
    if not vin:
        logger.warning(
            "Missing vin in tripStart event for %s.",
            transaction_id,
        )

    start_timestamp_str = start_data.get("timestamp")
    start_time_zone = start_data.get("timeZone")
    start_odometer = start_data.get("odometer")

    if start_time_zone is None:
        logger.warning(
            "Missing 'timeZone' in tripStart payload for %s. Defaulting to UTC.",
            transaction_id,
        )
        start_time_zone = "UTC"
    if start_odometer is None:
        logger.warning(
            "Missing 'odometer' in tripStart payload for %s. Storing as null.",
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

    logger.info(
        "Processing tripStart event for transactionId: %s",
        transaction_id,
    )

    sequence = int(time.time_ns() / 1000)

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
        "duration": 0.0,
        "pointsRecorded": 0,
        "sequence": sequence,
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

    Updates coordinates and recalculates live metrics for an active trip.

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

    try:
        new_coords: list[dict[str, Any]] = sort_and_filter_trip_coordinates(
            trip_data_points,
        )
    except Exception as e:
        logger.exception(
            "Error processing coordinates from tripData for %s: %s",
            transaction_id,
            e,
        )
        return

    if not new_coords:
        logger.info(
            "No valid *new* coordinates found after processing tripData for %s.",
            transaction_id,
        )
        sequence = max(
            trip_doc.get("sequence", 0) + 1,
            int(time.time_ns() / 1000),
        )
        await live_collection.update_one(
            {"_id": trip_doc["_id"]},
            {
                "$set": {
                    "sequence": sequence,
                    "lastUpdate": datetime.now(timezone.utc),
                },
            },
        )
        return

    existing_coords: list[dict[str, Any]] = trip_doc.get("coordinates", []) or []
    all_coords_map: dict[str, dict[str, Any]] = {}
    for c in existing_coords:
        ts = c.get("timestamp")
        if isinstance(ts, datetime):
            all_coords_map[ts.isoformat()] = c
        elif isinstance(ts, str):
            parsed_ts = _parse_iso_datetime(ts)
            if parsed_ts:
                all_coords_map[parsed_ts.isoformat()] = c
    for c in new_coords:
        ts = c.get("timestamp")
        if isinstance(ts, datetime):
            all_coords_map[ts.isoformat()] = c
        else:
            logger.warning(
                "Skipping new coordinate due to invalid timestamp type (%s): %s for trip %s",
                type(ts).__name__,
                c,
                transaction_id,
            )

    if not all_coords_map:
        logger.warning(
            "Coordinate map is empty after merge for trip %s.",
            transaction_id,
        )
        return

    sorted_unique_coords = sorted(
        all_coords_map.values(),
        key=lambda c: c["timestamp"],
    )

    if not sorted_unique_coords:
        logger.warning(
            "No coordinates available after sorting/deduplication for trip %s.",
            transaction_id,
        )
        return

    start_time = trip_doc.get("startTime")
    if not isinstance(start_time, datetime):
        start_time = (
            _parse_mongo_date_dict(start_time)
            if isinstance(start_time, dict)
            else (
                _parse_iso_datetime(start_time) if isinstance(start_time, str) else None
            )
        )
        if not isinstance(start_time, datetime):
            logger.error(
                "Invalid or missing startTime (%s) in existing trip document for %s. Cannot calculate duration/avgSpeed accurately. Using first coordinate time as fallback.",
                type(trip_doc.get("startTime")).__name__,
                transaction_id,
            )
            start_time = sorted_unique_coords[0].get("timestamp")

    last_point_time = sorted_unique_coords[-1].get("timestamp")
    duration_seconds = 0.0
    if isinstance(start_time, datetime) and isinstance(
        last_point_time,
        datetime,
    ):
        duration_seconds = max(
            0.0,
            (last_point_time - start_time).total_seconds(),
        )
        if duration_seconds == 0 and last_point_time != start_time:
            logger.warning(
                "Calculated zero duration despite different start/end times for trip %s",
                transaction_id,
            )
    else:
        logger.warning(
            "Cannot calculate duration for trip %s due to missing/invalid start (%s) or last point time (%s).",
            transaction_id,
            type(start_time).__name__,
            type(last_point_time).__name__,
        )

    max_segment_speed_mph = 0.0
    current_speed_mph = 0.0
    full_trip_distance_miles = 0.0
    valid_speeds_for_avg_mph = []

    if len(sorted_unique_coords) >= 2:
        for i in range(1, len(sorted_unique_coords)):
            prev = sorted_unique_coords[i - 1]
            curr = sorted_unique_coords[i]

            if (
                not all(
                    k in prev and isinstance(prev[k], (int, float))
                    for k in ("lon", "lat")
                )
                or not all(
                    k in curr and isinstance(curr[k], (int, float))
                    for k in ("lon", "lat")
                )
                or not isinstance(
                    prev.get("timestamp"),
                    datetime,
                )
                or not isinstance(
                    curr.get("timestamp"),
                    datetime,
                )
            ):
                logger.warning(
                    "Skipping recalculation for segment %d-%d in trip %s due to invalid data types or missing keys.",
                    i - 1,
                    i,
                    transaction_id,
                )
                continue

            try:
                segment_distance_miles = haversine(
                    prev["lon"],
                    prev["lat"],
                    curr["lon"],
                    curr["lat"],
                    unit="miles",
                )
                if segment_distance_miles >= 0:
                    full_trip_distance_miles += segment_distance_miles

                time_diff_seconds = (
                    curr["timestamp"] - prev["timestamp"]
                ).total_seconds()

                if time_diff_seconds > 0.5:
                    segment_speed_mph = (
                        segment_distance_miles / time_diff_seconds
                    ) * 3600
                    if 0 <= segment_speed_mph < 200:
                        max_segment_speed_mph = max(
                            max_segment_speed_mph,
                            segment_speed_mph,
                        )
                        valid_speeds_for_avg_mph.append(segment_speed_mph)
                        if i == len(sorted_unique_coords) - 1:
                            current_speed_mph = segment_speed_mph
                    else:
                        logger.debug(
                            "Ignoring unrealistic segment speed %.1f mph during recalculation for trip %s",
                            segment_speed_mph,
                            transaction_id,
                        )
                elif time_diff_seconds < 0:
                    logger.warning(
                        "Negative time difference (%.2fs) detected between points %d and %d during recalculation for trip %s. Skipping segment speed.",
                        time_diff_seconds,
                        i - 1,
                        i,
                        transaction_id,
                    )

            except (
                TypeError,
                ValueError,
            ) as calc_err:
                logger.error(
                    "Error during segment calculation for trip %s: %s. Prev: %s, Curr: %s",
                    transaction_id,
                    calc_err,
                    prev,
                    curr,
                )
                continue

    max_speed_mph = max(
        trip_doc.get("maxSpeed", 0.0),
        max_segment_speed_mph,
    )

    avg_speed_mph = 0.0
    if duration_seconds > 0:
        duration_hours = duration_seconds / 3600
        avg_speed_mph = (
            full_trip_distance_miles / duration_hours if duration_hours > 0 else 0.0
        )
    elif valid_speeds_for_avg_mph:
        avg_speed_mph = sum(valid_speeds_for_avg_mph) / len(
            valid_speeds_for_avg_mph,
        )
        logger.info(
            "Calculated fallback average speed %.1f mph for trip %s based on %d segments (duration was %.1fs).",
            avg_speed_mph,
            transaction_id,
            len(valid_speeds_for_avg_mph),
            duration_seconds,
        )

    sequence = max(
        trip_doc.get("sequence", 0) + 1,
        int(time.time_ns() / 1000),
    )

    update_payload = {
        "coordinates": sorted_unique_coords,
        "lastUpdate": last_point_time or datetime.now(timezone.utc),
        "distance": full_trip_distance_miles,
        "currentSpeed": current_speed_mph,
        "maxSpeed": max_speed_mph,
        "avgSpeed": avg_speed_mph,
        "duration": duration_seconds,
        "sequence": sequence,
        "pointsRecorded": len(sorted_unique_coords),
    }

    try:
        update_result = await live_collection.update_one(
            {"_id": trip_doc["_id"]},
            {"$set": update_payload},
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
                "Failed to find trip %s (_id: %s) for update after processing data. It might have been deleted/archived concurrently.",
                transaction_id,
                trip_doc.get("_id"),
            )
        else:
            logger.info(
                "Trip data for %s processed, but no calculated fields changed. Sequence updated to %d.",
                transaction_id,
                sequence,
            )
            await live_collection.update_one(
                {"_id": trip_doc["_id"]},
                {
                    "$set": {
                        "sequence": sequence,
                        "lastUpdate": update_payload["lastUpdate"],
                    },
                },
            )
    except Exception as update_err:
        logger.error(
            "Database error updating trip %s after tripData processing: %s",
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
        logger.error(
            "Missing or invalid 'metrics' object in tripMetrics event for %s. Payload: %s",
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
        )
    except Exception as find_err:
        logger.error(
            "Database error finding active trip %s for tripMetrics: %s",
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
    update_fields["lastUpdate"] = metrics_timestamp or trip_doc.get(
        "lastUpdate",
        datetime.now(timezone.utc),
    )

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

    _safe_update_float("duration", "tripTime")
    _safe_update_float("distance", "tripDistance")
    _safe_update_float("totalIdlingTime", "totalIdlingTime")
    _safe_update_float("avgSpeed", "averageDriveSpeed")
    _safe_update_int("hardBrakingCounts", "hardBrakingCounts")
    _safe_update_int(
        "hardAccelerationCounts",
        "hardAccelerationCounts",
    )

    if "maxSpeed" in metrics_data and metrics_data["maxSpeed"] is not None:
        try:
            metric_max_speed = float(metrics_data["maxSpeed"])
            current_max_speed = trip_doc.get("maxSpeed", 0.0)
            if not isinstance(current_max_speed, (int, float)):
                current_max_speed = 0.0
            update_fields["maxSpeed"] = max(
                current_max_speed,
                metric_max_speed,
            )
        except (ValueError, TypeError):
            logger.warning(
                "Invalid maxSpeed value in metrics for %s: %s",
                transaction_id,
                metrics_data["maxSpeed"],
            )

    if len(update_fields) <= 1:
        logger.info(
            "No new metric values found to update in tripMetrics payload for %s.",
            transaction_id,
        )
        sequence = max(
            trip_doc.get("sequence", 0) + 1,
            int(time.time_ns() / 1000),
        )
        await live_collection.update_one(
            {"_id": trip_doc["_id"]},
            {
                "$set": {
                    "sequence": sequence,
                    "lastUpdate": update_fields["lastUpdate"],
                },
            },
        )
        return

    update_fields["sequence"] = max(
        trip_doc.get("sequence", 0) + 1,
        int(time.time_ns() / 1000),
    )

    try:
        update_result = await live_collection.update_one(
            {"_id": trip_doc["_id"]},
            {"$set": update_fields},
        )

        if update_result.modified_count > 0:
            logger.info(
                "Updated trip metrics for: %s (seq=%d)",
                transaction_id,
                update_fields["sequence"],
            )
        elif update_result.matched_count == 0:
            logger.error(
                "Failed to find trip %s (_id: %s) for metrics update. Possible race condition.",
                transaction_id,
                trip_doc.get("_id"),
            )
        else:
            logger.info(
                "Trip metrics for %s processed, but no fields were modified in DB. Sequence updated to %d.",
                transaction_id,
                update_fields["sequence"],
            )
            await live_collection.update_one(
                {"_id": trip_doc["_id"]},
                {
                    "$set": {
                        "sequence": update_fields["sequence"],
                        "lastUpdate": update_fields["lastUpdate"],
                    },
                },
            )
    except Exception as update_err:
        logger.error(
            "Database error updating trip %s after tripMetrics processing: %s",
            transaction_id,
            update_err,
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
    end_odometer = end_data.get("odometer")
    fuel_consumed_raw = end_data.get("fuelConsumed")

    if end_time_zone is None:
        logger.warning(
            "Missing 'timeZone' in tripEnd payload for %s. Defaulting to UTC.",
            transaction_id,
        )
        end_time_zone = "UTC"

    if end_odometer is None:
        logger.warning(
            "Missing 'odometer' in tripEnd payload for %s. Storing as null.",
            transaction_id,
        )

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
        logger.warning(
            "Missing 'fuelConsumed' in tripEnd payload for %s. Storing as null.",
            transaction_id,
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

    # --- Begin modification: Construct GeoJSON for 'gps' field ---
    final_coordinates = trip_to_archive.pop(
        "coordinates", []
    )  # Get and remove old 'coordinates' field
    if (
        final_coordinates and len(final_coordinates) >= 1
    ):  # Need at least one point to potentially form a valid LineString if duplicated by chance, or to become a Point
        processed_coords_for_geojson = []
        # Deduplicate coordinates while preserving order for the first unique occurrences
        seen_coords = set()
        for point_data in final_coordinates:
            if isinstance(point_data, list) and len(point_data) >= 2:
                coord_tuple = (point_data[0], point_data[1])
                if coord_tuple not in seen_coords:
                    processed_coords_for_geojson.append([point_data[0], point_data[1]])
                    seen_coords.add(coord_tuple)
            # Add handling for other coordinate structures if necessary

        if len(processed_coords_for_geojson) >= 2:
            trip_to_archive["gps"] = {
                "type": "LineString",
                "coordinates": processed_coords_for_geojson,
            }
        elif len(processed_coords_for_geojson) == 1:
            # If only one unique point, store as Point
            trip_to_archive["gps"] = {
                "type": "Point",
                "coordinates": processed_coords_for_geojson[0],
            }
            logger.info(
                f"Trip {transaction_id}: Only one unique coordinate point. Storing 'gps' as GeoJSON Point."
            )
        else:  # 0 unique points after processing (e.g. if original list was empty or contained no valid coord pairs)
            logger.warning(
                f"Trip {transaction_id}: Not enough valid unique coordinate pairs ({len(processed_coords_for_geojson)}) after processing for GeoJSON. 'gps' field will be omitted."
            )
            trip_to_archive["gps"] = None  # Or omit
    else:  # Original final_coordinates list was empty or had less than 1 point (effectively empty)
        logger.warning(
            f"Trip {transaction_id}: Original 'coordinates' list was empty or had insufficient points ({len(final_coordinates)}). 'gps' field will be omitted/set to null."
        )
        trip_to_archive["gps"] = None  # Or omit
    # --- End modification ---

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
    else:
        logger.error(
            "Failed to process tripEnd for %s due to transaction failure.",
            transaction_id,
        )


async def get_active_trip(
    since_sequence: int | None = None,
) -> dict[str, Any] | None:
    """Get the currently active trip document from DB.

    Uses the global collection variable set during initialization.

    Args:
        since_sequence: If provided, only return trip if its sequence number is greater.

    Returns:
        Dict: The raw active trip document from MongoDB, or None.

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

            # --- Begin modification: Construct GeoJSON for 'gps' field for stale trips ---
            final_coordinates = trip_to_archive.pop(
                "coordinates", []
            )  # Get and remove old 'coordinates' field
            if (
                final_coordinates and len(final_coordinates) >= 1
            ):  # Need at least one point to potentially form a valid LineString if duplicated by chance, or to become a Point
                processed_coords_for_geojson = []
                # Deduplicate coordinates while preserving order for the first unique occurrences
                seen_coords = set()
                for point_data in final_coordinates:
                    if isinstance(point_data, list) and len(point_data) >= 2:
                        coord_tuple = (point_data[0], point_data[1])
                        if coord_tuple not in seen_coords:
                            processed_coords_for_geojson.append(
                                [point_data[0], point_data[1]]
                            )
                            seen_coords.add(coord_tuple)
                    # Add handling for other coordinate structures if necessary

                if len(processed_coords_for_geojson) >= 2:
                    trip_to_archive["gps"] = {
                        "type": "LineString",
                        "coordinates": processed_coords_for_geojson,
                    }
                elif len(processed_coords_for_geojson) == 1:
                    # If only one unique point, store as Point
                    trip_to_archive["gps"] = {
                        "type": "Point",
                        "coordinates": processed_coords_for_geojson[0],
                    }
                    logger.info(
                        f"Stale Trip {transaction_id}: Only one unique coordinate point. Storing 'gps' as GeoJSON Point."
                    )
                else:  # 0 unique points after processing (e.g. if original list was empty or contained no valid coord pairs)
                    logger.warning(
                        f"Stale Trip {transaction_id}: Not enough valid unique coordinate pairs ({len(processed_coords_for_geojson)}) for GeoJSON. 'gps' field omitted."
                    )
                    trip_to_archive["gps"] = None
            else:
                logger.warning(
                    f"Stale Trip {transaction_id}: 'coordinates' list has < 1 points ({len(final_coordinates)}). 'gps' field omitted."
                )
                trip_to_archive["gps"] = None
            # --- End modification ---

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
            if "_id" in active_trip_update and isinstance(
                active_trip_update["_id"],
                ObjectId,
            ):
                active_trip_update["_id"] = str(active_trip_update["_id"])

            return {
                "status": "success",
                "has_update": True,
                "trip": active_trip_update,
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
