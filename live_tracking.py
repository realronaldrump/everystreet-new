"""Live trip tracking for Bouncie webhook events.

Simplified single-user implementation for real-time trip visualization.
Trips are stored in live_trips collection for visual reference only.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import pymongo
from pymongo.collection import Collection

from date_utils import parse_timestamp
from db import serialize_document
from trip_event_publisher import publish_trip_state
from utils import haversine

logger = logging.getLogger(__name__)

# Global collection reference (initialized by app.py)
live_trips_collection_global: Collection | None = None


def initialize_db(db_live_trips, _db_archived_live_trips=None):
    """Initialize the database collection used by this module."""
    global live_trips_collection_global
    live_trips_collection_global = db_live_trips
    logger.info("Live tracking database initialized")


async def _publish_trip_snapshot(
    trip_doc: dict[str, Any], status: str = "active"
) -> None:
    """Publish trip update to WebSocket clients via Redis."""
    transaction_id = trip_doc.get("transactionId")
    if not transaction_id:
        logger.warning("Cannot publish trip without transactionId")
        return

    try:
        serialized_trip = serialize_document(trip_doc)
        await publish_trip_state(transaction_id, serialized_trip, status=status)
    except Exception as e:
        logger.error(f"Failed to publish trip {transaction_id}: {e}")


def _parse_timestamp(timestamp_str: str | None) -> datetime | None:
    """Parse ISO timestamp string to datetime."""
    if not timestamp_str:
        return None
    try:
        return parse_timestamp(timestamp_str)
    except Exception:
        return None


def _extract_coordinates_from_data(data_points: list[dict]) -> list[dict[str, Any]]:
    """Extract and normalize coordinates from Bouncie tripData payload.

    Returns list of dicts with keys: timestamp, lat, lon, speed (optional)
    """
    coords = []
    for point in data_points:
        timestamp = _parse_timestamp(point.get("timestamp"))
        gps = point.get("gps", {})
        lat = gps.get("lat")
        lon = gps.get("lon")

        if timestamp and lat is not None and lon is not None:
            coord = {
                "timestamp": timestamp,
                "lat": float(lat),
                "lon": float(lon),
            }

            # Include speed if available
            speed = point.get("speed")
            if speed is not None:
                coord["speed"] = float(speed)

            coords.append(coord)

    return coords


def _deduplicate_coordinates(existing: list[dict], new: list[dict]) -> list[dict]:
    """Merge and deduplicate coordinates by timestamp.

    Bouncie sends duplicate data across real-time and periodic streams.
    Use timestamp as unique key, preferring newer data.
    """
    # Build dict keyed by ISO timestamp
    coords_map = {}

    for coord in existing + new:
        if isinstance(coord, dict) and "timestamp" in coord:
            ts = coord["timestamp"]
            # Convert datetime to ISO string for consistent key
            if isinstance(ts, datetime):
                key = ts.isoformat()
            else:
                key = str(ts)
            coords_map[key] = coord

    # Sort by timestamp
    sorted_coords = sorted(coords_map.values(), key=lambda c: c["timestamp"])
    return sorted_coords


def _calculate_trip_metrics(
    coordinates: list[dict], start_time: datetime
) -> dict[str, Any]:
    """Calculate distance, speed, and duration from coordinates."""
    if not coordinates:
        return {
            "distance": 0.0,
            "maxSpeed": 0.0,
            "currentSpeed": 0.0,
            "avgSpeed": 0.0,
            "duration": 0.0,
            "pointsRecorded": 0,
        }

    distance_miles = 0.0
    max_speed = 0.0
    current_speed = 0.0

    # Calculate distance between consecutive points
    for i in range(1, len(coordinates)):
        prev = coordinates[i - 1]
        curr = coordinates[i]

        segment_dist = haversine(
            prev["lon"], prev["lat"], curr["lon"], curr["lat"], unit="miles"
        )
        distance_miles += segment_dist

        # Calculate speed from distance/time
        time_diff = (curr["timestamp"] - prev["timestamp"]).total_seconds()
        if time_diff > 0:
            segment_speed = (segment_dist / time_diff) * 3600  # mph
            max_speed = max(max_speed, segment_speed)

    # Current speed from last point or last segment
    if coordinates[-1].get("speed") is not None:
        current_speed = coordinates[-1]["speed"]
    elif len(coordinates) > 1:
        # Calculate from last segment
        prev = coordinates[-2]
        curr = coordinates[-1]
        time_diff = (curr["timestamp"] - prev["timestamp"]).total_seconds()
        if time_diff > 0:
            last_dist = haversine(
                prev["lon"], prev["lat"], curr["lon"], curr["lat"], unit="miles"
            )
            current_speed = (last_dist / time_diff) * 3600

    # Duration and average speed
    last_time = coordinates[-1]["timestamp"]
    duration = (last_time - start_time).total_seconds()
    avg_speed = (distance_miles / (duration / 3600)) if duration > 0 else 0.0

    return {
        "distance": distance_miles,
        "maxSpeed": max_speed,
        "currentSpeed": current_speed,
        "avgSpeed": avg_speed,
        "duration": duration,
        "pointsRecorded": len(coordinates),
        "lastUpdate": last_time,
    }


def _coordinates_to_geojson(coordinates: list[dict]) -> dict | None:
    """Convert coordinate list to GeoJSON LineString or Point."""
    if not coordinates:
        return None

    # Extract [lon, lat] pairs
    geojson_coords = [[c["lon"], c["lat"]] for c in coordinates]

    # Remove consecutive duplicates
    distinct = [geojson_coords[0]]
    for coord in geojson_coords[1:]:
        if coord != distinct[-1]:
            distinct.append(coord)

    if len(distinct) == 1:
        return {"type": "Point", "coordinates": distinct[0]}
    else:
        return {"type": "LineString", "coordinates": distinct}


# ============================================================================
# Event Handlers
# ============================================================================


async def process_trip_start(data: dict[str, Any], live_collection: Collection) -> None:
    """Process tripStart event - initialize new trip."""
    transaction_id = data.get("transactionId")
    start_data = data.get("start", {})

    if not transaction_id or not start_data:
        logger.error(f"Invalid tripStart payload: {data}")
        return

    start_time = _parse_timestamp(start_data.get("timestamp"))
    if not start_time:
        start_time = datetime.now(timezone.utc)
        logger.warning(f"Trip {transaction_id}: Using current time as fallback")

    trip = {
        "transactionId": transaction_id,
        "vin": data.get("vin"),
        "imei": data.get("imei"),
        "status": "active",
        "startTime": start_time,
        "startTimeZone": start_data.get("timeZone", "UTC"),
        "startOdometer": start_data.get("odometer"),
        "coordinates": [],
        "distance": 0.0,
        "currentSpeed": 0.0,
        "maxSpeed": 0.0,
        "avgSpeed": 0.0,
        "duration": 0.0,
        "pointsRecorded": 0,
        "totalIdlingTime": 0.0,
        "hardBrakingCounts": 0,
        "hardAccelerationCounts": 0,
        "lastUpdate": start_time,
    }

    await live_collection.replace_one(
        {"transactionId": transaction_id}, trip, upsert=True
    )

    logger.info(f"Trip {transaction_id} started")
    await _publish_trip_snapshot(trip, status="active")


async def process_trip_data(data: dict[str, Any], live_collection: Collection) -> None:
    """Process tripData event - update coordinates and metrics."""
    transaction_id = data.get("transactionId")
    data_points = data.get("data", [])

    if not transaction_id or not data_points:
        logger.warning(f"Invalid tripData payload: {data}")
        return

    # Fetch existing trip
    trip = await live_collection.find_one(
        {"transactionId": transaction_id, "status": "active"}
    )

    if not trip:
        logger.warning(f"Trip {transaction_id} not found for tripData")
        return

    # Extract new coordinates
    new_coords = _extract_coordinates_from_data(data_points)
    if not new_coords:
        logger.debug(f"Trip {transaction_id}: No valid coordinates in tripData")
        return

    # Merge with existing, deduplicate
    existing_coords = trip.get("coordinates", [])
    all_coords = _deduplicate_coordinates(existing_coords, new_coords)

    # Calculate metrics
    start_time = trip.get("startTime")
    if not isinstance(start_time, datetime):
        start_time = all_coords[0]["timestamp"]

    metrics = _calculate_trip_metrics(all_coords, start_time)

    # Update trip
    update_fields = {
        "coordinates": all_coords,
        **metrics,
    }

    updated_trip = await live_collection.find_one_and_update(
        {"transactionId": transaction_id, "status": "active"},
        {"$set": update_fields},
        return_document=pymongo.ReturnDocument.AFTER,
    )

    if updated_trip:
        logger.info(
            f"Trip {transaction_id} updated: {len(all_coords)} points, {metrics['distance']:.2f}mi"
        )
        await _publish_trip_snapshot(updated_trip, status="active")


async def process_trip_metrics(
    data: dict[str, Any],
    live_collection: Collection,
    archive_collection: Collection,
) -> None:
    """Process tripMetrics event - update summary metrics from Bouncie."""
    transaction_id = data.get("transactionId")
    metrics_data = data.get("metrics", {})

    if not transaction_id or not metrics_data:
        logger.warning(f"Invalid tripMetrics payload: {data}")
        return

    # Check if trip exists
    trip = await live_collection.find_one(
        {"transactionId": transaction_id, "status": "active"}
    )

    if not trip:
        logger.info(
            f"Trip {transaction_id} not found for tripMetrics (may be completed)"
        )
        return

    # Build update from Bouncie metrics
    update_fields = {}

    # Use Bouncie's metrics when available (more accurate)
    if "averageSpeed" in metrics_data:
        update_fields["avgSpeed"] = float(metrics_data["averageSpeed"])
    if "idlingTime" in metrics_data:
        update_fields["totalIdlingTime"] = float(metrics_data["idlingTime"])
    if "hardBraking" in metrics_data:
        update_fields["hardBrakingCounts"] = int(metrics_data["hardBraking"])
    if "hardAcceleration" in metrics_data:
        update_fields["hardAccelerationCounts"] = int(metrics_data["hardAcceleration"])

    # Update lastUpdate timestamp
    metrics_timestamp = _parse_timestamp(metrics_data.get("timestamp"))
    if metrics_timestamp:
        update_fields["lastUpdate"] = metrics_timestamp

    if not update_fields:
        return

    # Use $max for maxSpeed to ensure it only increases
    update_operation = {"$set": update_fields}
    if "maxSpeed" in metrics_data:
        update_operation["$max"] = {"maxSpeed": float(metrics_data["maxSpeed"])}

    updated_trip = await live_collection.find_one_and_update(
        {"transactionId": transaction_id, "status": "active"},
        update_operation,
        return_document=pymongo.ReturnDocument.AFTER,
    )

    if updated_trip:
        logger.info(f"Trip {transaction_id} metrics updated")
        await _publish_trip_snapshot(updated_trip, status="active")


async def process_trip_end(
    data: dict[str, Any],
    live_collection: Collection,
    archive_collection: Collection,
) -> None:
    """Process tripEnd event - mark trip as completed."""
    transaction_id = data.get("transactionId")
    end_data = data.get("end", {})

    if not transaction_id or not end_data:
        logger.error(f"Invalid tripEnd payload: {data}")
        return

    end_time = _parse_timestamp(end_data.get("timestamp"))
    if not end_time:
        end_time = datetime.now(timezone.utc)
        logger.warning(f"Trip {transaction_id}: Using current time for end")

    # Fetch active trip
    trip = await live_collection.find_one(
        {"transactionId": transaction_id, "status": "active"}
    )

    if not trip:
        logger.warning(f"Trip {transaction_id} not found for tripEnd")
        return

    # Calculate final duration
    start_time = trip.get("startTime")
    if isinstance(start_time, datetime):
        duration = (end_time - start_time).total_seconds()
    else:
        duration = trip.get("duration", 0.0)

    # Convert coordinates to GeoJSON for storage
    coordinates = trip.get("coordinates", [])
    gps = _coordinates_to_geojson(coordinates)

    # Update trip as completed
    update_fields = {
        "status": "completed",
        "endTime": end_time,
        "endTimeZone": end_data.get("timeZone", "UTC"),
        "endOdometer": end_data.get("odometer"),
        "fuelConsumed": end_data.get("fuelConsumed"),
        "duration": duration,
        "lastUpdate": end_time,
        "gps": gps,
    }

    # Keep coordinates for now, remove on cleanup
    updated_trip = await live_collection.find_one_and_update(
        {"transactionId": transaction_id},
        {"$set": update_fields},
        return_document=pymongo.ReturnDocument.AFTER,
    )

    if updated_trip:
        logger.info(
            f"Trip {transaction_id} completed: {duration:.0f}s, "
            f"{trip.get('distance', 0):.2f}mi"
        )
        await _publish_trip_snapshot(updated_trip, status="completed")


# ============================================================================
# Helper Functions
# ============================================================================


async def get_active_trip() -> dict[str, Any] | None:
    """Get the currently active trip."""
    if not live_trips_collection_global:
        logger.error("Live trips collection not initialized")
        return None

    try:
        trip = await live_trips_collection_global.find_one(
            {"status": "active"}, sort=[("lastUpdate", -1)]
        )
        return trip
    except Exception as e:
        logger.error(f"Error fetching active trip: {e}")
        return None


async def get_trip_updates(last_sequence: int = 0) -> dict[str, Any]:
    """Get updates for polling clients.

    Note: last_sequence is ignored in simplified version.
    Returns current active trip if exists.
    """
    trip = await get_active_trip()

    if trip:
        serialized = serialize_document(trip)
        return {
            "status": "success",
            "has_update": True,
            "trip": serialized,
        }
    else:
        return {
            "status": "success",
            "has_update": False,
            "message": "No active trip",
        }


async def cleanup_old_trips(live_collection: Collection, max_age_days: int = 30) -> int:
    """Remove completed trips older than max_age_days."""
    threshold = datetime.now(timezone.utc) - timedelta(days=max_age_days)

    result = await live_collection.delete_many(
        {"status": "completed", "endTime": {"$lt": threshold}}
    )

    count = result.deleted_count
    if count > 0:
        logger.info(f"Cleaned up {count} old completed trips")

    return count


async def cleanup_stale_trips_logic(
    live_collection: Collection,
    archive_collection: Collection,
    stale_minutes: int = 15,
    max_archive_age_days: int = 30,
) -> dict[str, int]:
    """Mark stale active trips as completed and cleanup old trips."""
    now = datetime.now(timezone.utc)
    stale_threshold = now - timedelta(minutes=stale_minutes)

    # Find stale active trips
    stale_trips = await live_collection.find(
        {"status": "active", "lastUpdate": {"$lt": stale_threshold}}
    ).to_list(length=100)

    stale_count = 0
    for trip in stale_trips:
        transaction_id = trip.get("transactionId")
        logger.warning(f"Marking stale trip as completed: {transaction_id}")

        # Convert to GeoJSON
        coordinates = trip.get("coordinates", [])
        gps = _coordinates_to_geojson(coordinates)

        await live_collection.update_one(
            {"transactionId": transaction_id},
            {
                "$set": {
                    "status": "completed",
                    "endTime": trip.get("lastUpdate"),
                    "closed_reason": "stale",
                    "gps": gps,
                }
            },
        )
        stale_count += 1

    # Cleanup old completed trips
    old_removed = await cleanup_old_trips(live_collection, max_archive_age_days)

    logger.info(f"Cleanup: {stale_count} stale trips, {old_removed} old trips removed")
    return {
        "stale_trips_archived": stale_count,
        "old_archives_removed": old_removed,
    }
