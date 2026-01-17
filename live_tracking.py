"""
Live trip tracking for Bouncie webhook events.

Simplified single-user implementation for real-time trip visualization.
Trips are stored in the trips collection for unified live and historical
access.
"""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from date_utils import parse_timestamp
from db.models import Trip
from geometry_service import GeometryService
from trip_event_publisher import publish_trip_state

logger = logging.getLogger(__name__)


async def _publish_trip_snapshot(
    trip_doc: dict[str, Any] | Trip,
    status: str = "active",
) -> None:
    """Publish trip update to WebSocket clients via Redis."""
    trip_dict = trip_doc.model_dump() if isinstance(trip_doc, Trip) else dict(trip_doc)

    if "totalIdleDuration" not in trip_dict and "totalIdlingTime" in trip_dict:
        trip_dict["totalIdleDuration"] = trip_dict.get("totalIdlingTime")
    trip_dict.pop("totalIdlingTime", None)

    transaction_id = trip_dict.get("transactionId")
    if not transaction_id:
        logger.warning("Cannot publish trip without transactionId")
        return

    try:
        await publish_trip_state(transaction_id, trip_dict, status=status)
    except Exception:
        logger.exception("Failed to publish trip %s", transaction_id)


def _parse_timestamp(timestamp_str: str | None) -> datetime | None:
    """Parse ISO timestamp string to datetime."""
    if not timestamp_str:
        return None
    try:
        return parse_timestamp(timestamp_str)
    except Exception:
        return None


def _extract_coordinates_from_data(data_points: list[dict]) -> list[dict[str, Any]]:
    """
    Extract and normalize coordinates from Bouncie tripData payload.

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
                [lon, lat],
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
    """
    Merge and deduplicate coordinates by timestamp.

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
    return sorted(coords_map.values(), key=lambda c: c["timestamp"])


