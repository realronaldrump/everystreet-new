"""
Recurring route builder.

Groups stored trips into stable route templates (RecurringRoute) and
assigns trips to their template via Trip.recurringRouteId.
"""

from __future__ import annotations

import logging
import math
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from pydantic import BaseModel, ConfigDict

from core.casting import safe_float
from core.jobs import JobHandle, create_job, find_job
from core.spatial import GeometryService, flatten_line_coordinates
from core.trip_query_spec import apply_trip_record_filters
from core.trip_source_policy import enforce_bouncie_source
from db.models import Job, Place, RecurringRoute, Trip
from recurring_routes.models import BuildRecurringRoutesRequest
from recurring_routes.services.fingerprint import (
    RouteFingerprint,
    build_preview_svg_path,
    compute_route_fingerprint,
    compute_route_key,
    extract_display_label,
    extract_polyline,
    extract_trip_geometry,
    grid_cell,
    lonlat_to_mercator_m,
    sample_waypoints,
)
from recurring_routes.services.service import coerce_place_id, find_place_id_for_point
from trips.services.trip_cost_service import TripCostService

logger = logging.getLogger(__name__)

TERMINAL_STAGES = {"completed", "failed", "error", "cancelled"}
_PLACE_LOOKUP_CELL_DEGREES = 0.005
_PLACE_LOOKUP_POINT_PADDING_M = 250.0
_PLACE_LOOKUP_MAX_INDEX_CELLS = 5000
_BULK_ASSIGNMENT_ROUTE_BATCH_SIZE = 20


class TripRouteBuildProjection(BaseModel):
    transactionId: str | None = None
    imei: str | None = None
    startTime: datetime | None = None
    endTime: datetime | None = None
    duration: float | None = None
    distance: float | None = None
    fuelConsumed: float | None = None
    maxSpeed: float | None = None

    matchedGps: dict[str, Any] | None = None
    gps: dict[str, Any] | None = None
    coordinates: list[dict[str, Any]] | None = None

    startGeoPoint: dict[str, Any] | None = None
    destinationGeoPoint: dict[str, Any] | None = None

    # Stored as "extra" fields on Trip documents; included here for labels.
    startPlaceId: str | None = None
    destinationPlaceId: str | None = None
    startLocation: Any | None = None
    destination: Any | None = None
    destinationPlaceName: str | None = None

    model_config = ConfigDict(extra="ignore")


def _median(values: list[float]) -> float | None:
    cleaned = [float(v) for v in values if isinstance(v, int | float)]
    if not cleaned:
        return None
    try:
        return float(statistics.median(cleaned))
    except statistics.StatisticsError:
        return None


def _avg(values: list[float]) -> float | None:
    cleaned = [float(v) for v in values if isinstance(v, int | float)]
    if not cleaned:
        return None
    return float(sum(cleaned) / len(cleaned))


def _best_label(counter: Counter[str]) -> str:
    if not counter:
        return "Unknown"
    value, _ = counter.most_common(1)[0]
    return value or "Unknown"


def _best_place_id(
    counter: Counter[str],
    place_name_by_id: dict[str, str],
) -> str | None:
    if not counter:
        return None
    for place_id, _count in counter.most_common():
        if place_id in place_name_by_id:
            return place_id
    return counter.most_common(1)[0][0]


def _extract_representative_geometry(
    trip_dict: dict[str, Any],
) -> dict[str, Any] | None:
    return extract_trip_geometry(trip_dict)


def _extract_start_end_points(
    trip_dict: dict[str, Any],
) -> tuple[list[float] | None, list[float] | None]:
    start_geo = trip_dict.get("startGeoPoint")
    dest_geo = trip_dict.get("destinationGeoPoint")
    start_pt = None
    end_pt = None

    if isinstance(start_geo, dict) and start_geo.get("type") == "Point":
        coords = start_geo.get("coordinates")
        valid, pair = GeometryService.validate_coordinate_pair(coords or [])
        if valid and pair:
            start_pt = pair

    if isinstance(dest_geo, dict) and dest_geo.get("type") == "Point":
        coords = dest_geo.get("coordinates")
        valid, pair = GeometryService.validate_coordinate_pair(coords or [])
        if valid and pair:
            end_pt = pair

    if start_pt is not None and end_pt is not None:
        return start_pt, end_pt

    poly = extract_polyline(trip_dict)
    if len(poly) >= 2:
        start_pt = start_pt or poly[0]
        end_pt = end_pt or poly[-1]

    return start_pt, end_pt


def _extract_labels(trip_dict: dict[str, Any]) -> tuple[str | None, str | None]:
    start_label = extract_display_label(trip_dict.get("startLocation"))

    end_label = None
    place_name = trip_dict.get("destinationPlaceName")
    if isinstance(place_name, str) and place_name.strip():
        end_label = place_name.strip()
    if end_label is None:
        end_label = extract_display_label(trip_dict.get("destination"))

    return start_label, end_label


def _param_float(params: dict[str, Any], key: str, default: float) -> float:
    value = params.get(key)
    if isinstance(value, int | float):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _param_int(params: dict[str, Any], key: str, default: int) -> int:
    value = params.get(key)
    if isinstance(value, int):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def _collect_geometry_points(value: Any) -> list[list[float]]:
    points: list[list[float]] = []

    def visit(node: Any) -> None:
        if not isinstance(node, list):
            return
        if len(node) >= 2 and isinstance(node[0], int | float) and isinstance(
            node[1],
            int | float,
        ):
            valid, pair = GeometryService.validate_coordinate_pair(node)
            if valid and pair:
                points.append(pair)
            return
        for child in node:
            visit(child)

    visit(value)
    return points


def _expand_bbox_lonlat(
    bbox: tuple[float, float, float, float],
    padding_m: float,
) -> tuple[float, float, float, float]:
    min_lon, min_lat, max_lon, max_lat = bbox
    center_lat = (min_lat + max_lat) / 2.0
    lat_delta = padding_m / 111_320.0
    lon_scale = max(0.001, abs(math.cos(math.radians(center_lat))))
    lon_delta = padding_m / (111_320.0 * lon_scale)
    return (
        min_lon - lon_delta,
        min_lat - lat_delta,
        max_lon + lon_delta,
        max_lat + lat_delta,
    )


