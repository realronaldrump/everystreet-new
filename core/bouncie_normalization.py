"""Bouncie payload normalization helpers."""

from __future__ import annotations

import logging
from typing import Any

from core.date_utils import parse_timestamp
from core.spatial import GeometryService

logger = logging.getLogger(__name__)


def normalize_webhook_trip_data_points(
    data_points: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Normalize tripData points to canonical coordinate entries."""
    if not isinstance(data_points, list):
        return []
    normalized: list[dict[str, Any]] = []
    for point in data_points:
        if not isinstance(point, dict):
            continue
        timestamp = parse_timestamp(point.get("timestamp"))
        gps = point.get("gps") or {}
        if not isinstance(gps, dict):
            continue
        lat = gps.get("lat")
        lon = gps.get("lon")
        if timestamp is None or lat is None or lon is None:
            continue
        is_valid, pair = GeometryService.validate_coordinate_pair([lon, lat])
        if not is_valid or pair is None:
            continue
        entry: dict[str, Any] = {
            "timestamp": timestamp,
            "lat": pair[1],
            "lon": pair[0],
        }
        if point.get("speed") is not None:
            try:
                entry["speed"] = float(point["speed"])
            except (TypeError, ValueError):
                pass
        normalized.append(entry)
    return normalized


def normalize_existing_coordinates(
    coords: Any,
    *,
    validate_coords: bool = False,
) -> list[dict[str, Any]]:
    """Normalize stored coordinate entries with parsed timestamps."""
    if not isinstance(coords, list):
        return []

    normalized: list[dict[str, Any]] = []
    for item in coords:
        if not isinstance(item, dict):
            continue
        timestamp = item.get("timestamp")
        if isinstance(timestamp, str):
            timestamp = parse_timestamp(timestamp)
        if timestamp is None:
            continue

        lat = item.get("lat")
        lon = item.get("lon")
        if validate_coords:
            if lat is None or lon is None:
                continue
            is_valid, pair = GeometryService.validate_coordinate_pair([lon, lat])
            if not is_valid or pair is None:
                continue
            lat = pair[1]
            lon = pair[0]

        entry: dict[str, Any] = {
            "timestamp": timestamp,
            "lat": lat,
            "lon": lon,
        }
        if item.get("speed") is not None:
            try:
                entry["speed"] = float(item["speed"])
            except (TypeError, ValueError):
                pass
        normalized.append(entry)

    return normalized


def normalize_webhook_trip_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    """Normalize webhook tripMetrics payload into canonical fields."""
    normalized: dict[str, Any] = {}

    avg_speed = metrics.get("averageDriveSpeed")
    if avg_speed is not None:
        normalized["avgSpeed"] = float(avg_speed)

    idling_time = metrics.get("totalIdlingTime")
    if idling_time is not None:
        normalized["totalIdleDuration"] = float(idling_time)

    hard_braking = metrics.get("hardBrakingCounts")
    if hard_braking is not None:
        normalized["hardBrakingCounts"] = int(hard_braking)

    hard_acceleration = metrics.get("hardAccelerationCounts")
    if hard_acceleration is not None:
        normalized["hardAccelerationCounts"] = int(hard_acceleration)

    trip_distance = metrics.get("tripDistance")
    if trip_distance is not None:
        normalized["distance"] = float(trip_distance)

    trip_time = metrics.get("tripTime")
    if trip_time is not None:
        normalized["duration"] = float(trip_time)

    max_speed = metrics.get("maxSpeed")
    if max_speed is not None:
        normalized["maxSpeed"] = float(max_speed)

    metrics_timestamp = parse_timestamp(metrics.get("timestamp"))
    if metrics_timestamp:
        normalized["lastUpdate"] = metrics_timestamp

    return normalized


def _normalize_rest_gps(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None

    # Prefer GeoJSON parsing.
    geojson = GeometryService.parse_geojson(value)
    if geojson is not None:
        return geojson

    # If we received a list of coordinate pairs, try to build geometry.
    if isinstance(value, list):
        geometry = GeometryService.geometry_from_coordinate_pairs(value)
        if geometry is not None:
            return geometry

    logger.warning("Unsupported gps format from Bouncie REST payload")
    return None


def normalize_rest_trip_payload(trip: dict[str, Any]) -> dict[str, Any]:
    """Normalize REST /v1/trips payload into canonical trip fields."""
    normalized = dict(trip)

    if normalized.get("startTime") is not None:
        normalized["startTime"] = parse_timestamp(normalized.get("startTime"))
    if normalized.get("endTime") is not None:
        normalized["endTime"] = parse_timestamp(normalized.get("endTime"))

    if "averageSpeed" in normalized:
        try:
            normalized["avgSpeed"] = float(normalized.get("averageSpeed"))
        except (TypeError, ValueError):
            pass
    if "hardBrakingCount" in normalized:
        try:
            normalized["hardBrakingCounts"] = int(normalized.get("hardBrakingCount"))
        except (TypeError, ValueError):
            pass
    if "hardAccelerationCount" in normalized:
        try:
            normalized["hardAccelerationCounts"] = int(
                normalized.get("hardAccelerationCount"),
            )
        except (TypeError, ValueError):
            pass
    if "totalIdleDuration" in normalized:
        try:
            normalized["totalIdleDuration"] = float(normalized.get("totalIdleDuration"))
        except (TypeError, ValueError):
            pass

    gps = normalized.get("gps")
    normalized["gps"] = _normalize_rest_gps(gps)

    normalized["status"] = "processed"
    normalized["source"] = "bouncie"

    # Strip legacy keys to avoid propagating aliases.
    for key in (
        "averageSpeed",
        "hardBrakingCount",
        "hardAccelerationCount",
        "totalIdlingTime",
    ):
        normalized.pop(key, None)

    return normalized


__all__ = [
    "normalize_existing_coordinates",
    "normalize_rest_trip_payload",
    "normalize_webhook_trip_data_points",
    "normalize_webhook_trip_metrics",
]