def _calculate_trip_metrics(
    coordinates: list[dict],
    start_time: datetime,
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
            prev["lon"],
            prev["lat"],
            curr["lon"],
            curr["lat"],
            unit="miles",
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
                prev["lon"],
                prev["lat"],
                curr["lon"],
                curr["lat"],
                unit="miles",
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
    existing_trip = await Trip.find_one(Trip.transactionId == transaction_id)
    if existing_trip and existing_trip.status in {"completed", "processed"}:
        logger.info(
            "Trip %s already completed, ignoring tripStart",
            transaction_id,
        )
        return

    if existing_trip:
        logger.info("Trip %s already exists, updating start data", transaction_id)
        trip = existing_trip
        trip.status = "active"
        if not trip.startTime:
            trip.startTime = start_time
        trip.startTimeZone = start_data.get(
            "timeZone",
            getattr(trip, "startTimeZone", None) or "UTC",
        )
        if start_data.get("odometer") is not None:
            trip.startOdometer = start_data.get("odometer")
        if not getattr(trip, "source", None):
            trip.source = "webhook"
        trip.lastUpdate = start_time
    else:
        trip = Trip(
            transactionId=transaction_id,
            vin=data.get("vin"),
            imei=data.get("imei"),
            status="active",
            startTime=start_time,
            startTimeZone=start_data.get("timeZone", "UTC"),
            startOdometer=start_data.get("odometer"),
            coordinates=[],
            distance=0.0,
            currentSpeed=0.0,
            maxSpeed=0.0,
            avgSpeed=0.0,
            duration=0.0,
            pointsRecorded=0,
            totalIdleDuration=0.0,
            hardBrakingCounts=0,
            hardAccelerationCounts=0,
            lastUpdate=start_time,
            source="webhook",
        )

    try:
        await trip.save()
    except Exception as save_err:
        if save_err.__class__.__name__ == "DuplicateKeyError":
            trip = await Trip.find_one(Trip.transactionId == transaction_id)
            if trip:
                trip.status = "active"
                trip.lastUpdate = start_time
                await trip.save()
        else:
            raise

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
    trip = await Trip.find_one(
        Trip.transactionId == transaction_id,
        Trip.status == "active",
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
    trip = await Trip.find_one(Trip.transactionId == transaction_id)

    if not trip:
        logger.info("Trip %s not found for tripMetrics", transaction_id)
        return

    # Update fields from Bouncie metrics
    updates_made = False

    avg_speed = metrics_data.get("averageDriveSpeed")
    if avg_speed is None:
        avg_speed = metrics_data.get("averageSpeed")
    if avg_speed is not None:
        trip.avgSpeed = float(avg_speed)
        updates_made = True

    idling_time = metrics_data.get("totalIdlingTime")
    if idling_time is None:
        idling_time = metrics_data.get("idlingTime")
    if idling_time is not None:
        trip.totalIdleDuration = float(idling_time)
        updates_made = True

    hard_braking = metrics_data.get("hardBrakingCounts")
    if hard_braking is None:
        hard_braking = metrics_data.get("hardBraking")
    if hard_braking is not None:
        trip.hardBrakingCounts = int(hard_braking)
        updates_made = True

    hard_acceleration = metrics_data.get("hardAccelerationCounts")
    if hard_acceleration is None:
        hard_acceleration = metrics_data.get("hardAcceleration")
    if hard_acceleration is not None:
        trip.hardAccelerationCounts = int(hard_acceleration)
        updates_made = True

    trip_distance = metrics_data.get("tripDistance")
    if trip_distance is not None:
        trip.distance = float(trip_distance)
        updates_made = True

    trip_time = metrics_data.get("tripTime")
    if trip_time is not None:
        trip.duration = float(trip_time)
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
    """Process tripEnd event - mark trip as completed."""
    transaction_id = data.get("transactionId")
    end_data = data.get("end", {})

    if not transaction_id or not end_data:
        logger.error("Invalid tripEnd payload: %s", data)
        return

    end_time = _parse_timestamp(end_data.get("timestamp"))
    if not end_time:
        end_time = datetime.now(UTC)
        logger.warning("Trip %s: Using current time for end", transaction_id)

    # Fetch trip
    trip = await Trip.find_one(Trip.transactionId == transaction_id)

    if not trip:
        logger.warning("Trip %s not found for tripEnd", transaction_id)
        return
    if trip.status == "processed":
        logger.info("Trip %s already processed, ignoring tripEnd", transaction_id)
        return

    # Calculate final duration
    start_time = trip.startTime
    if isinstance(start_time, datetime):
        duration = (end_time - start_time).total_seconds()
    else:
        duration = getattr(trip, "duration", 0.0)

    # Convert coordinates to GeoJSON for storage
    coordinates = getattr(trip, "coordinates", [])
    gps = (
        GeometryService.geometry_from_coordinate_dicts(coordinates)
        if coordinates
        else None
    )

    # Update trip as completed
    trip.status = "completed"
    trip.endTime = end_time
    trip.endTimeZone = end_data.get("timeZone", "UTC")
    trip.endOdometer = end_data.get("odometer")
    trip.fuelConsumed = end_data.get("fuelConsumed")
    trip.duration = duration
    trip.lastUpdate = end_time
    if gps:
        trip.gps = gps

    await trip.save()

    logger.info(
        "Trip %s completed: %.0fs, %.2fmi",
        transaction_id,
        duration,
        getattr(trip, "distance", 0),
    )
    await _publish_trip_snapshot(trip, status="completed")

    # Emit coverage event for automatic street coverage updates (only once)
    if not getattr(trip, "coverage_emitted_at", None) and getattr(trip, "gps", None):
        try:
            from street_coverage.events import emit_trip_completed

            trip_data = trip.model_dump()
            await emit_trip_completed(
                trip_id=str(trip.id),
                trip_data=trip_data,
            )
            trip.coverage_emitted_at = datetime.now(UTC)
            await trip.save()
        except Exception as coverage_err:
            logger.warning(
                "Failed to emit coverage event for trip %s: %s",
                transaction_id,
                coverage_err,
            )

    # Trigger targeted fetch in ARQ
    try:
        from tasks.ops import enqueue_task

        enqueue_result = await enqueue_task(
            "fetch_trip_by_transaction_id",
            transaction_id=transaction_id,
            trigger_source="trip_end",
            manual_run=False,
        )
        logger.info(
            "Triggered targeted fetch for trip %s (job_id: %s)",
            transaction_id,
            enqueue_result.get("job_id"),
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


async def get_active_trip() -> Trip | None:
    """Get the currently active trip."""
    try:
        return (
            await Trip.find(Trip.status == "active").sort("-lastUpdate").first_or_none()
        )
    except Exception:
        logger.exception("Error fetching active trip")
        return None


async def get_trip_updates(_last_sequence: int = 0) -> dict[str, Any]:
    """
    Get updates for polling clients.

    Note: last_sequence is ignored in simplified version.
    Returns current active trip if exists.
    """
    trip = await get_active_trip()

    if trip:
        return {
            "status": "success",
            "has_update": True,
            "trip": trip.model_dump(),
        }
    return {
        "status": "success",
        "has_update": False,
        "message": "No active trip",
    }


async def cleanup_old_trips(max_age_days: int = 30) -> int:
    """Retain completed trips in the unified trips collection."""
    logger.info(
        "Skipping cleanup of completed trips (retaining history, max_age_days=%d)",
        max_age_days,
    )
    return 0


async def cleanup_stale_trips_logic(
    stale_minutes: int = 15,
    max_archive_age_days: int = 30,
) -> dict[str, int]:
    """Mark stale active trips as completed and cleanup old trips."""
    now = datetime.now(UTC)
    stale_threshold = now - timedelta(minutes=stale_minutes)

    # Find stale active trips
    stale_trips = await Trip.find(
        Trip.status == "active",
        Trip.lastUpdate < stale_threshold,
    ).to_list(length=100)

    stale_count = 0
    for trip in stale_trips:
        transaction_id = trip.transactionId
        logger.warning("Marking stale trip as completed: %s", transaction_id)

        # Convert to GeoJSON
        coordinates = getattr(trip, "coordinates", [])
        gps = (
            GeometryService.geometry_from_coordinate_dicts(coordinates)
            if coordinates
            else None
        )

        trip.status = "completed"
        trip.endTime = trip.lastUpdate
        trip.closed_reason = "stale"
        if gps:
            trip.gps = gps

        await trip.save()
        stale_count += 1

    # Cleanup old completed trips
    old_removed = await cleanup_old_trips(max_archive_age_days)

    logger.info(
        "Cleanup: %d stale trips, %d old trips removed",
        stale_count,
        old_removed,
    )
    return {
        "stale_trips_archived": stale_count,
        "old_archives_removed": old_removed,
    }