def _place_geometry_bbox(place: Place) -> tuple[float, float, float, float] | None:
    geometry = place.geometry
    if not isinstance(geometry, dict):
        return None

    points = _collect_geometry_points(geometry.get("coordinates"))
    if not points:
        return None

    lons = [float(point[0]) for point in points]
    lats = [float(point[1]) for point in points]
    bbox = (min(lons), min(lats), max(lons), max(lats))
    if geometry.get("type") == "Point":
        return _expand_bbox_lonlat(bbox, _PLACE_LOOKUP_POINT_PADDING_M)
    return bbox


def _bbox_cell_range(
    bbox: tuple[float, float, float, float],
) -> tuple[range, range]:
    min_lon, min_lat, max_lon, max_lat = bbox
    cell = _PLACE_LOOKUP_CELL_DEGREES
    min_x = math.floor(min_lon / cell)
    max_x = math.floor(max_lon / cell)
    min_y = math.floor(min_lat / cell)
    max_y = math.floor(max_lat / cell)
    return range(min_x, max_x + 1), range(min_y, max_y + 1)


def _point_lookup_cell(point: list[float]) -> tuple[int, int]:
    return (
        math.floor(float(point[0]) / _PLACE_LOOKUP_CELL_DEGREES),
        math.floor(float(point[1]) / _PLACE_LOOKUP_CELL_DEGREES),
    )


@dataclass(frozen=True)
class _PlaceLookupCandidate:
    order: int
    place: Place


class _PlaceLookupIndex:
    """Spatial prefilter for place endpoint resolution.

    Matching still delegates to find_place_id_for_point, so this only reduces
    the candidate list and preserves the existing point/polygon semantics.
    """

    def __init__(self, places: list[Place]) -> None:
        self._candidates: list[_PlaceLookupCandidate] = []
        self._cell_candidates: dict[tuple[int, int], set[int]] = defaultdict(set)
        self._global_candidate_indices: set[int] = set()
        self._cache: dict[tuple[float, float], str | None] = {}

        for order, place in enumerate(places):
            if not place.id:
                continue
            candidate_idx = len(self._candidates)
            self._candidates.append(_PlaceLookupCandidate(order=order, place=place))

            bbox = _place_geometry_bbox(place)
            if bbox is None:
                self._global_candidate_indices.add(candidate_idx)
                continue

            x_range, y_range = _bbox_cell_range(bbox)
            cell_count = len(x_range) * len(y_range)
            if cell_count <= 0 or cell_count > _PLACE_LOOKUP_MAX_INDEX_CELLS:
                self._global_candidate_indices.add(candidate_idx)
                continue

            for x in x_range:
                for y in y_range:
                    self._cell_candidates[(x, y)].add(candidate_idx)

    def __bool__(self) -> bool:
        return bool(self._candidates)

    def find_place_id_for_point(self, point: Any) -> str | None:
        valid, pair = GeometryService.validate_coordinate_pair(
            point if isinstance(point, list | tuple) else [],
        )
        if not valid or not pair:
            return None

        cache_key = (float(pair[0]), float(pair[1]))
        if cache_key in self._cache:
            return self._cache[cache_key]

        candidate_indices = set(self._global_candidate_indices)
        candidate_indices.update(
            self._cell_candidates.get(_point_lookup_cell(pair), ()),
        )
        if not candidate_indices:
            self._cache[cache_key] = None
            return None

        candidates = [
            self._candidates[idx]
            for idx in sorted(
                candidate_indices,
                key=lambda idx: self._candidates[idx].order,
            )
        ]
        result = find_place_id_for_point(
            pair,
            [candidate.place for candidate in candidates],
        )
        self._cache[cache_key] = result
        return result


def _resolve_missing_endpoint_place_ids(
    trip_dict: dict[str, Any],
    place_lookup: _PlaceLookupIndex | None,
) -> None:
    """Fill missing endpoint place ids in-memory before fingerprinting."""
    if not place_lookup:
        return

    start_place_id = coerce_place_id(trip_dict.get("startPlaceId"))
    end_place_id = coerce_place_id(trip_dict.get("destinationPlaceId"))
    if start_place_id and end_place_id:
        return

    start_pt, end_pt = _extract_start_end_points(trip_dict)
    if not start_place_id and start_pt:
        resolved = place_lookup.find_place_id_for_point(start_pt)
        if resolved:
            trip_dict["startPlaceId"] = resolved
    if not end_place_id and end_pt:
        resolved = place_lookup.find_place_id_for_point(end_pt)
        if resolved:
            trip_dict["destinationPlaceId"] = resolved


def _group_trip_count(group: dict[str, Any]) -> int:
    return len(group.get("trip_ids") or [])


def _group_centroid(
    group: dict[str, Any],
    *,
    prefix: str,
) -> list[float] | None:
    count = int(group.get(f"{prefix}_count") or 0)
    if count <= 0:
        return None
    summed = group.get(f"{prefix}_sum")
    if not isinstance(summed, list) or len(summed) < 2:
        return None
    return [float(summed[0]) / count, float(summed[1]) / count]


def _point_distance_m(a: list[float] | None, b: list[float] | None) -> float | None:
    if not a or not b:
        return None
    try:
        return float(
            GeometryService.haversine_distance(
                float(a[0]),
                float(a[1]),
                float(b[0]),
                float(b[1]),
                unit="meters",
            ),
        )
    except Exception:
        return None


