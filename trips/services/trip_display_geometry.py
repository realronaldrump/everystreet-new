"""Derived display geometry for historical trips.

This module is intentionally scoped to persisted historical trips. It never
mutates source GPS fields and is not used by live trip tracking.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise
from statistics import median
from typing import Any

from core.date_utils import get_current_utc_time, parse_timestamp
from core.spatial import (
    GeometryService,
    extract_line_sequences,
    sanitize_geojson_geometry,
)

DISPLAY_GEOMETRY_VERSION = 1

IMPOSSIBLE_SPIKE_SPEED_MPH = 180.0
SPLIT_SPEED_MPH = 220.0
PLAUSIBLE_BRIDGE_SPEED_MPH = 120.0
MIN_SPIKE_DISTANCE_MILES = 0.05
MIN_SPLIT_DISTANCE_MILES = 0.12
UNTIMED_JUMP_DISTANCE_MILES = 25.0
UNTIMED_JUMP_MULTIPLIER = 20.0

MAX_ENDPOINT_TRIM_POINTS = 8
MAX_ENDPOINT_TRIM_SECONDS = 5 * 60
STABLE_RUN_POINTS = 4


@dataclass(slots=True)
class _TimedPoint:
    coord: list[float]
    timestamp: float | None = None


@dataclass(frozen=True, slots=True)
class TripDisplayGeometryResult:
    geometry: dict[str, Any] | None
    status: str
    summary: dict[str, Any]
    version: int = DISPLAY_GEOMETRY_VERSION


def _point_count(geometry: dict[str, Any] | None) -> int:
    if not isinstance(geometry, dict):
        return 0
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if geom_type == "Point" and isinstance(coords, list):
        return 1
    if geom_type == "LineString" and isinstance(coords, list):
        return len(coords)
    if geom_type == "MultiLineString" and isinstance(coords, list):
        return sum(len(line) for line in coords if isinstance(line, list))
    return 0


def _distance_miles(a: _TimedPoint, b: _TimedPoint) -> float:
    return GeometryService.haversine_distance(
        a.coord[0],
        a.coord[1],
        b.coord[0],
        b.coord[1],
        unit="miles",
    )


def _speed_mph(a: _TimedPoint, b: _TimedPoint) -> float | None:
    if a.timestamp is None or b.timestamp is None:
        return None
    elapsed = abs(b.timestamp - a.timestamp)
    if elapsed <= 0:
        return None
    return _distance_miles(a, b) / (elapsed / 3600.0)


def _is_implausible_segment(
    a: _TimedPoint,
    b: _TimedPoint,
    *,
    speed_threshold_mph: float,
    min_distance_miles: float,
) -> bool:
    speed = _speed_mph(a, b)
    if speed is None:
        return False
    return speed > speed_threshold_mph and _distance_miles(a, b) >= min_distance_miles


def _normalize_coordinate_entries(value: Any) -> list[_TimedPoint]:
    if not isinstance(value, list):
        return []

    points: list[_TimedPoint] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        lat = item.get("lat")
        lon = item.get("lon")
        timestamp = parse_timestamp(item.get("timestamp"))
        is_valid, pair = GeometryService.validate_coordinate_pair([lon, lat])
        if not is_valid or pair is None:
            continue
        points.append(
            _TimedPoint(
                coord=pair,
                timestamp=timestamp.timestamp() if timestamp is not None else None,
            ),
        )
    return points


def _points_for_lines(
    lines: list[list[list[float]]],
    trip_doc: dict[str, Any],
) -> list[list[_TimedPoint]]:
    total_points = sum(len(line) for line in lines)
    coordinate_entries = _normalize_coordinate_entries(trip_doc.get("coordinates"))
    timestamps: list[float | None] = [None] * total_points

    if len(coordinate_entries) == total_points:
        timestamps = [entry.timestamp for entry in coordinate_entries]

    point_lines: list[list[_TimedPoint]] = []
    cursor = 0
    for line in lines:
        point_line: list[_TimedPoint] = []
        for coord in line:
            point_line.append(
                _TimedPoint(coord=list(coord), timestamp=timestamps[cursor])
            )
            cursor += 1
        point_lines.append(point_line)
    return point_lines


def _dedupe_adjacent(points: list[_TimedPoint]) -> tuple[list[_TimedPoint], int]:
    deduped: list[_TimedPoint] = []
    removed = 0
    for point in points:
        if deduped and deduped[-1].coord == point.coord:
            removed += 1
            continue
        deduped.append(point)
    return deduped, removed


def _remove_isolated_spikes(
    points: list[_TimedPoint],
) -> tuple[list[_TimedPoint], int]:
    if len(points) < 3:
        return points, 0

    cleaned: list[_TimedPoint] = []
    removed = 0
    for idx, point in enumerate(points):
        if idx == 0 or idx == len(points) - 1:
            cleaned.append(point)
            continue

        prev_point = points[idx - 1]
        next_point = points[idx + 1]
        into_spike = _is_implausible_segment(
            prev_point,
            point,
            speed_threshold_mph=IMPOSSIBLE_SPIKE_SPEED_MPH,
            min_distance_miles=MIN_SPIKE_DISTANCE_MILES,
        )
        out_of_spike = _is_implausible_segment(
            point,
            next_point,
            speed_threshold_mph=IMPOSSIBLE_SPIKE_SPEED_MPH,
            min_distance_miles=MIN_SPIKE_DISTANCE_MILES,
        )
        bridge_speed = _speed_mph(prev_point, next_point)
        bridge_plausible = (
            bridge_speed is not None and bridge_speed <= PLAUSIBLE_BRIDGE_SPEED_MPH
        )

        if into_spike and out_of_spike and bridge_plausible:
            removed += 1
            continue

        cleaned.append(point)

    return cleaned, removed


def _has_timestamps(points: list[_TimedPoint]) -> bool:
    return all(point.timestamp is not None for point in points)


def _has_stable_run(points: list[_TimedPoint], start_index: int) -> bool:
    if start_index < 0 or len(points) - start_index < STABLE_RUN_POINTS:
        return False
    stable_points = points[start_index : start_index + STABLE_RUN_POINTS]
    if not _has_timestamps(stable_points):
        return False
    for prev_point, current_point in pairwise(stable_points):
        if _is_implausible_segment(
            prev_point,
            current_point,
            speed_threshold_mph=SPLIT_SPEED_MPH,
            min_distance_miles=MIN_SPLIT_DISTANCE_MILES,
        ):
            return False
    return True


def _trim_start_endpoint(points: list[_TimedPoint]) -> tuple[list[_TimedPoint], int]:
    max_trim = min(
        MAX_ENDPOINT_TRIM_POINTS,
        max(0, len(points) - STABLE_RUN_POINTS),
    )
    if max_trim <= 0:
        return points, 0

    for trim_count in range(1, max_trim + 1):
        candidate_window = points[: trim_count + 1]
        if not _has_timestamps(candidate_window):
            return points, 0

        first_ts = candidate_window[0].timestamp
        last_ts = candidate_window[-1].timestamp
        if first_ts is None or last_ts is None:
            return points, 0
        if abs(last_ts - first_ts) > MAX_ENDPOINT_TRIM_SECONDS:
            return points, 0

        has_endpoint_noise = any(
            _is_implausible_segment(
                prev_point,
                current_point,
                speed_threshold_mph=IMPOSSIBLE_SPIKE_SPEED_MPH,
                min_distance_miles=MIN_SPIKE_DISTANCE_MILES,
            )
            for prev_point, current_point in pairwise(candidate_window)
        )
        if has_endpoint_noise and _has_stable_run(points, trim_count):
            return points[trim_count:], trim_count

    return points, 0


def _trim_end_endpoint(points: list[_TimedPoint]) -> tuple[list[_TimedPoint], int]:
    reversed_points = list(reversed(points))
    trimmed_reversed, trim_count = _trim_start_endpoint(reversed_points)
    if trim_count == 0:
        return points, 0
    return list(reversed(trimmed_reversed)), trim_count


def _calculate_untimed_threshold(points: list[_TimedPoint]) -> float:
    distances = [
        _distance_miles(prev_point, current_point)
        for prev_point, current_point in pairwise(points)
    ]
    if len(distances) < 2:
        return float("inf")
    typical = median(distances)
    return max(UNTIMED_JUMP_DISTANCE_MILES, typical * UNTIMED_JUMP_MULTIPLIER)


def _should_split_segment(
    prev_point: _TimedPoint,
    current_point: _TimedPoint,
    *,
    untimed_threshold_miles: float,
) -> bool:
    if _is_implausible_segment(
        prev_point,
        current_point,
        speed_threshold_mph=SPLIT_SPEED_MPH,
        min_distance_miles=MIN_SPLIT_DISTANCE_MILES,
    ):
        return True

    if prev_point.timestamp is None or current_point.timestamp is None:
        return _distance_miles(prev_point, current_point) > untimed_threshold_miles

    return False


def _split_implausible_jumps(
    points: list[_TimedPoint],
) -> tuple[list[list[_TimedPoint]], int, int]:
    if len(points) < 2:
        return ([points] if points else []), 0, 0

    untimed_threshold = _calculate_untimed_threshold(points)
    segments: list[list[_TimedPoint]] = []
    current_segment: list[_TimedPoint] = [points[0]]
    split_count = 0

    for prev_point, current_point in pairwise(points):
        if _should_split_segment(
            prev_point,
            current_point,
            untimed_threshold_miles=untimed_threshold,
        ):
            split_count += 1
            if len(current_segment) >= 2:
                segments.append(current_segment)
            current_segment = [current_point]
            continue
        current_segment.append(current_point)

    if len(current_segment) >= 2:
        segments.append(current_segment)

    retained_points = sum(len(segment) for segment in segments)
    dropped_singletons = max(0, len(points) - retained_points)
    return segments, split_count, dropped_singletons


def _max_implied_speed(points: list[_TimedPoint]) -> float | None:
    speeds = [
        speed
        for prev_point, current_point in pairwise(points)
        if (speed := _speed_mph(prev_point, current_point)) is not None
    ]
    return max(speeds) if speeds else None


def _build_geometry_from_segments(
    segments: list[list[_TimedPoint]],
) -> dict[str, Any] | None:
    valid_lines = [
        [point.coord for point in segment] for segment in segments if len(segment) >= 2
    ]
    if not valid_lines:
        return None
    if len(valid_lines) == 1:
        return {"type": "LineString", "coordinates": valid_lines[0]}
    return {"type": "MultiLineString", "coordinates": valid_lines}


def _result_for_non_line(
    geometry: dict[str, Any] | None,
) -> TripDisplayGeometryResult:
    raw_points = _point_count(geometry)
    status = "unchanged" if geometry else "no_geometry"
    return TripDisplayGeometryResult(
        geometry=geometry,
        status=status,
        summary={
            "raw_points": raw_points,
            "display_points": raw_points,
            "removed_points": 0,
            "split_count": 0,
            "max_implied_mph": None,
            "endpoint_trim_start": 0,
            "endpoint_trim_end": 0,
            "reasons": [],
            "version": DISPLAY_GEOMETRY_VERSION,
        },
    )


def derive_trip_display_geometry(
    trip_doc: dict[str, Any],
) -> TripDisplayGeometryResult:
    """Derive conservative display-only geometry for one historical trip."""
    source_geometry = sanitize_geojson_geometry(trip_doc.get("gps"))
    if not source_geometry or source_geometry.get("type") == "Point":
        return _result_for_non_line(source_geometry)

    lines = extract_line_sequences(source_geometry)
    if not lines:
        return _result_for_non_line(source_geometry)

    raw_points = sum(len(line) for line in lines)
    all_original_points: list[_TimedPoint] = []
    display_segments: list[list[_TimedPoint]] = []
    removed_points = 0
    split_count = 0
    start_trim_total = 0
    end_trim_total = 0
    reasons: list[str] = []

    for line_points in _points_for_lines(lines, trip_doc):
        all_original_points.extend(line_points)

        points, deduped_count = _dedupe_adjacent(line_points)
        if deduped_count:
            removed_points += deduped_count
            reasons.append("deduped_adjacent_points")

        points, spike_count = _remove_isolated_spikes(points)
        if spike_count:
            removed_points += spike_count
            reasons.append("removed_isolated_spikes")

        points, start_trim_count = _trim_start_endpoint(points)
        if start_trim_count:
            removed_points += start_trim_count
            start_trim_total += start_trim_count
            reasons.append("trimmed_noisy_start")

        points, end_trim_count = _trim_end_endpoint(points)
        if end_trim_count:
            removed_points += end_trim_count
            end_trim_total += end_trim_count
            reasons.append("trimmed_noisy_end")

        segments, line_split_count, dropped_singletons = _split_implausible_jumps(
            points
        )
        if line_split_count:
            split_count += line_split_count
            reasons.append("split_implausible_jumps")
        if dropped_singletons:
            removed_points += dropped_singletons
            reasons.append("dropped_single_point_split_segments")

        display_segments.extend(segments)

    geometry = _build_geometry_from_segments(display_segments)
    if geometry is None:
        geometry = source_geometry
        reasons.append("kept_source_geometry_no_safe_display_segments")

    display_points = _point_count(geometry)
    if removed_points or split_count or geometry != source_geometry:
        status = "cleaned"
    else:
        status = "unchanged"

    max_speed = _max_implied_speed(all_original_points)
    return TripDisplayGeometryResult(
        geometry=geometry,
        status=status,
        summary={
            "raw_points": raw_points,
            "display_points": display_points,
            "removed_points": removed_points,
            "split_count": split_count,
            "max_implied_mph": round(max_speed, 2) if max_speed is not None else None,
            "endpoint_trim_start": start_trim_total,
            "endpoint_trim_end": end_trim_total,
            "reasons": sorted(set(reasons)),
            "version": DISPLAY_GEOMETRY_VERSION,
        },
    )


def compute_trip_display_geometry_fields(trip_doc: dict[str, Any]) -> dict[str, Any]:
    """Return persisted display geometry fields for a historical trip document."""
    result = derive_trip_display_geometry(trip_doc)
    return {
        "displayGps": result.geometry,
        "displayGpsStatus": result.status,
        "displayGpsSummary": result.summary,
        "displayGpsVersion": result.version,
        "displayGpsUpdatedAt": get_current_utc_time(),
    }


__all__ = [
    "DISPLAY_GEOMETRY_VERSION",
    "TripDisplayGeometryResult",
    "compute_trip_display_geometry_fields",
    "derive_trip_display_geometry",
]
