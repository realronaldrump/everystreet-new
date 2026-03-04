"""Canonical trip presentation helpers shared by API and services."""

from __future__ import annotations

from typing import Any

from core.casting import safe_float
from core.date_utils import parse_timestamp
from core.preview_path import build_line_preview_svg_path
from core.serialization import serialize_datetime
from core.spatial import GeometryService


def trip_to_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    return dict(value)


def first_non_empty(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def derive_timezone_fields(trip_dict: dict[str, Any]) -> tuple[Any, Any, Any]:
    start_tz = first_non_empty(trip_dict.get("startTimeZone"))
    end_tz = first_non_empty(trip_dict.get("endTimeZone"))
    alias_tz = first_non_empty(start_tz, end_tz)
    return start_tz, end_tz, alias_tz


def count_line_points(geometry: dict[str, Any] | None) -> int:
    if not isinstance(geometry, dict):
        return 0

    geo_type = geometry.get("type")
    coords = geometry.get("coordinates")

    if geo_type == "LineString" and isinstance(coords, list):
        return len(coords)

    if geo_type == "MultiLineString" and isinstance(coords, list):
        return sum(len(line) for line in coords if isinstance(line, list))

    return 0


def extract_trip_preview_geometry(trip_dict: dict[str, Any]) -> dict[str, Any] | None:
    geom = GeometryService.parse_geojson(
        trip_dict.get("matchedGps") or trip_dict.get("gps"),
    )
    if geom:
        return geom

    coords = trip_dict.get("coordinates")
    if isinstance(coords, list):
        return GeometryService.geometry_from_coordinate_dicts(coords)

    return None


def build_trip_preview_path(trip_dict: dict[str, Any]) -> str | None:
    return build_line_preview_svg_path(extract_trip_preview_geometry(trip_dict))


def build_trip_feature_properties(
    trip_dict: dict[str, Any],
    *,
    estimated_cost: float | int | None,
    points_recorded: int,
    include_matched_at: bool = False,
    coverage_distance_miles: float | None = None,
) -> dict[str, Any]:
    start_dt = parse_timestamp(trip_dict.get("startTime"))
    end_dt = parse_timestamp(trip_dict.get("endTime"))
    duration = (end_dt - start_dt).total_seconds() if start_dt and end_dt else None
    start_tz, end_tz, alias_tz = derive_timezone_fields(trip_dict)

    props: dict[str, Any] = {
        "transactionId": trip_dict.get("transactionId"),
        "imei": trip_dict.get("imei"),
        "startTime": start_dt.isoformat() if start_dt else None,
        "endTime": end_dt.isoformat() if end_dt else None,
        "duration": duration,
        "distance": safe_float(trip_dict.get("distance"), 0),
        "maxSpeed": safe_float(trip_dict.get("maxSpeed"), 0),
        "startTimeZone": start_tz,
        "endTimeZone": end_tz,
        "timeZone": alias_tz,
        "startLocation": trip_dict.get("startLocation"),
        "destination": trip_dict.get("destination"),
        "totalIdleDuration": trip_dict.get("totalIdleDuration"),
        "fuelConsumed": safe_float(trip_dict.get("fuelConsumed"), 0),
        "source": trip_dict.get("source"),
        "hardBrakingCounts": trip_dict.get("hardBrakingCounts"),
        "hardAccelerationCounts": trip_dict.get("hardAccelerationCounts"),
        "startOdometer": trip_dict.get("startOdometer"),
        "endOdometer": trip_dict.get("endOdometer"),
        "avgSpeed": trip_dict.get("avgSpeed"),
        "pointsRecorded": points_recorded,
        "estimated_cost": safe_float(estimated_cost, 0),
        "matchStatus": trip_dict.get("matchStatus"),
    }
    if include_matched_at:
        props["matched_at"] = serialize_datetime(trip_dict.get("matched_at"))
    if coverage_distance_miles is not None:
        props["coverageDistance"] = coverage_distance_miles
    return props


__all__ = [
    "build_trip_feature_properties",
    "build_trip_preview_path",
    "count_line_points",
    "derive_timezone_fields",
    "extract_trip_preview_geometry",
    "first_non_empty",
    "trip_to_dict",
]