def _endpoint_compatible(
    left: dict[str, Any],
    right: dict[str, Any],
    *,
    prefix: str,
    tolerance_m: float,
) -> bool:
    field = "start_place_ids" if prefix == "start" else "end_place_ids"
    left_place = _best_place_id(left.get(field) or Counter(), {})
    right_place = _best_place_id(right.get(field) or Counter(), {})
    if left_place and right_place:
        return left_place == right_place

    left_pt = _group_centroid(left, prefix=prefix)
    right_pt = _group_centroid(right, prefix=prefix)
    distance = _point_distance_m(left_pt, right_pt)
    return distance is not None and distance <= tolerance_m


def _waypoint_cell_ratio(
    left: RouteFingerprint | None,
    right: RouteFingerprint | None,
    *,
    cell_tolerance: int,
) -> float:
    if left is None or right is None:
        return 0.0
    left_cells = list(left.waypoint_cells)
    right_cells = list(right.waypoint_cells)
    if not left_cells or len(left_cells) != len(right_cells):
        return 0.0

    slop = max(0, int(cell_tolerance))
    matches = 0
    for (lx, ly), (rx, ry) in zip(left_cells, right_cells, strict=True):
        if abs(lx - rx) <= slop and abs(ly - ry) <= slop:
            matches += 1
    return matches / len(left_cells)


def _geometry_sample_points(
    geometry: dict[str, Any] | None,
    *,
    waypoint_count: int,
) -> list[list[float]]:
    coords = flatten_line_coordinates(geometry)
    if len(coords) < 2:
        return []
    count = max(1, int(waypoint_count))
    return [coords[0], *sample_waypoints(coords, waypoint_count=count), coords[-1]]


def _geometry_distance_stats_m(
    left_geometry: dict[str, Any] | None,
    right_geometry: dict[str, Any] | None,
    *,
    waypoint_count: int,
) -> tuple[float, float] | None:
    left_points = _geometry_sample_points(
        left_geometry,
        waypoint_count=waypoint_count,
    )
    right_points = _geometry_sample_points(
        right_geometry,
        waypoint_count=waypoint_count,
    )
    if not left_points or len(left_points) != len(right_points):
        return None

    distances: list[float] = []
    for left_pt, right_pt in zip(left_points, right_points, strict=True):
        distance = _point_distance_m(left_pt, right_pt)
        if distance is None:
            return None
        distances.append(distance)
    return (sum(distances) / len(distances), max(distances))


def _distance_delta_ok(
    left: dict[str, Any],
    right: dict[str, Any],
    *,
    tolerance_miles: float,
) -> bool:
    left_med = _median(left.get("distances") or [])
    right_med = _median(right.get("distances") or [])
    if left_med is None or right_med is None:
        return True
    return abs(left_med - right_med) <= tolerance_miles


def _groups_are_mergeable(
    left: dict[str, Any],
    right: dict[str, Any],
    params: dict[str, Any],
) -> bool:
    endpoint_tolerance_m = max(
        1.0,
        _param_float(params, "endpoint_merge_tolerance_m", 250.0),
    )
    if not _endpoint_compatible(
        left,
        right,
        prefix="start",
        tolerance_m=endpoint_tolerance_m,
    ):
        return False
    if not _endpoint_compatible(
        left,
        right,
        prefix="end",
        tolerance_m=endpoint_tolerance_m,
    ):
        return False

    distance_tolerance_miles = max(
        0.0,
        _param_float(params, "distance_merge_tolerance_miles", 1.5),
    )
    if not _distance_delta_ok(
        left,
        right,
        tolerance_miles=distance_tolerance_miles,
    ):
        return False

    min_ratio = min(
        1.0,
        max(0.0, _param_float(params, "waypoint_merge_min_ratio", 0.75)),
    )
    cell_ratio = _waypoint_cell_ratio(
        left.get("fingerprint"),
        right.get("fingerprint"),
        cell_tolerance=_param_int(params, "waypoint_merge_cell_tolerance", 1),
    )
    if cell_ratio >= min_ratio:
        return True

    waypoint_count = max(1, _param_int(params, "waypoint_count", 4))
    stats = _geometry_distance_stats_m(
        left.get("rep_geometry"),
        right.get("rep_geometry"),
        waypoint_count=waypoint_count,
    )
    if stats is None:
        return False

    avg_m, max_m = stats
    waypoint_cell_m = max(1.0, _param_float(params, "waypoint_cell_size_m", 650.0))
    return avg_m <= waypoint_cell_m and max_m <= waypoint_cell_m * 2.5


def _merge_group(target: dict[str, Any], source: dict[str, Any]) -> None:
    target["trip_ids"].extend(source.get("trip_ids") or [])
    target["start_labels"].update(source.get("start_labels") or Counter())
    target["end_labels"].update(source.get("end_labels") or Counter())
    target["start_place_ids"].update(source.get("start_place_ids") or Counter())
    target["end_place_ids"].update(source.get("end_place_ids") or Counter())

    target["start_sum"][0] += source.get("start_sum", [0.0, 0.0])[0]
    target["start_sum"][1] += source.get("start_sum", [0.0, 0.0])[1]
    target["start_count"] += int(source.get("start_count") or 0)
    target["end_sum"][0] += source.get("end_sum", [0.0, 0.0])[0]
    target["end_sum"][1] += source.get("end_sum", [0.0, 0.0])[1]
    target["end_count"] += int(source.get("end_count") or 0)

    target["vehicle_imeis"].update(source.get("vehicle_imeis") or set())
    target["distances"].extend(source.get("distances") or [])
    target["durations"].extend(source.get("durations") or [])
    target["fuel"].extend(source.get("fuel") or [])
    target["costs"].extend(source.get("costs") or [])

    source_max_speed = source.get("max_speed_max")
    if isinstance(source_max_speed, int | float):
        target_max_speed = target.get("max_speed_max")
        target["max_speed_max"] = (
            float(source_max_speed)
            if target_max_speed is None
            else max(float(target_max_speed), float(source_max_speed))
        )

    source_first = source.get("first_start_time")
    if source_first and (
        target.get("first_start_time") is None
        or source_first < target.get("first_start_time")
    ):
        target["first_start_time"] = source_first

    source_last = source.get("last_start_time")
    if source_last and (
        target.get("last_start_time") is None
        or source_last > target.get("last_start_time")
    ):
        target["last_start_time"] = source_last

    source_rep_start = source.get("rep_start_time")
    target_rep_start = target.get("rep_start_time")
    if source_rep_start and (
        target_rep_start is None or source_rep_start > target_rep_start
    ):
        target["rep_trip_id"] = source.get("rep_trip_id")
        target["rep_start_time"] = source_rep_start
        target["rep_geometry"] = source.get("rep_geometry")
        target["rep_preview"] = source.get("rep_preview")

    target["merged_route_keys"].update(
        source.get("merged_route_keys") or {source.get("route_key")},
    )
    target["merged_signatures"].update(
        source.get("merged_signatures") or {source.get("route_signature")},
    )


