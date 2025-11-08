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
from db import run_transaction, serialize_document
from trip_event_publisher import publish_trip_state
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


def _next_sequence() -> int:
    """Generate a monotonically increasing sequence value suitable for dedupe."""
    return int(time.time_ns() / 1000)


async def _publish_trip_snapshot(
    trip_doc: dict[str, Any],
    *,
    status: str = "active",
) -> None:
    """Serialize and publish the latest trip snapshot to connected clients."""
    if not trip_doc:
        return

    transaction_id = trip_doc.get("transactionId")
    if not transaction_id:
        logger.warning(
            "Skipping trip publish because transactionId is missing: %s",
            trip_doc,
        )
        return

    sequence = trip_doc.get("sequence")
    if not isinstance(sequence, int):
        sequence = _next_sequence()
        trip_doc["sequence"] = sequence

    try:
        serialized_trip = serialize_document(trip_doc)
        await publish_trip_state(
            transaction_id,
            serialized_trip,
            sequence,
            status=status,
        )
    except Exception as pub_err:
        logger.warning(
            "Failed to publish trip snapshot for %s: %s",
            transaction_id,
            pub_err,
        )


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

    sequence = _next_sequence()

    # TripStart does not include coordinate data; initialize placeholders that
    # will be populated as tripData arrives.
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
        "totalIdlingTime": 0.0,
        "hardBrakingCounts": 0,
        "hardAccelerationCounts": 0,
        "fuelConsumed": None,
        "endTime": None,
        "endTimeZone": None,
        "endOdometer": None,
        "closed_reason": None,
        "sequence": sequence,
    }

    try:
        result = await live_collection.replace_one(
            {"transactionId": transaction_id},
            new_trip,
            upsert=True,
        )
        logger.info(
            "Trip %s marked as active (upserted=%s)",
            transaction_id,
            bool(result.upserted_id),
        )
    except Exception as db_err:
        logger.error(
            "Failed to persist tripStart for %s: %s",
            transaction_id,
            db_err,
        )
        return

    try:
        persisted_trip = await live_collection.find_one(
            {"transactionId": transaction_id},
        )
        if persisted_trip:
            await _publish_trip_snapshot(persisted_trip, status="active")
    except Exception as pub_err:
        logger.warning(
            "Trip %s started but publish failed: %s",
            transaction_id,
            pub_err,
        )


