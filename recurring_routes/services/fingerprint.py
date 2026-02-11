"""Route fingerprinting utilities for recurring route clustering.

This module is intentionally deterministic and does not call any external services.
"""

from __future__ import annotations

import hashlib
import logging
import math
from collections.abc import Sequence
from typing import Any

from core.spatial import GeometryService

logger = logging.getLogger(__name__)

# Web Mercator (EPSG:3857) constants
_ORIGIN_SHIFT_M = 20037508.342789244
_MAX_MERCATOR_LAT = 85.05112878


def lonlat_to_mercator_m(lon: float, lat: float) -> tuple[float, float]:
    """Convert WGS84 lon/lat to Web Mercator meters (EPSG:3857)."""
    lat_clamped = max(-_MAX_MERCATOR_LAT, min(_MAX_MERCATOR_LAT, float(lat)))
    lon_f = float(lon)
    x = lon_f * _ORIGIN_SHIFT_M / 180.0
    y = (
        math.log(math.tan((90.0 + lat_clamped) * math.pi / 360.0))
        * _ORIGIN_SHIFT_M
        / math.pi
    )
    return x, y


def grid_cell(x_m: float, y_m: float, cell_size_m: float) -> tuple[int, int]:
    """Quantize Web Mercator meters into integer grid cells."""
    size = max(1.0, float(cell_size_m))
    return (math.floor(x_m / size), math.floor(y_m / size))


def _extract_geojson_coords(geometry: dict[str, Any] | None) -> list[list[float]]:
    if not isinstance(geometry, dict):
        return []
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")
    raw: list[Any] = []
    if geom_type == "LineString" and isinstance(coords, list):
        raw = coords
    elif geom_type == "MultiLineString" and isinstance(coords, list):
        for line in coords:
            if isinstance(line, list):
                raw.extend(line)
    else:
        return []

    cleaned: list[list[float]] = []
    for coord in raw:
        valid, pair = GeometryService.validate_coordinate_pair(coord)
        if valid and pair:
            cleaned.append(pair)

    # Dedupe consecutive pairs (stabilizes sampling)
    deduped: list[list[float]] = []
    for pair in cleaned:
        if not deduped or pair != deduped[-1]:
            deduped.append(pair)

    return deduped


def extract_polyline(trip: dict[str, Any]) -> list[list[float]]:
    """Extract a [lon, lat] polyline from a trip in a stable priority order."""
    geom = GeometryService.parse_geojson(
        trip.get("matchedGps")
    ) or GeometryService.parse_geojson(
        trip.get("gps"),
    )
    coords = _extract_geojson_coords(geom) if geom else []
    if len(coords) >= 2:
        return coords

    raw_coords = trip.get("coordinates")
    if isinstance(raw_coords, list) and raw_coords:
        pairs: list[Sequence[Any]] = []
        for item in raw_coords:
            if not isinstance(item, dict):
                continue
            lon = item.get("lon")
            lat = item.get("lat")
            if lon is None:
                lon = item.get("lng")
            if lon is None or lat is None:
                continue
            pairs.append([lon, lat])

        geom2 = GeometryService.geometry_from_coordinate_pairs(
            pairs, allow_point=False, dedupe=True, validate=True
        )
        coords2 = _extract_geojson_coords(geom2) if geom2 else []
        if len(coords2) >= 2:
            return coords2

    return []


def _cumulative_distances_m(points: list[list[float]]) -> tuple[list[float], float]:
    if len(points) < 2:
        return [0.0], 0.0
    distances = [0.0]
    total = 0.0
    for i in range(1, len(points)):
        lon1, lat1 = points[i - 1]
        lon2, lat2 = points[i]
        seg = GeometryService.haversine_distance(lon1, lat1, lon2, lat2, unit="meters")
        if seg < 0:
            seg = 0.0
        total += seg
        distances.append(total)
    return distances, total


def sample_waypoints(
    points: list[list[float]], waypoint_count: int = 4
) -> list[list[float]]:
    """Sample waypoints at 20/40/60/80% (for count=4) of polyline distance."""
    if len(points) < 2:
        return []

    waypoint_count = max(0, int(waypoint_count))
    if waypoint_count == 0:
        return []

    cum, total = _cumulative_distances_m(points)
    if total <= 0:
        return []

    fracs = [(i / (waypoint_count + 1.0)) for i in range(1, waypoint_count + 1)]
    targets = [total * frac for frac in fracs]

    sampled: list[list[float]] = []
    seg_idx = 1
    for target in targets:
        while seg_idx < len(cum) and cum[seg_idx] < target:
            seg_idx += 1
        if seg_idx >= len(cum):
            sampled.append(points[-1])
            continue
        prev_d = cum[seg_idx - 1]
        next_d = cum[seg_idx]
        if next_d <= prev_d:
            sampled.append(points[seg_idx])
            continue
        t = (target - prev_d) / (next_d - prev_d)
        lon1, lat1 = points[seg_idx - 1]
        lon2, lat2 = points[seg_idx]
        sampled.append([lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t])

    return sampled


