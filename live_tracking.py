"""Live trip tracking for Bouncie webhook events.

Simplified single-user implementation for real-time trip visualization.
Trips are stored in live_trips collection for visual reference only.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from date_utils import parse_timestamp
from db.models import ArchivedLiveTrip, LiveTrip
from geometry_service import GeometryService
from trip_event_publisher import publish_trip_state

logger = logging.getLogger(__name__)


async def _publish_trip_snapshot(
    trip_doc: dict[str, Any] | LiveTrip, status: str = "active"
) -> None:
    """Publish trip update to WebSocket clients via Redis."""
    trip_dict = trip_doc.model_dump() if isinstance(trip_doc, LiveTrip) else trip_doc

    transaction_id = trip_dict.get("transactionId")
    if not transaction_id:
        logger.warning("Cannot publish trip without transactionId")
        return

    try:
        await publish_trip_state(transaction_id, trip_dict, status=status)
    except Exception as e:
        logger.error("Failed to publish trip %s: %s", transaction_id, e)


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

    Uses centralized coordinate validation to ensure consistency.

    Returns list of dicts with keys: timestamp, lat, lon, speed (optional)
    """
    coords = []
    for point in data_points:
        timestamp = _parse_timestamp(point.get("timestamp"))
        gps = point.get("gps", {})
        lat = gps.get("lat")
        lon = gps.get("lon")

        if timestamp and lat is not None and lon is not None:
            # Use centralized validation for coordinate pairs
            is_valid, validated_coord = GeometryService.validate_coordinate_pair(
                [lon, lat]
            )
            if is_valid and validated_coord is not None:
                coord = {
                    "timestamp": timestamp,
                    "lat": validated_coord[1],  # lat is second element
                    "lon": validated_coord[0],  # lon is first element
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
            key = ts.isoformat() if isinstance(ts, datetime) else str(ts)
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

        segment_dist = GeometryService.haversine_distance(
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
            last_dist = GeometryService.haversine_distance(
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


# ============================================================================
# Event Handlers
# ============================================================================


async def process_trip_start(data: dict[str, Any]) -> None:
    """Process tripStart event - initialize new trip using Beanie."""
    transaction_id = data.get("transactionId")
    start_data = data.get("start", {})

    if not transaction_id or not start_data:
        logger.error("Invalid tripStart payload: %s", data)
        return

    start_time = _parse_timestamp(start_data.get("timestamp"))
    if not start_time:
        start_time = datetime.now(UTC)
        logger.warning("Trip %s: Using current time as fallback", transaction_id)

    # Check if trip already exists using Beanie
    existing_trip = await LiveTrip.find_one(LiveTrip.transactionId == transaction_id)
    if existing_trip:
        logger.info("Trip %s already exists, updating start data", transaction_id)
        trip = existing_trip
        trip.status = "active"
        trip.startTime = start_time
        # Update other fields if needed, but usually start is definitive
    else:
        trip = LiveTrip(
            transactionId=transaction_id,
            vin=data.get("vin"),
            imei=data.get("imei"),
            status="active",
            startTime=start_time,
            gps={"coordinates": []},  # Initialize empty gps
            # Add other fields as per model definition if needed
            # For now relying on extra='allow' in config or explicit fields
        )
        # Manually set extra fields not in model definition but used in logic
        # Since LiveTrip has extra="allow", we can set attributes dynamically
        # or use a dict if we were just using PyMongo. Beanie models support this
        # if configured.
        trip.startTimeZone = start_data.get("timeZone", "UTC")
        trip.startOdometer = start_data.get("odometer")
        trip.coordinates = []
        trip.distance = 0.0
        trip.currentSpeed = 0.0
        trip.maxSpeed = 0.0
        trip.avgSpeed = 0.0
        trip.duration = 0.0
        trip.pointsRecorded = 0
        trip.totalIdlingTime = 0.0
        trip.hardBrakingCounts = 0
        trip.hardAccelerationCounts = 0
        trip.lastUpdate = start_time

    await trip.save()

    logger.info("Trip %s started", transaction_id)
    await _publish_trip_snapshot(trip, status="active")


async def process_trip_data(data: dict[str, Any]) -> None:
    """Process tripData event - update coordinates and metrics."""
    transaction_id = data.get("transactionId")
    data_points = data.get("data", [])

    if not transaction_id or not data_points:
        logger.warning("Invalid tripData payload: %s", data)
        return

    # Fetch existing trip
    trip = await LiveTrip.find_one(
        LiveTrip.transactionId == transaction_id, LiveTrip.status == "active"
    )

    if not trip:
        logger.warning("Trip %s not found for tripData", transaction_id)
        return

    # Extract new coordinates
    new_coords = _extract_coordinates_from_data(data_points)
    if not new_coords:
        logger.debug("Trip %s: No valid coordinates in tripData", transaction_id)
        return

    # Merge with existing, deduplicate
    # Access extra fields via getattr/setattr or dict access if supported
    existing_coords = getattr(trip, "coordinates", [])
    all_coords = _deduplicate_coordinates(existing_coords, new_coords)

    # Calculate metrics
    start_time = trip.startTime
    if not isinstance(start_time, datetime):
        start_time = all_coords[0]["timestamp"]

    metrics = _calculate_trip_metrics(all_coords, start_time)

    # Update trip fields
    trip.coordinates = all_coords
    for key, value in metrics.items():
        setattr(trip, key, value)

    await trip.save()

    logger.info(
        "Trip %s updated: %d points, %.2fmi",
        transaction_id,
        len(all_coords),
        metrics["distance"],
    )
    await _publish_trip_snapshot(trip, status="active")


async def process_trip_metrics(data: dict[str, Any]) -> None:
    """Process tripMetrics event - update summary metrics from Bouncie."""
    transaction_id = data.get("transactionId")
    metrics_data = data.get("metrics", {})

    if not transaction_id or not metrics_data:
        logger.warning("Invalid tripMetrics payload: %s", data)
        return

    # Check if trip exists
    trip = await LiveTrip.find_one(
        LiveTrip.transactionId == transaction_id, LiveTrip.status == "active"
    )

    if not trip:
        logger.info(
            "Trip %s not found for tripMetrics (may be completed)",
            transaction_id,
        )
        return

    # Update fields from Bouncie metrics
    updates_made = False

    if "averageSpeed" in metrics_data:
        trip.avgSpeed = float(metrics_data["averageSpeed"])
        updates_made = True
    if "idlingTime" in metrics_data:
        trip.totalIdlingTime = float(metrics_data["idlingTime"])
        updates_made = True
    if "hardBraking" in metrics_data:
        trip.hardBrakingCounts = int(metrics_data["hardBraking"])
        updates_made = True
    if "hardAcceleration" in metrics_data:
        trip.hardAccelerationCounts = int(metrics_data["hardAcceleration"])
        updates_made = True

    # Update lastUpdate timestamp
    metrics_timestamp = _parse_timestamp(metrics_data.get("timestamp"))
    if metrics_timestamp:
        trip.lastUpdate = metrics_timestamp
        updates_made = True

    if "maxSpeed" in metrics_data:
        new_max = float(metrics_data["maxSpeed"])
        current_max = getattr(trip, "maxSpeed", 0.0) or 0.0
        if new_max > current_max:
            trip.maxSpeed = new_max
            updates_made = True

    if updates_made:
        await trip.save()
        logger.info("Trip %s metrics updated", transaction_id)
        await _publish_trip_snapshot(trip, status="active")


async def process_trip_end(data: dict[str, Any]) -> None:
    """Process tripEnd event - mark trip as completed and archive it."""
    transaction_id = data.get("transactionId")
    end_data = data.get("end", {})

    if not transaction_id or not end_data:
        logger.error("Invalid tripEnd payload: %s", data)
        return

    end_time = _parse_timestamp(end_data.get("timestamp"))
    if not end_time:
        end_time = datetime.now(UTC)
        logger.warning("Trip %s: Using current time for end", transaction_id)

    # Fetch active trip
    trip = await LiveTrip.find_one(
        LiveTrip.transactionId == transaction_id, LiveTrip.status == "active"
    )

    if not trip:
        logger.warning("Trip %s not found for tripEnd", transaction_id)
        return

    # Calculate final duration
    start_time = trip.startTime
    if isinstance(start_time, datetime):
        duration = (end_time - start_time).total_seconds()
    else:
        duration = getattr(trip, "duration", 0.0)

    # Convert coordinates to GeoJSON for storage
    coordinates = getattr(trip, "coordinates", [])
    gps = GeometryService.geometry_from_coordinate_dicts(coordinates)

    # Update trip as completed
    trip.status = "completed"
    trip.endTime = end_time
    trip.endTimeZone = end_data.get("timeZone", "UTC")
    trip.endOdometer = end_data.get("odometer")
    trip.fuelConsumed = end_data.get("fuelConsumed")
    trip.duration = duration
    trip.lastUpdate = end_time
    trip.gps = gps

    await trip.save()

    logger.info(
        "Trip %s completed: %.0fs, %.2fmi",
        transaction_id,
        duration,
        getattr(trip, "distance", 0),
    )
    await _publish_trip_snapshot(trip, status="completed")

    # Archive the trip
    try:
        # Create ArchivedLiveTrip from LiveTrip data
        trip_data = trip.model_dump()
        trip_data.pop(
            "_id", None
        )  # Remove _id to let new one be generated or use same?
        # ArchivedLiveTrip might have specific fields, let's map what we can
        # The model definition in models.py shows ArchivedLiveTrip has similar fields.

        # We can just construct it.
        archived_trip = ArchivedLiveTrip(
            transactionId=trip.transactionId,
            imei=trip.imei,
            status=trip.status,
            startTime=trip.startTime,
            endTime=trip.endTime,
            gps=trip.gps,
            archived_at=datetime.now(UTC),
        )
        # Copy extra fields
        for k, v in trip_data.items():
            if not hasattr(archived_trip, k):
                setattr(archived_trip, k, v)

        await archived_trip.save()

        # Delete from live
        await trip.delete()
        logger.info("Trip %s archived and removed from live", transaction_id)
    except Exception as archive_err:
        logger.error("Failed to archive trip %s: %s", transaction_id, archive_err)

    # Trigger periodic fetch
    try:
        from celery_app import app as celery_app

        celery_task_id = f"fetch_trip_{transaction_id}_{uuid.uuid4()}"

        fetch_start = start_time - timedelta(minutes=5) if start_time else None
        fetch_end = end_time + timedelta(minutes=5)

        task_kwargs = {"manual_run": False, "trigger_source": "trip_end"}

        if fetch_start and fetch_end:
            task_kwargs["start_time_iso"] = fetch_start.isoformat()
            task_kwargs["end_time_iso"] = fetch_end.isoformat()

        celery_app.send_task(
            "tasks.periodic_fetch_trips",
            kwargs=task_kwargs,
            task_id=celery_task_id,
            queue="default",
        )
        logger.info(
            "Triggered targeted fetch for trip %s (task_id: %s)",
            transaction_id,
            celery_task_id,
        )
    except Exception as trigger_err:
        logger.warning(
            "Failed to trigger fetch after trip %s ended: %s",
            transaction_id,
            trigger_err,
        )


# ============================================================================
# Helper Functions
# ============================================================================


async def get_active_trip() -> dict[str, Any] | None:
    """Get the currently active trip."""
    try:
        trip = (
            await LiveTrip.find(LiveTrip.status == "active")
            .sort("-lastUpdate")
            .first_or_none()
        )
        if trip:
            return trip.model_dump()
        return None
    except Exception as e:
        logger.error("Error fetching active trip: %s", e)
        return None


async def get_trip_updates(_last_sequence: int = 0) -> dict[str, Any]:
    """Get updates for polling clients.

    Note: last_sequence is ignored in simplified version.
    Returns current active trip if exists.
    """
    trip = await get_active_trip()

    if trip:
        return {
            "status": "success",
            "has_update": True,
            "trip": trip,
        }
    return {
        "status": "success",
        "has_update": False,
        "message": "No active trip",
    }


async def cleanup_old_trips(max_age_days: int = 30) -> int:
    """Remove completed trips older than max_age_days."""
    threshold = datetime.now(UTC) - timedelta(days=max_age_days)

    result = await LiveTrip.find(
        LiveTrip.status == "completed", LiveTrip.endTime < threshold
    ).delete()

    count = result.deleted_count
    if count > 0:
        logger.info("Cleaned up %d old completed trips", count)

    return count


async def cleanup_stale_trips_logic(
    stale_minutes: int = 15,
    max_archive_age_days: int = 30,
) -> dict[str, int]:
    """Mark stale active trips as completed and cleanup old trips."""
    now = datetime.now(UTC)
    stale_threshold = now - timedelta(minutes=stale_minutes)

    # Find stale active trips
    stale_trips = await LiveTrip.find(
        LiveTrip.status == "active", LiveTrip.lastUpdate < stale_threshold
    ).to_list(length=100)

    stale_count = 0
    for trip in stale_trips:
        transaction_id = trip.transactionId
        logger.warning("Marking stale trip as completed: %s", transaction_id)

        # Convert to GeoJSON
        coordinates = getattr(trip, "coordinates", [])
        gps = GeometryService.geometry_from_coordinate_dicts(coordinates)

        trip.status = "completed"
        trip.endTime = trip.lastUpdate
        trip.closed_reason = "stale"
        trip.gps = gps

        await trip.save()
        stale_count += 1

    # Cleanup old completed trips
    old_removed = await cleanup_old_trips(max_archive_age_days)

    logger.info(
        "Cleanup: %d stale trips, %d old trips removed", stale_count, old_removed
    )
    return {
        "stale_trips_archived": stale_count,
        "old_archives_removed": old_removed,
    }
