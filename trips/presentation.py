"""Canonical trip presentation helpers shared by API and services."""

from __future__ import annotations

from typing import Any

from core.preview_path import build_line_preview_svg_path
from core.spatial import GeometryService
from trips.serialization import TripSerializer


def trip_to_dict(value: Any) -> dict[str, Any]:
    return TripSerializer.to_trip_dict(value)


def first_non_empty(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def derive_timezone_fields(trip_dict: dict[str, Any]) -> tuple[Any, Any, Any]:
    return TripSerializer.derive_timezone_fields(trip_dict)


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
    estimated_cost: float | None,
    points_recorded: int,
    include_matched_at: bool = False,
    coverage_distance_miles: float | None = None,
) -> dict[str, Any]:
    return TripSerializer.to_geojson_properties(
        trip_dict,
        estimated_cost=estimated_cost,
        points_recorded=points_recorded,
        include_matched_at=include_matched_at,
        coverage_distance_miles=coverage_distance_miles,
    )


__all__ = [
    "build_trip_feature_properties",
    "build_trip_preview_path",
    "count_line_points",
    "derive_timezone_fields",
    "extract_trip_preview_geometry",
    "first_non_empty",
    "trip_to_dict",
]