def _extract_point_from_geopoint(value: Any) -> list[float] | None:
    if not isinstance(value, dict):
        return None
    if value.get("type") != "Point":
        return None
    coords = value.get("coordinates")
    if not isinstance(coords, list) or len(coords) < 2:
        return None
    valid, pair = GeometryService.validate_coordinate_pair(coords)
    if valid and pair:
        return pair
    return None


def compute_route_signature(trip: dict[str, Any], params: dict[str, Any]) -> str | None:
    """Compute a stable signature string used for route clustering."""
    algo = int(params.get("algorithm_version") or 1)
    start_end_cell_m = float(params.get("start_end_cell_size_m") or 200)
    waypoint_cell_m = float(params.get("waypoint_cell_size_m") or 650)
    waypoint_count = int(params.get("waypoint_count") or 4)
    bucket_miles = float(params.get("distance_bucket_miles") or 0.5)

    points = extract_polyline(trip)
    if len(points) < 2:
        return None

    start_pt = _extract_point_from_geopoint(trip.get("startGeoPoint")) or points[0]
    end_pt = _extract_point_from_geopoint(trip.get("destinationGeoPoint")) or points[-1]

    sx, sy = lonlat_to_mercator_m(start_pt[0], start_pt[1])
    ex, ey = lonlat_to_mercator_m(end_pt[0], end_pt[1])
    start_cell = grid_cell(sx, sy, start_end_cell_m)
    end_cell = grid_cell(ex, ey, start_end_cell_m)

    waypoints = sample_waypoints(points, waypoint_count=waypoint_count)
    waypoint_cells: list[tuple[int, int]] = []
    for wp in waypoints:
        wx, wy = lonlat_to_mercator_m(wp[0], wp[1])
        waypoint_cells.append(grid_cell(wx, wy, waypoint_cell_m))

    dist_miles = None
    raw_dist = trip.get("distance")
    if isinstance(raw_dist, int | float):
        dist_miles = float(raw_dist)
    elif isinstance(raw_dist, dict):
        value = raw_dist.get("value")
        if isinstance(value, int | float):
            dist_miles = float(value)
    if dist_miles is None:
        _, total_m = _cumulative_distances_m(points)
        dist_miles = total_m / 1609.344

    if dist_miles < 0:
        dist_miles = 0.0

    bucket = (
        round(dist_miles / bucket_miles) * bucket_miles
        if bucket_miles > 0
        else dist_miles
    )

    wp_part = ",".join(f"{cx}:{cy}" for cx, cy in waypoint_cells)
    sig = (
        f"v{algo}|"
        f"s{start_cell[0]},{start_cell[1]}|"
        f"e{end_cell[0]},{end_cell[1]}|"
        f"w{wp_part}|"
        f"d{bucket:.1f}"
    )
    return sig


def compute_route_key(signature: str) -> str:
    """Hash a signature to a compact stable key."""
    return hashlib.sha1(signature.encode("utf-8")).hexdigest()


def build_preview_svg_path(
    geometry: dict[str, Any] | None,
    *,
    width: float = 100.0,
    height: float = 40.0,
    padding: float = 4.0,
    max_points: int = 64,
) -> str | None:
    """Build a compact SVG path string for a LineString-like geometry."""
    if not geometry:
        return None

    coords = _extract_geojson_coords(geometry)
    if len(coords) < 2:
        return None

    if len(coords) > max_points:
        step = max(1, len(coords) // max_points)
        sampled = coords[::step]
        if sampled[-1] != coords[-1]:
            sampled.append(coords[-1])
        coords = sampled

    lons = [pt[0] for pt in coords]
    lats = [pt[1] for pt in coords]
    min_lon = min(lons)
    max_lon = max(lons)
    min_lat = min(lats)
    max_lat = max(lats)

    if min_lon == max_lon:
        min_lon -= 0.0001
        max_lon += 0.0001
    if min_lat == max_lat:
        min_lat -= 0.0001
        max_lat += 0.0001

    span_lon = max_lon - min_lon
    span_lat = max_lat - min_lat
    if span_lon <= 0 or span_lat <= 0:
        return None

    scale_x = (width - (padding * 2)) / span_lon
    scale_y = (height - (padding * 2)) / span_lat

    def project(pt: Sequence[float]) -> tuple[float, float]:
        x = padding + (pt[0] - min_lon) * scale_x
        y = padding + (max_lat - pt[1]) * scale_y
        return x, y

    points = [project(pt) for pt in coords]
    path_parts = [f"M {points[0][0]:.1f},{points[0][1]:.1f}"]
    path_parts.extend(f"L {x:.1f},{y:.1f}" for x, y in points[1:])
    return " ".join(path_parts)


def extract_display_label(value: Any) -> str | None:
    """Extract a human-readable label from stored location-like objects."""
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned if cleaned else None
    if isinstance(value, dict):
        for key in ("formatted_address", "name"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        # Fallback to a compact address_components join
        components = value.get("address_components")
        if isinstance(components, dict):
            parts = [
                str(components.get("street") or "").strip(),
                str(components.get("city") or "").strip(),
                str(components.get("state") or "").strip(),
            ]
            parts = [p for p in parts if p]
            if parts:
                return ", ".join(parts)
    return None
