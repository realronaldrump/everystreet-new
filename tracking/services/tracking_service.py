"""
Live trip tracking for Bouncie webhook events.

Live trips are ephemeral and stored in Redis only. They are used for
real-time map display and are never persisted to the historical trips
collection.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from core.bouncie_normalization import (
    normalize_existing_coordinates,
    normalize_webhook_trip_data_points,
    normalize_webhook_trip_metrics,
)
from core.date_utils import parse_timestamp
from core.spatial import GeometryService
from db.models import BouncieCredentials
from tracking.services.live_trip_store import (
    clear_trip_snapshot,
    get_active_trip_snapshot,
    get_trip_snapshot,
    is_trip_marked_closed,
    live_trip_is_stale,
    save_trip_snapshot,
)
from trips.events import publish_trip_state

logger = logging.getLogger(__name__)

_STATUS_UPDATE_INTERVAL_SECONDS = 10
_last_seen_at: datetime | None = None
_last_seen_event_type: str | None = None
_last_saved_at: datetime | None = None


async def _publish_trip_snapshot(
    trip_doc: dict[str, Any],
    status: str = "active",
) -> None:
    """Publish trip update to WebSocket clients via Redis."""
    trip_dict = dict(trip_doc)

    transaction_id = trip_dict.get("transactionId")
    if not transaction_id:
        logger.warning("Cannot publish trip without transactionId")
        return

    try:
        await publish_trip_state(transaction_id, trip_dict, status=status)
    except Exception:
        logger.exception("Failed to publish trip %s", transaction_id)


def _parse_timestamp(timestamp_value: Any) -> datetime | None:
    """Parse timestamp values to timezone-aware datetimes."""
    if timestamp_value is None:
        return None
    try:
        return parse_timestamp(timestamp_value)
    except Exception:
        return None


def _extract_coordinates_from_data(data_points: list[dict]) -> list[dict[str, Any]]:
    """
    Extract and normalize coordinates from Bouncie tripData payload.

    Returns list of dicts with keys: timestamp, lat, lon, speed (optional)
    """
    return normalize_webhook_trip_data_points(data_points)


def _deduplicate_coordinates(
    existing: list[dict] | None,
    new: list[dict] | None,
) -> list[dict]:
    """
    Merge and deduplicate coordinates by timestamp.

    Bouncie sends duplicate data across real-time and periodic streams.
    Use timestamp as unique key, preferring newer data.
    """
    coords_map: dict[str, dict] = {}

    existing_coords = normalize_existing_coordinates(
        existing or [],
        validate_coords=True,
    )
    new_coords = normalize_existing_coordinates(new or [], validate_coords=True)

    for coord in existing_coords + new_coords:
        if isinstance(coord, dict) and isinstance(coord.get("timestamp"), datetime):
            ts: datetime = coord["timestamp"]
            key = ts.isoformat()
            coords_map[key] = coord

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

        time_diff = (curr["timestamp"] - prev["timestamp"]).total_seconds()
        if time_diff > 0:
            segment_speed = (segment_dist / time_diff) * 3600
            max_speed = max(max_speed, segment_speed)

    if coordinates[-1].get("speed") is not None:
        current_speed = coordinates[-1]["speed"]
    elif len(coordinates) > 1:
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
    """Process tripStart event - initialize or refresh ephemeral live trip state."""
    transaction_id = data.get("transactionId")
    start_data = data.get("start", {})

    if not transaction_id or not start_data:
        logger.error("Invalid tripStart payload: %s", data)
        return

    if await is_trip_marked_closed(transaction_id):
        logger.info("Trip %s already closed, ignoring tripStart", transaction_id)
        return

    start_time = _parse_timestamp(start_data.get("timestamp"))
    if not start_time:
        start_time = datetime.now(UTC)
        logger.warning("Trip %s: Using current time as default", transaction_id)

    trip = await get_trip_snapshot(transaction_id)
    if trip and trip.get("status") in {"completed", "processed"}:
        logger.info("Trip %s already finalized, ignoring tripStart", transaction_id)
        return

    if trip:
        logger.info("Trip %s already active, updating start data", transaction_id)
        trip["status"] = "active"
        trip.setdefault("startTime", start_time)
        trip["startTimeZone"] = start_data.get("timeZone", trip.get("startTimeZone") or "UTC")
        if start_data.get("odometer") is not None:
            trip["startOdometer"] = start_data.get("odometer")
        trip.setdefault("source", "webhook")
        trip["lastUpdate"] = start_time
    else:
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
            "totalIdleDuration": 0.0,
            "hardBrakingCounts": 0,
            "hardAccelerationCounts": 0,
            "lastUpdate": start_time,
            "source": "webhook",
        }

    await save_trip_snapshot(trip)
    logger.info("Trip %s started (ephemeral)", transaction_id)
    await _publish_trip_snapshot(trip, status="active")


async def process_trip_data(data: dict[str, Any]) -> None:
    """Process tripData event - update coordinates and metrics in ephemeral state."""
    transaction_id = data.get("transactionId")
    data_points = data.get("data", [])

    if not transaction_id or not data_points:
        logger.warning("Invalid tripData payload: %s", data)
        return

    if await is_trip_marked_closed(transaction_id):
        logger.info("Trip %s already closed, ignoring late tripData", transaction_id)
        return

    new_coords = _extract_coordinates_from_data(data_points)
    if not new_coords:
        logger.debug("Trip %s: No valid coordinates in tripData", transaction_id)
        return

    trip = await get_trip_snapshot(transaction_id)
    if not trip:
        inferred_start = new_coords[0]["timestamp"] if new_coords else datetime.now(UTC)
        trip = {
            "transactionId": transaction_id,
            "vin": data.get("vin"),
            "imei": data.get("imei"),
            "status": "active",
            "startTime": inferred_start,
            "startTimeZone": "UTC",
            "coordinates": [],
            "distance": 0.0,
            "currentSpeed": 0.0,
            "maxSpeed": 0.0,
            "avgSpeed": 0.0,
            "duration": 0.0,
            "pointsRecorded": 0,
            "totalIdleDuration": 0.0,
            "hardBrakingCounts": 0,
            "hardAccelerationCounts": 0,
            "source": "webhook",
        }

    if trip.get("status") in {"completed", "processed"}:
        logger.info("Trip %s already finalized, ignoring late tripData", transaction_id)
        return

    all_coords = _deduplicate_coordinates(trip.get("coordinates"), new_coords)

    start_time = _parse_timestamp(trip.get("startTime"))
    if not isinstance(start_time, datetime):
        start_time = all_coords[0]["timestamp"]

    metrics = _calculate_trip_metrics(all_coords, start_time)

    trip["status"] = "active"
    trip["coordinates"] = all_coords
    trip["startTime"] = trip.get("startTime") or start_time
    trip["startTimeZone"] = trip.get("startTimeZone") or "UTC"
    trip.setdefault("source", "webhook")
    for key, value in metrics.items():
        trip[key] = value

    await save_trip_snapshot(trip)

    logger.info(
        "Trip %s updated: %d points, %.2fmi",
        transaction_id,
        len(all_coords),
        metrics["distance"],
    )
    await _publish_trip_snapshot(trip, status="active")


async def process_trip_metrics(data: dict[str, Any]) -> None:
    """Process tripMetrics event - update summary metrics in ephemeral state."""
    transaction_id = data.get("transactionId")
    metrics_data = data.get("metrics", {})

    if not transaction_id or not metrics_data:
        logger.warning("Invalid tripMetrics payload: %s", data)
        return

    if await is_trip_marked_closed(transaction_id):
        logger.info("Trip %s already closed, ignoring late tripMetrics", transaction_id)
        return

    trip = await get_trip_snapshot(transaction_id)
    if not trip:
        logger.info("Trip %s not found for tripMetrics", transaction_id)
        return

    normalized = normalize_webhook_trip_metrics(metrics_data)
    if not normalized:
        return

    updates_made = False

    for key, value in normalized.items():
        if key == "maxSpeed":
            current_max = trip.get("maxSpeed", 0.0) or 0.0
            if value > current_max:
                trip["maxSpeed"] = value
                updates_made = True
            continue

        trip[key] = value
        updates_made = True

    if updates_made:
        await save_trip_snapshot(trip)
        logger.info("Trip %s metrics updated", transaction_id)
        await _publish_trip_snapshot(trip, status="active")


async def process_trip_end(data: dict[str, Any]) -> None:
    """Process tripEnd event - publish completion and clear ephemeral live state."""
    transaction_id = data.get("transactionId")
    end_data = data.get("end", {})

    if not transaction_id or not end_data:
        logger.error("Invalid tripEnd payload: %s", data)
        return

    if await is_trip_marked_closed(transaction_id):
        logger.info("Trip %s already closed, ignoring tripEnd", transaction_id)
        return

    end_time = _parse_timestamp(end_data.get("timestamp"))
    if not end_time:
        end_time = datetime.now(UTC)
        logger.warning("Trip %s: Using current time for end", transaction_id)

    trip = await get_trip_snapshot(transaction_id)
    if not trip:
        logger.warning("Trip %s not found for tripEnd", transaction_id)
        await clear_trip_snapshot(transaction_id, mark_closed=True)
        return

    if trip.get("status") == "processed":
        logger.info("Trip %s already processed, ignoring tripEnd", transaction_id)
        return

    start_time = _parse_timestamp(trip.get("startTime"))
    if isinstance(start_time, datetime):
        duration = (end_time - start_time).total_seconds()
    else:
        duration = float(trip.get("duration") or 0.0)

    coordinates = normalize_existing_coordinates(
        trip.get("coordinates") or [],
        validate_coords=True,
    )
    gps = (
        GeometryService.geometry_from_coordinate_dicts(coordinates)
        if coordinates
        else trip.get("gps")
    )

    trip["status"] = "completed"
    trip["endTime"] = end_time
    trip["endTimeZone"] = end_data.get("timeZone", "UTC")
    trip["endOdometer"] = end_data.get("odometer")
    trip["fuelConsumed"] = end_data.get("fuelConsumed")
    trip["duration"] = duration
    trip["lastUpdate"] = end_time
    if gps:
        trip["gps"] = gps

    logger.info(
        "Trip %s completed: %.0fs, %.2fmi",
        transaction_id,
        duration,
        float(trip.get("distance") or 0.0),
    )

    await _publish_trip_snapshot(trip, status="completed")
    await clear_trip_snapshot(transaction_id, mark_closed=True)


# ============================================================================
# Helper Functions
# ============================================================================


async def get_active_trip() -> dict[str, Any] | None:
    """Get the currently active live trip from ephemeral storage."""
    try:
        trip = await get_active_trip_snapshot()
        if not trip:
            return None

        transaction_id = str(trip.get("transactionId") or "").strip()
        if not transaction_id:
            return None

        if trip.get("status") == "completed":
            await clear_trip_snapshot(transaction_id, mark_closed=True)
            return None

        if live_trip_is_stale(trip):
            logger.warning(
                "Active trip %s is stale (>30m). Auto-completing.",
                transaction_id,
            )
            completed = dict(trip)
            completed["status"] = "completed"
            if not completed.get("endTime"):
                completed["endTime"] = completed.get("lastUpdate") or datetime.now(UTC)

            start_time = _parse_timestamp(completed.get("startTime"))
            end_time = _parse_timestamp(completed.get("endTime"))
            if isinstance(start_time, datetime) and isinstance(end_time, datetime):
                completed["duration"] = (end_time - start_time).total_seconds()

            coords = normalize_existing_coordinates(
                completed.get("coordinates") or [],
                validate_coords=True,
            )
            if coords and not completed.get("gps"):
                trip_gps = GeometryService.geometry_from_coordinate_dicts(coords)
                if trip_gps:
                    completed["gps"] = trip_gps

            await _publish_trip_snapshot(completed, status="completed")
            await clear_trip_snapshot(transaction_id, mark_closed=True)
            return None

        return trip
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
            "trip": trip,
        }
    return {
        "status": "success",
        "has_update": False,
        "message": "No active trip",
    }


async def record_webhook_event(event_type: str | None) -> None:
    """Record the latest webhook receipt for status reporting."""
    global _last_seen_at, _last_seen_event_type, _last_saved_at

    now = datetime.now(UTC)
    _last_seen_at = now
    _last_seen_event_type = event_type or None

    if _last_saved_at:
        delta = (now - _last_saved_at).total_seconds()
        if delta < _STATUS_UPDATE_INTERVAL_SECONDS:
            return

    try:
        creds = await BouncieCredentials.find_one(
            BouncieCredentials.id == "bouncie_credentials",
        )
        if not creds:
            creds = BouncieCredentials(id="bouncie_credentials")
            creds.last_webhook_at = now
            creds.last_webhook_event_type = _last_seen_event_type
            await creds.insert()
        else:
            creds.last_webhook_at = now
            creds.last_webhook_event_type = _last_seen_event_type
            await creds.save()
        _last_saved_at = now
    except Exception as exc:
        logger.debug("Failed to record Bouncie webhook status: %s", exc)


async def get_webhook_status() -> dict[str, Any]:
    """Return the latest webhook status snapshot."""
    last_seen_at = None
    event_type = None

    try:
        creds = await BouncieCredentials.find_one(
            BouncieCredentials.id == "bouncie_credentials",
        )
        if creds:
            last_seen_at = creds.last_webhook_at
            event_type = creds.last_webhook_event_type
    except Exception as exc:
        logger.debug("Failed to load Bouncie webhook status: %s", exc)

    if _last_seen_at and (not last_seen_at or _last_seen_at > last_seen_at):
        last_seen_at = _last_seen_at
        event_type = _last_seen_event_type

    return {
        "last_received": last_seen_at.isoformat() if last_seen_at else None,
        "event_type": event_type,
    }


class TrackingService:
    """Live tracking service facade."""

    @staticmethod
    async def get_active_trip() -> dict[str, Any] | None:
        return await get_active_trip()

    @staticmethod
    async def get_trip_updates() -> dict[str, Any]:
        return await get_trip_updates()

    @staticmethod
    async def process_trip_start(data: dict[str, Any]) -> None:
        await process_trip_start(data)

    @staticmethod
    async def process_trip_data(data: dict[str, Any]) -> None:
        await process_trip_data(data)

    @staticmethod
    async def process_trip_metrics(data: dict[str, Any]) -> None:
        await process_trip_metrics(data)

    @staticmethod
    async def process_trip_end(data: dict[str, Any]) -> None:
        await process_trip_end(data)

    @staticmethod
    async def record_webhook_event(event_type: str | None) -> None:
        await record_webhook_event(event_type)

    @staticmethod
    async def get_webhook_status() -> dict[str, Any]:
        return await get_webhook_status()


__all__ = [
    "TrackingService",
    "get_active_trip",
    "get_trip_updates",
    "get_webhook_status",
    "process_trip_data",
    "process_trip_end",
    "process_trip_metrics",
    "process_trip_start",
    "record_webhook_event",
]
