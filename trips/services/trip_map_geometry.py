"""Materialized full-detail map path metadata for historical trips."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from core.spatial import GeometryService, extract_line_sequences

TRIP_MAP_PATH_VERSION = 2
_POLYLINE6_SCALE = 1_000_000


def _quantize(value: float) -> int:
    return round(value * _POLYLINE6_SCALE)


def _encode_polyline_delta(value: int) -> str:
    value = ~(value << 1) if value < 0 else value << 1
    chunks: list[str] = []
    while value >= 0x20:
        chunks.append(chr((0x20 | (value & 0x1F)) + 63))
        value >>= 5
    chunks.append(chr(value + 63))
    return "".join(chunks)


def encode_polyline6(coords: list[list[float]]) -> str:
    """Encode `[lon, lat]` coordinates with polyline precision 6."""
    if not coords:
        return ""

    output: list[str] = []
    prev_lat = 0
    prev_lon = 0

    for lon, lat in coords:
        lat_i = _quantize(float(lat))
        lon_i = _quantize(float(lon))

        output.append(_encode_polyline_delta(lat_i - prev_lat))
        output.append(_encode_polyline_delta(lon_i - prev_lon))

        prev_lat = lat_i
        prev_lon = lon_i

    return "".join(output)


def _bbox_for_coords(coords: list[list[float]]) -> list[float]:
    lons = [float(point[0]) for point in coords]
    lats = [float(point[1]) for point in coords]
    return [min(lons), min(lats), max(lons), max(lats)]


def merge_bboxes(bboxes: list[list[float]]) -> list[float] | None:
    if not bboxes:
        return None
    return [
        min(b[0] for b in bboxes),
        min(b[1] for b in bboxes),
        max(b[2] for b in bboxes),
        max(b[3] for b in bboxes),
    ]


def _normalize_line(line: list[Any]) -> list[list[float]]:
    normalized: list[list[float]] = []
    for point in line:
        if not isinstance(point, list | tuple) or len(point) < 2:
            continue
        lon = float(point[0])
        lat = float(point[1])
        normalized.append([lon, lat])
    return normalized


def _listify_coordinates(value: Any) -> Any:
    if isinstance(value, tuple):
        return [_listify_coordinates(item) for item in value]
    if isinstance(value, list):
        return [_listify_coordinates(item) for item in value]
    if isinstance(value, dict):
        return {key: _listify_coordinates(item) for key, item in value.items()}
    return value


def build_encoded_path_metadata(
    geometry: dict[str, Any] | None,
    *,
    geometry_source: str,
) -> dict[str, Any] | None:
    """Build compact full-detail path metadata for one trip geometry."""
    normalized_geometry = (
        _listify_coordinates(geometry) if isinstance(geometry, dict) else geometry
    )
    parsed = GeometryService.parse_geojson(normalized_geometry)
    lines = extract_line_sequences(parsed)
    normalized_lines = [
        normalized for line in lines if len(normalized := _normalize_line(line)) >= 2
    ]
    if not normalized_lines:
        return None

    encoded_lines = [encode_polyline6(line) for line in normalized_lines]
    coords = [point for line in normalized_lines for point in line]
    if not coords:
        return None

    path: str | list[str]
    path = encoded_lines[0] if len(encoded_lines) == 1 else encoded_lines

    return {
        "version": TRIP_MAP_PATH_VERSION,
        "geometry_source": geometry_source,
        "path": path,
        "bbox": _bbox_for_coords(coords),
        "point_count": len(coords),
        "updated_at": datetime.now(UTC),
    }


def build_trip_map_path_fields(trip_doc: dict[str, Any]) -> dict[str, Any]:
    """Return materialized map-path fields for a historical trip document."""
    return {
        "displayMapPath": build_encoded_path_metadata(
            trip_doc.get("displayGps"),
            geometry_source="displayGps",
        ),
        "matchedMapPath": build_encoded_path_metadata(
            trip_doc.get("matchedGps"),
            geometry_source="matchedGps",
        ),
    }


def _metadata_equal(left: Any, right: Any) -> bool:
    if left is None or right is None:
        return left is right
    if not isinstance(left, dict) or not isinstance(right, dict):
        return left == right
    comparable_left = {key: value for key, value in left.items() if key != "updated_at"}
    comparable_right = {
        key: value for key, value in right.items() if key != "updated_at"
    }
    return comparable_left == comparable_right


def apply_trip_map_path_fields(trip: Any) -> bool:
    """Update a Trip-like object with materialized map path fields."""
    trip_doc = trip.model_dump() if hasattr(trip, "model_dump") else dict(trip)
    fields = build_trip_map_path_fields(trip_doc)
    changed = False
    for field, value in fields.items():
        if not _metadata_equal(getattr(trip, field, None), value):
            setattr(trip, field, value)
            changed = True
    return changed


def materialized_path_is_current(value: Any, *, geometry_source: str) -> bool:
    return (
        isinstance(value, dict)
        and value.get("version") == TRIP_MAP_PATH_VERSION
        and value.get("geometry_source") == geometry_source
        and bool(value.get("path"))
        and isinstance(value.get("bbox"), list)
        and len(value.get("bbox")) == 4
    )


__all__ = [
    "TRIP_MAP_PATH_VERSION",
    "apply_trip_map_path_fields",
    "build_encoded_path_metadata",
    "build_trip_map_path_fields",
    "encode_polyline6",
    "materialized_path_is_current",
    "merge_bboxes",
]