async def process_trip_data(
    data: dict[str, Any],
    live_collection: Collection,
    _archive_collection: Collection,
) -> None:
    """Process a tripData event from the Bouncie webhook.

    Updates coordinates and recalculates live metrics incrementally for an active trip.
    Uses MongoDB atomic operators to avoid reading and rewriting entire arrays.

    Args:
        data: The webhook payload conforming to Bouncie API spec.
        live_collection: The MongoDB collection for active trips.
        _archive_collection: Unused placeholder for backward compatibility.
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
        logger.info(
            "Received tripData for unknown or inactive trip %s; ignoring payload.",
            transaction_id,
        )
        return

    logger.info(
        "Processing tripData event for %s with %d point(s)",
        transaction_id,
        len(trip_data_points),
    )

    coords_by_ts: dict[str, dict[str, Any]] = {}

    def _coerce_timestamp(value: Any) -> datetime | None:
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        if isinstance(value, dict):
            return _parse_mongo_date_dict(value)
        if isinstance(value, str):
            return _parse_iso_datetime(value)
        return None

    def _store_coord(coord: dict[str, Any]) -> None:
        timestamp = _coerce_timestamp(coord.get("timestamp"))
        lat = coord.get("lat")
        lon = coord.get("lon")
        if timestamp and lat is not None and lon is not None:
            try:
                lat_val = float(lat)
                lon_val = float(lon)
            except (TypeError, ValueError):
                return

            entry: dict[str, Any] = {
                "timestamp": timestamp.astimezone(timezone.utc),
                "lat": lat_val,
                "lon": lon_val,
            }
            speed_val = coord.get("speed")
            if speed_val is not None:
                try:
                    entry["speed"] = float(speed_val)
                except (TypeError, ValueError):
                    pass

            coords_by_ts[entry["timestamp"].isoformat()] = entry

    # Seed existing coordinates
    for existing_coord in trip_doc.get("coordinates", []):
        if isinstance(existing_coord, dict):
            _store_coord(existing_coord)

    # Merge incoming points
    for point in trip_data_points:
        gps_payload = point.get("gps", {})
        candidate = {
            "timestamp": point.get("timestamp"),
            "lat": gps_payload.get("lat"),
            "lon": gps_payload.get("lon"),
            "speed": point.get("speed"),
        }
        if (
            candidate["timestamp"]
            and candidate["lat"] is not None
            and candidate["lon"] is not None
        ):
            _store_coord(candidate)
        else:
            logger.debug(
                "Skipping invalid tripData point for %s: %s",
                transaction_id,
                point,
            )

    combined_coords = sorted(
        coords_by_ts.values(),
        key=lambda coord: coord["timestamp"],
    )

    if not combined_coords:
        logger.info(
            "No valid coordinates remain after dedupe for %s; sequence bump only.",
            transaction_id,
        )
        sequence = max(trip_doc.get("sequence", 0) + 1, _next_sequence())
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

    # Calculate aggregate metrics directly from the complete path.
    distance_miles = 0.0
    computed_max_speed = float(trip_doc.get("maxSpeed") or 0.0)
    computed_current_speed = combined_coords[-1].get("speed") or 0.0

    for idx in range(1, len(combined_coords)):
        prev = combined_coords[idx - 1]
        curr = combined_coords[idx]
        segment_distance = haversine(
            prev["lon"],
            prev["lat"],
            curr["lon"],
            curr["lat"],
            unit="miles",
        )
        distance_miles += segment_distance

        prev_ts = prev.get("timestamp")
        curr_ts = curr.get("timestamp")
        if isinstance(prev_ts, datetime) and isinstance(curr_ts, datetime):
            elapsed = (curr_ts - prev_ts).total_seconds()
            if elapsed > 0:
                segment_speed = (segment_distance / elapsed) * 3600
                if segment_speed >= 0:
                    computed_max_speed = max(computed_max_speed, segment_speed)
                    if idx == len(combined_coords) - 1 and computed_current_speed == 0:
                        computed_current_speed = segment_speed

    # Prefer direct speed reading on final sample if provided.
    final_speed = combined_coords[-1].get("speed")
    if final_speed is not None:
        try:
            computed_current_speed = float(final_speed)
        except (TypeError, ValueError):
            pass

    start_time_value = trip_doc.get("startTime")
    if not isinstance(start_time_value, datetime):
        start_time_value = _parse_mongo_date_dict(start_time_value)

    if not start_time_value and combined_coords:
        start_time_value = combined_coords[0]["timestamp"]

    last_point_time = combined_coords[-1]["timestamp"]
    duration_seconds = 0.0
    if isinstance(start_time_value, datetime) and isinstance(last_point_time, datetime):
        duration_seconds = max(
            0.0,
            (last_point_time - start_time_value).total_seconds(),
        )

    avg_speed = 0.0
    if duration_seconds > 0:
        avg_speed = distance_miles / (duration_seconds / 3600)

    normalized_coords: list[dict[str, Any]] = [
        {
            k: v
            for k, v in {
                "timestamp": coord["timestamp"].astimezone(timezone.utc),
                "lat": coord["lat"],
                "lon": coord["lon"],
                "speed": coord.get("speed"),
            }.items()
            if v is not None
        }
        for coord in combined_coords
    ]

    points_recorded = len(normalized_coords)
    sequence = max(trip_doc.get("sequence", 0) + 1, _next_sequence())

    update_payload = {
        "coordinates": normalized_coords,
        "distance": distance_miles,
        "maxSpeed": computed_max_speed,
        "currentSpeed": computed_current_speed,
        "avgSpeed": avg_speed,
        "duration": duration_seconds,
        "pointsRecorded": points_recorded,
        "lastUpdate": last_point_time,
        "sequence": sequence,
    }

    try:
        updated_trip_doc = await live_collection.find_one_and_update(
            {"_id": trip_doc["_id"]},
            {"$set": update_payload},
            return_document=pymongo.ReturnDocument.AFTER,
        )
        if not updated_trip_doc:
            logger.warning(
                "Trip %s vanished before update could be applied.",
                transaction_id,
            )
            return

        logger.info(
            "Trip %s updated with %d total coordinate(s) (seq=%d)",
            transaction_id,
            points_recorded,
            sequence,
        )

        await _publish_trip_snapshot(updated_trip_doc, status="active")
    except Exception as update_err:
        logger.error(
            "Failed to apply tripData update for %s: %s",
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
        sequence = max(initial_trip_doc.get("sequence", 0) + 1, _next_sequence())
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
                "Updated trip metrics for %s (seq=%d)",
                transaction_id,
                updated_trip_doc.get("sequence"),
            )
            try:
                await _publish_trip_snapshot(updated_trip_doc, status="active")
            except Exception as pub_err:
                logger.warning(
                    "Failed to publish updated metrics for %s: %s",
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
        _next_sequence(),
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
        # Publish final snapshot so clients can clean up gracefully
        try:
            await _publish_trip_snapshot(trip_to_archive, status="completed")
        except Exception as pub_err:
            logger.warning(
                "Failed to publish completed trip %s: %s",
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
                _next_sequence(),
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
                try:
                    await _publish_trip_snapshot(trip_to_archive, status="completed")
                except Exception as pub_err:
                    logger.warning(
                        "Failed to publish stale trip archive for %s: %s",
                        transaction_id,
                        pub_err,
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