def _point_to_cell(
    point: list[float] | None, cell_size_m: float
) -> tuple[int, int] | None:
    if not point:
        return None
    try:
        x_m, y_m = lonlat_to_mercator_m(point[0], point[1])
        return grid_cell(x_m, y_m, cell_size_m)
    except Exception:
        return None


def _endpoint_key_options(
    place_id: str | None,
    cell: tuple[int, int] | None,
) -> list[str]:
    keys: list[str] = []
    if place_id:
        keys.append(f"p:{place_id}")
    if cell:
        x, y = cell
        keys.extend(
            f"c:{x + dx}:{y + dy}"
            for dx in range(-1, 2)
            for dy in range(-1, 2)
        )
    return keys or ["unknown"]


def _group_index_keys(group: dict[str, Any], params: dict[str, Any]) -> list[str]:
    fingerprint: RouteFingerprint | None = group.get("fingerprint")
    cell_size_m = max(1.0, _param_float(params, "start_end_cell_size_m", 200.0))
    start_place_id = _best_place_id(group.get("start_place_ids") or Counter(), {})
    end_place_id = _best_place_id(group.get("end_place_ids") or Counter(), {})
    start_cell = fingerprint.start_cell if fingerprint else None
    end_cell = fingerprint.end_cell if fingerprint else None
    start_cell = start_cell or _point_to_cell(
        _group_centroid(group, prefix="start"), cell_size_m
    )
    end_cell = end_cell or _point_to_cell(
        _group_centroid(group, prefix="end"), cell_size_m
    )

    return [
        f"s:{start_key}|e:{end_key}"
        for start_key in _endpoint_key_options(start_place_id, start_cell)
        for end_key in _endpoint_key_options(end_place_id, end_cell)
    ]


def _merge_similar_groups(
    groups: dict[str, dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    ordered = sorted(
        groups.values(),
        key=lambda group: (
            -_group_trip_count(group),
            str(group.get("route_key") or ""),
        ),
    )
    merged: list[dict[str, Any]] = []
    index: dict[str, list[int]] = {}

    for group in ordered:
        candidate_indices: set[int] = set()
        for index_key in _group_index_keys(group, params):
            candidate_indices.update(index.get(index_key, []))

        best_idx: int | None = None
        best_count = -1
        for candidate_idx in candidate_indices:
            candidate = merged[candidate_idx]
            if not _groups_are_mergeable(candidate, group, params):
                continue
            candidate_count = _group_trip_count(candidate)
            if candidate_count > best_count:
                best_idx = candidate_idx
                best_count = candidate_count

        if best_idx is None:
            merged.append(group)
            group_idx = len(merged) - 1
            for index_key in _group_index_keys(group, params):
                index.setdefault(index_key, []).append(group_idx)
            continue

        target = merged[best_idx]
        old_index_keys = set(_group_index_keys(target, params))
        _merge_group(target, group)
        for index_key in set(_group_index_keys(target, params)) - old_index_keys:
            index.setdefault(index_key, []).append(best_idx)

    return {str(group["route_key"]): group for group in merged}


def _route_endpoint_compatible(
    group: dict[str, Any],
    route: RecurringRoute,
    *,
    prefix: str,
    tolerance_m: float,
) -> bool:
    field = "start_place_ids" if prefix == "start" else "end_place_ids"
    route_place_id = (
        coerce_place_id(route.start_place_id)
        if prefix == "start"
        else coerce_place_id(route.end_place_id)
    )
    group_place_id = _best_place_id(group.get(field) or Counter(), {})
    if route_place_id and group_place_id:
        return route_place_id == group_place_id

    route_centroid = route.start_centroid if prefix == "start" else route.end_centroid
    group_centroid = _group_centroid(group, prefix=prefix)
    distance = _point_distance_m(route_centroid, group_centroid)
    return distance is not None and distance <= tolerance_m


def _route_candidate_score(
    group: dict[str, Any],
    route: RecurringRoute,
    params: dict[str, Any],
) -> float | None:
    endpoint_tolerance_m = max(
        1.0,
        _param_float(params, "route_identity_match_tolerance_m", 750.0),
    )
    if not _route_endpoint_compatible(
        group,
        route,
        prefix="start",
        tolerance_m=endpoint_tolerance_m,
    ):
        return None
    if not _route_endpoint_compatible(
        group,
        route,
        prefix="end",
        tolerance_m=endpoint_tolerance_m,
    ):
        return None

    distance_tolerance_miles = max(
        0.0,
        _param_float(params, "distance_merge_tolerance_miles", 1.5),
    )
    group_distance = _median(group.get("distances") or [])
    route_distance = route.distance_miles_median or route.distance_miles_avg
    if (
        group_distance is not None
        and isinstance(route_distance, int | float)
        and abs(group_distance - float(route_distance)) > distance_tolerance_miles
    ):
        return None

    waypoint_count = max(1, _param_int(params, "waypoint_count", 4))
    stats = _geometry_distance_stats_m(
        group.get("rep_geometry"),
        route.geometry,
        waypoint_count=waypoint_count,
    )
    if stats is None:
        has_group_places = bool(group.get("start_place_ids")) and bool(
            group.get("end_place_ids"),
        )
        has_route_places = bool(route.start_place_id) and bool(route.end_place_id)
        return 25.0 if has_group_places and has_route_places else None

    avg_m, max_m = stats
    if avg_m > endpoint_tolerance_m or max_m > endpoint_tolerance_m * 2.5:
        return None
    return 100.0 - min(90.0, avg_m / 10.0)


def _find_route_identity_candidate(
    group: dict[str, Any],
    routes: list[RecurringRoute],
    *,
    used_route_ids: set[PydanticObjectId],
    params: dict[str, Any],
    current_keys: set[str],
) -> RecurringRoute | None:
    best_route: RecurringRoute | None = None
    best_score: float | None = None
    for route in routes:
        if route.id is None or route.id in used_route_ids:
            continue
        if route.route_key in current_keys:
            continue
        score = _route_candidate_score(group, route, params)
        if score is None:
            continue
        if best_score is None or score > best_score:
            best_route = route
            best_score = score
    return best_route


async def _job_cancelled(job: Job | None) -> bool:
    if not job or not job.id:
        return False
    refreshed = await Job.get(job.id)
    if not refreshed:
        return False
    stage = (refreshed.stage or "").lower()
    status = (refreshed.status or "").lower()
    return stage == "cancelled" or status == "cancelled"


async def _sequential_update_many(
    collection: Any,
    updates: list[tuple[dict[str, Any], dict[str, Any]]],
) -> int:
    modified = 0
    for filter_doc, update_doc in updates:
        result = await collection.update_many(filter_doc, update_doc)
        modified += int(getattr(result, "modified_count", 0) or 0)
    return modified


async def _bulk_update_many(
    collection: Any,
    updates: list[tuple[dict[str, Any], dict[str, Any]]],
) -> int:
    if not updates:
        return 0

    try:
        from pymongo import UpdateMany
    except Exception:
        return await _sequential_update_many(collection, updates)

    operations = [
        UpdateMany(filter_doc, update_doc) for filter_doc, update_doc in updates
    ]
    try:
        result = await collection.bulk_write(operations, ordered=False)
    except TypeError as exc:
        if "unexpected keyword argument 'sort'" not in str(exc):
            raise
        return await _sequential_update_many(collection, updates)
    except NotImplementedError:
        return await _sequential_update_many(collection, updates)

    return int(getattr(result, "modified_count", 0) or 0)


class RecurringRoutesBuilder:
    """Build RecurringRoute templates and assign trips."""

    async def _get_or_create_progress(self, job_id: str) -> Job:
        progress = await find_job("recurring_routes_build", operation_id=job_id)
        if progress:
            return progress
        # Defensive: create progress record if API didn't create one.
        progress_handle = await create_job(
            "recurring_routes_build",
            operation_id=job_id,
            task_id=job_id,
            status="queued",
            stage="queued",
            progress=0.0,
            message="Queued recurring routes build",
            started_at=datetime.now(UTC),
            metadata={},
        )
        return progress_handle.job

    async def run(
        self,
        job_id: str,
        request: BuildRecurringRoutesRequest,
    ) -> dict[str, Any]:
        params = request.model_dump()
        now = datetime.now(UTC)

        progress = await self._get_or_create_progress(job_id)
        handle = JobHandle(progress)

        await handle.update(
            status="running",
            stage="scanning",
            progress=0.0,
            message="Preparing to build recurring routes...",
            started_at=progress.started_at or now,
            metadata_patch={"params": params},
        )

        try:
            # Compute total upfront for progress; avoids a second scan later.
            query = enforce_bouncie_source(
                apply_trip_record_filters(
                    {"invalid": {"$ne": True}},
                    include_invalid=True,
                )
            )
            total_trips = await Trip.find(query).count()

            await handle.update(
                stage="fingerprinting",
                message=(
                    "Loading gas price history and fingerprinting "
                    f"{total_trips} trips..."
                ),
                metadata_patch={"total_trips": total_trips},
            )

            # Load gas fill-ups once for cost estimation.
            price_map = await TripCostService.get_fillup_price_map()
            place_lookup = _PlaceLookupIndex(await Place.find_all().to_list())

            # route_key -> aggregation
            groups: dict[str, dict[str, Any]] = {}
            all_place_ids: set[str] = set()

            processed = 0
            usable = 0

            # Iterate trips using a minimal projection.
            cursor = Trip.find(query).project(TripRouteBuildProjection)
            async for trip in cursor:
                processed += 1
                if processed % 300 == 0 and await _job_cancelled(progress):
                    await handle.update(
                        status="cancelled",
                        stage="cancelled",
                        progress=0.0,
                        message="Cancelled",
                        completed_at=datetime.now(UTC),
                    )
                    return {
                        "status": "cancelled",
                        "processed": processed,
                        "usable": usable,
                    }

                trip_dict = trip.model_dump()
                _resolve_missing_endpoint_place_ids(trip_dict, place_lookup)
                fingerprint = compute_route_fingerprint(trip_dict, params)
                if not fingerprint:
                    continue
                signature = fingerprint.signature
                route_key = compute_route_key(signature)

                transaction_id = (trip_dict.get("transactionId") or "").strip()
                if not transaction_id:
                    continue

                usable += 1
                group = groups.get(route_key)
                if group is None:
                    group = {
                        "route_key": route_key,
                        "route_signature": signature,
                        "trip_ids": [],
                        "start_labels": Counter(),
                        "end_labels": Counter(),
                        "start_place_ids": Counter(),
                        "end_place_ids": Counter(),
                        "start_sum": [0.0, 0.0],
                        "start_count": 0,
                        "end_sum": [0.0, 0.0],
                        "end_count": 0,
                        "vehicle_imeis": set(),
                        "distances": [],
                        "durations": [],
                        "fuel": [],
                        "costs": [],
                        "max_speed_max": None,
                        "first_start_time": None,
                        "last_start_time": None,
                        "rep_trip_id": None,
                        "rep_start_time": None,
                        "rep_geometry": None,
                        "rep_preview": None,
                        "fingerprint": fingerprint,
                        "merged_route_keys": {route_key},
                        "merged_signatures": {signature},
                    }
                    groups[route_key] = group

                group["trip_ids"].append(transaction_id)

                imei = trip_dict.get("imei")
                if isinstance(imei, str) and imei.strip():
                    group["vehicle_imeis"].add(imei.strip())

                start_label, end_label = _extract_labels(trip_dict)
                if start_label:
                    group["start_labels"][start_label] += 1
                if end_label:
                    group["end_labels"][end_label] += 1

                start_place_id = coerce_place_id(trip_dict.get("startPlaceId"))
                end_place_id = coerce_place_id(trip_dict.get("destinationPlaceId"))
                if start_place_id:
                    group["start_place_ids"][start_place_id] += 1
                    all_place_ids.add(start_place_id)
                if end_place_id:
                    group["end_place_ids"][end_place_id] += 1
                    all_place_ids.add(end_place_id)

                start_pt, end_pt = _extract_start_end_points(trip_dict)
                if start_pt:
                    group["start_sum"][0] += float(start_pt[0])
                    group["start_sum"][1] += float(start_pt[1])
                    group["start_count"] += 1
                if end_pt:
                    group["end_sum"][0] += float(end_pt[0])
                    group["end_sum"][1] += float(end_pt[1])
                    group["end_count"] += 1

                dist = trip_dict.get("distance")
                if isinstance(dist, int | float) and dist >= 0:
                    group["distances"].append(float(dist))

                duration = trip_dict.get("duration")
                if isinstance(duration, int | float) and duration >= 0:
                    group["durations"].append(float(duration))
                else:
                    st = trip_dict.get("startTime")
                    et = trip_dict.get("endTime")
                    if st and et:
                        try:
                            delta = (et - st).total_seconds()
                            if delta >= 0:
                                group["durations"].append(float(delta))
                        except Exception:
                            pass

                fuel = trip_dict.get("fuelConsumed")
                if isinstance(fuel, int | float) and fuel > 0:
                    group["fuel"].append(float(fuel))
                    if isinstance(imei, str) and imei in price_map:
                        trip_cost = TripCostService.calculate_trip_cost(
                            trip_dict,
                            price_map,
                        )
                        if isinstance(trip_cost, int | float) and trip_cost > 0:
                            group["costs"].append(float(trip_cost))

                max_speed = trip_dict.get("maxSpeed")
                if isinstance(max_speed, int | float) and max_speed >= 0:
                    prev = group.get("max_speed_max")
                    group["max_speed_max"] = (
                        float(max_speed)
                        if prev is None
                        else max(prev, float(max_speed))
                    )

                st = trip_dict.get("startTime")
                if isinstance(st, datetime):
                    if (
                        group["first_start_time"] is None
                        or st < group["first_start_time"]
                    ):
                        group["first_start_time"] = st
                    if (
                        group["last_start_time"] is None
                        or st > group["last_start_time"]
                    ):
                        group["last_start_time"] = st

                # Representative trip: most recent trip with a usable geometry.
                rep_start = group.get("rep_start_time")
                if isinstance(st, datetime) and (rep_start is None or st > rep_start):
                    rep_geom = _extract_representative_geometry(trip_dict)
                    if rep_geom:
                        group["rep_trip_id"] = transaction_id
                        group["rep_start_time"] = st
                        group["rep_geometry"] = rep_geom
                        group["rep_preview"] = None

                if total_trips > 0 and processed % 250 == 0:
                    pct = min(60.0, (processed / total_trips) * 60.0)
                    await handle.update(
                        progress=pct,
                        message=f"Fingerprinting trips... ({processed}/{total_trips})",
                        metadata_patch={
                            "processed_trips": processed,
                            "usable_trips": usable,
                        },
                    )

            exact_group_count = len(groups)
            groups = _merge_similar_groups(groups, params)
            merged_group_count = len(groups)

            await handle.update(
                stage="grouping",
                progress=60.0,
                message=(
                    "Grouping trips into routes... "
                    f"({merged_group_count} candidates from "
                    f"{exact_group_count} fingerprints)"
                ),
                metadata_patch={
                    "exact_groups": exact_group_count,
                    "groups": merged_group_count,
                    "merged_groups": max(0, exact_group_count - merged_group_count),
                },
            )

            min_assign = max(1, int(params.get("min_assign_trips") or 2))
            min_recurring = max(1, int(params.get("min_recurring_trips") or 3))

            place_name_by_id: dict[str, str] = {}
            if all_place_ids:
                place_oids: list[PydanticObjectId] = []
                for place_id in all_place_ids:
                    try:
                        place_oids.append(PydanticObjectId(place_id))
                    except Exception:
                        continue
                if place_oids:
                    places = await Place.find({"_id": {"$in": place_oids}}).to_list()
                    place_name_by_id = {
                        str(place.id): (place.name or "").strip()
                        for place in places
                        if place.id is not None and (place.name or "").strip()
                    }

            eligible_keys = [
                k
                for k, g in groups.items()
                if len(g.get("trip_ids") or []) >= min_assign
            ]
            eligible_key_set = set(eligible_keys)

            await handle.update(
                stage="upserting_routes",
                progress=60.0,
                message=f"Upserting {len(eligible_keys)} route templates...",
                metadata_patch={"eligible_routes": len(eligible_keys)},
            )

            all_existing_routes = (
                await RecurringRoute.find({}).to_list() if eligible_keys else []
            )
            existing_by_key = {
                r.route_key: r
                for r in all_existing_routes
                if r.route_key in eligible_key_set
            }

            seen_keys: set[str] = set()
            route_id_by_key: dict[str, Any] = {}
            used_route_ids: set[PydanticObjectId] = set()

            created = 0
            updated = 0

            for idx, key in enumerate(eligible_keys, 1):
                if idx % 25 == 0 and await _job_cancelled(progress):
                    await handle.update(
                        status="cancelled",
                        stage="cancelled",
                        progress=0.0,
                        message="Cancelled",
                        completed_at=datetime.now(UTC),
                    )
                    return {
                        "status": "cancelled",
                        "processed": processed,
                        "usable": usable,
                    }

                group = groups[key]
                trip_ids: list[str] = list(group.get("trip_ids") or [])
                trip_count = len(trip_ids)

                start_place_id = _best_place_id(
                    group.get("start_place_ids") or Counter(),
                    place_name_by_id,
                )
                end_place_id = _best_place_id(
                    group.get("end_place_ids") or Counter(),
                    place_name_by_id,
                )
                start_label = place_name_by_id.get(start_place_id or "") or _best_label(
                    group.get("start_labels") or Counter(),
                )
                end_label = place_name_by_id.get(end_place_id or "") or _best_label(
                    group.get("end_labels") or Counter(),
                )
                auto_name = f"{start_label} → {end_label}"

                start_centroid = []
                if group.get("start_count"):
                    start_centroid = [
                        group["start_sum"][0] / group["start_count"],
                        group["start_sum"][1] / group["start_count"],
                    ]

                end_centroid = []
                if group.get("end_count"):
                    end_centroid = [
                        group["end_sum"][0] / group["end_count"],
                        group["end_sum"][1] / group["end_count"],
                    ]

                dist_med = _median(group.get("distances") or [])
                dist_avg = _avg(group.get("distances") or [])
                dur_med = _median(group.get("durations") or [])
                dur_avg = _avg(group.get("durations") or [])
                fuel_avg = _avg(group.get("fuel") or [])
                cost_avg = _avg(group.get("costs") or [])
                max_speed_max = group.get("max_speed_max")

                rep_trip_id = group.get("rep_trip_id") or (
                    trip_ids[-1] if trip_ids else None
                )
                rep_geom = group.get("rep_geometry")
                preview = group.get("rep_preview")
                if preview is None and rep_geom:
                    preview = build_preview_svg_path(rep_geom)

                route = existing_by_key.get(key)
                if route is None:
                    route = _find_route_identity_candidate(
                        group,
                        all_existing_routes,
                        used_route_ids=used_route_ids,
                        params=params,
                        current_keys=eligible_key_set,
                    )
                if route:
                    # Preserve customization fields across rebuilds
                    route.route_key = key
                    route.route_signature = str(
                        group.get("route_signature") or route.route_signature,
                    )
                    route.algorithm_version = int(
                        params.get("algorithm_version") or route.algorithm_version or 1,
                    )
                    route.params = params
                    route.auto_name = auto_name
                    route.start_label = start_label
                    route.end_label = end_label
                    route.start_place_id = start_place_id
                    route.end_place_id = end_place_id
                    route.start_centroid = start_centroid
                    route.end_centroid = end_centroid
                    route.trip_count = trip_count
                    route.is_recurring = trip_count >= min_recurring
                    route.first_start_time = group.get("first_start_time")
                    route.last_start_time = group.get("last_start_time")
                    route.vehicle_imeis = sorted(group.get("vehicle_imeis") or set())
                    route.distance_miles_median = dist_med
                    route.distance_miles_avg = dist_avg
                    route.duration_sec_median = dur_med
                    route.duration_sec_avg = dur_avg
                    route.fuel_gal_avg = fuel_avg
                    route.cost_usd_avg = cost_avg
                    route.max_speed_mph_max = (
                        safe_float(max_speed_max, None)
                        if max_speed_max is not None
                        else None
                    )
                    route.representative_trip_id = rep_trip_id
                    route.geometry = rep_geom
                    route.preview_svg_path = preview
                    route.is_active = True
                    route.updated_at = now
                    await route.save()
                    updated += 1
                else:
                    route = RecurringRoute(
                        route_key=key,
                        route_signature=str(group.get("route_signature") or ""),
                        algorithm_version=int(params.get("algorithm_version") or 1),
                        params=params,
                        name=None,
                        auto_name=auto_name,
                        start_label=start_label,
                        end_label=end_label,
                        start_place_id=start_place_id,
                        end_place_id=end_place_id,
                        start_centroid=start_centroid,
                        end_centroid=end_centroid,
                        trip_count=trip_count,
                        is_recurring=trip_count >= min_recurring,
                        first_start_time=group.get("first_start_time"),
                        last_start_time=group.get("last_start_time"),
                        vehicle_imeis=sorted(group.get("vehicle_imeis") or set()),
                        distance_miles_median=dist_med,
                        distance_miles_avg=dist_avg,
                        duration_sec_median=dur_med,
                        duration_sec_avg=dur_avg,
                        fuel_gal_avg=fuel_avg,
                        cost_usd_avg=cost_avg,
                        max_speed_mph_max=(
                            safe_float(max_speed_max, None)
                            if max_speed_max is not None
                            else None
                        ),
                        representative_trip_id=rep_trip_id,
                        geometry=rep_geom,
                        preview_svg_path=preview,
                        is_pinned=False,
                        is_hidden=False,
                        is_active=True,
                        updated_at=now,
                    )
                    await route.insert()
                    created += 1

                if route.id is not None:
                    used_route_ids.add(route.id)
                seen_keys.add(key)
                route_id_by_key[key] = route.id

                if len(eligible_keys) > 0 and idx % 20 == 0:
                    pct = 60.0 + (idx / len(eligible_keys)) * 25.0
                    await handle.update(
                        progress=pct,
                        message=f"Upserting routes... ({idx}/{len(eligible_keys)})",
                        metadata_patch={
                            "routes_created": created,
                            "routes_updated": updated,
                        },
                    )

            # Assignment step
            await handle.update(
                stage="assigning_trips",
                progress=85.0,
                message="Assigning trips to routes...",
            )

            trips_coll = Trip.get_pymongo_collection()
            await trips_coll.update_many(
                enforce_bouncie_source(
                    {
                        "$or": [
                            {"recurringRoutePendingRouteId": {"$exists": True}},
                            {"recurringRoutePendingBuildId": {"$exists": True}},
                        ],
                    },
                ),
                {
                    "$unset": {
                        "recurringRoutePendingRouteId": "",
                        "recurringRoutePendingBuildId": "",
                    },
                },
            )

            staged = 0
            assignment_build_id = str(job_id)
            chunk_size = 500
            staging_updates: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for idx, key in enumerate(eligible_keys, 1):
                if idx % 25 == 0 and await _job_cancelled(progress):
                    await trips_coll.update_many(
                        enforce_bouncie_source(
                            {"recurringRoutePendingBuildId": assignment_build_id},
                        ),
                        {
                            "$unset": {
                                "recurringRoutePendingRouteId": "",
                                "recurringRoutePendingBuildId": "",
                            },
                        },
                    )
                    await handle.update(
                        status="cancelled",
                        stage="cancelled",
                        progress=0.0,
                        message="Cancelled",
                        completed_at=datetime.now(UTC),
                    )
                    return {
                        "status": "cancelled",
                        "processed": processed,
                        "usable": usable,
                    }

                route_id = route_id_by_key.get(key)
                if not route_id:
                    continue
                trip_ids = list(groups[key].get("trip_ids") or [])
                if not trip_ids:
                    continue

                for start in range(0, len(trip_ids), chunk_size):
                    chunk = trip_ids[start : start + chunk_size]
                    staging_updates.append(
                        (
                            enforce_bouncie_source({"transactionId": {"$in": chunk}}),
                            {
                                "$set": {
                                    "recurringRoutePendingRouteId": route_id,
                                    "recurringRoutePendingBuildId": assignment_build_id,
                                },
                            },
                        ),
                    )

                if (
                    len(eligible_keys) > 0
                    and idx % _BULK_ASSIGNMENT_ROUTE_BATCH_SIZE == 0
                ):
                    staged += await _bulk_update_many(trips_coll, staging_updates)
                    staging_updates = []
                    pct = 85.0 + (idx / len(eligible_keys)) * 7.0
                    await handle.update(
                        progress=pct,
                        message=(
                            "Staging trip assignments... "
                            f"({idx}/{len(eligible_keys)})"
                        ),
                        metadata_patch={"trips_staged": staged},
                    )

            staged += await _bulk_update_many(trips_coll, staging_updates)

            await handle.update(
                stage="finalizing_assignments",
                progress=92.0,
                message="Finalizing trip route assignments...",
                metadata_patch={"trips_staged": staged},
            )

            assigned = 0
            finalize_updates: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for idx, key in enumerate(eligible_keys, 1):
                route_id = route_id_by_key.get(key)
                if not route_id:
                    continue
                trip_ids = list(groups[key].get("trip_ids") or [])
                if not trip_ids:
                    continue

                for start in range(0, len(trip_ids), chunk_size):
                    chunk = trip_ids[start : start + chunk_size]
                    finalize_updates.append(
                        (
                            enforce_bouncie_source(
                                {
                                    "transactionId": {"$in": chunk},
                                    "recurringRoutePendingBuildId": assignment_build_id,
                                },
                            ),
                            {
                                "$set": {
                                    "recurringRouteId": route_id,
                                    "recurringRouteBuildId": assignment_build_id,
                                },
                                "$unset": {
                                    "recurringRoutePendingRouteId": "",
                                    "recurringRoutePendingBuildId": "",
                                },
                            },
                        ),
                    )

                if (
                    len(eligible_keys) > 0
                    and idx % _BULK_ASSIGNMENT_ROUTE_BATCH_SIZE == 0
                ):
                    assigned += await _bulk_update_many(trips_coll, finalize_updates)
                    finalize_updates = []
                    pct = 92.0 + (idx / len(eligible_keys)) * 4.0
                    await handle.update(
                        progress=pct,
                        message=(
                            "Finalizing assignments... "
                            f"({idx}/{len(eligible_keys)})"
                        ),
                        metadata_patch={"trips_assigned": assigned},
                    )

            assigned += await _bulk_update_many(trips_coll, finalize_updates)

            stale_result = await trips_coll.update_many(
                enforce_bouncie_source(
                    {
                        "recurringRouteId": {"$exists": True},
                        "recurringRouteBuildId": {"$ne": assignment_build_id},
                    },
                ),
                {
                    "$set": {"recurringRouteBuildId": assignment_build_id},
                    "$unset": {
                        # Keep the sparse index effective: sparse skips missing
                        # fields, not explicit nulls.
                        "recurringRouteId": "",
                        "recurringRoutePendingRouteId": "",
                        "recurringRoutePendingBuildId": "",
                    },
                },
            )
            unassigned = int(getattr(stale_result, "modified_count", 0) or 0)

            # Deactivate routes not seen only after assignments have finalized.
            await handle.update(
                stage="updating_inactive",
                progress=98.0,
                message="Marking inactive routes...",
            )
            routes_coll = RecurringRoute.get_pymongo_collection()
            await routes_coll.update_many(
                {"is_active": True, "route_key": {"$nin": list(seen_keys)}},
                {"$set": {"is_active": False, "updated_at": now}},
            )

            result = {
                "status": "success",
                "total_trips": total_trips,
                "processed_trips": processed,
                "usable_trips": usable,
                "exact_groups": exact_group_count,
                "merged_groups": max(0, exact_group_count - merged_group_count),
                "eligible_routes": len(eligible_keys),
                "routes_created": created,
                "routes_updated": updated,
                "routes_active": len(seen_keys),
                "trips_staged": staged,
                "trips_assigned": assigned,
                "trips_unassigned": unassigned,
                "updated_at": now.isoformat(),
            }

            await handle.complete(
                message=f"Built {len(seen_keys)} routes; assigned {assigned} trips.",
                result=result,
                metadata_patch=result,
            )

        except Exception as exc:
            logger.exception("Recurring routes build failed")
            await handle.fail(str(exc), message="Build failed")
            raise
        else:
            return result
