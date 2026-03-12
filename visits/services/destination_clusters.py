"""Shared helpers for clustering and labeling trip destinations."""

from __future__ import annotations

from typing import Any

from shapely.geometry import MultiPoint
from shapely.ops import transform

from core.spatial import get_local_transformers


def extract_destination_coords(doc: dict[str, Any]) -> tuple[float, float] | None:
    """Extract the best available destination coordinate pair from a trip-like doc."""
    dest_geo = doc.get("destinationGeoPoint")
    if isinstance(dest_geo, dict):
        coords = dest_geo.get("coordinates")
        if (
            isinstance(coords, list)
            and len(coords) >= 2
            and isinstance(coords[0], int | float)
            and isinstance(coords[1], int | float)
        ):
            return float(coords[0]), float(coords[1])

    gps = doc.get("gps")
    if isinstance(gps, dict):
        gps_type = gps.get("type")
        coords = gps.get("coordinates")
        if gps_type == "Point" and isinstance(coords, list) and len(coords) >= 2:
            return float(coords[0]), float(coords[1])
        if gps_type == "LineString" and isinstance(coords, list) and len(coords) >= 2:
            last = coords[-1]
            if isinstance(last, list) and len(last) >= 2:
                return float(last[0]), float(last[1])

    destination = doc.get("destination") or {}
    coords = destination.get("coordinates")
    if isinstance(coords, dict):
        lng = coords.get("lng")
        lat = coords.get("lat")
        if isinstance(lng, int | float) and isinstance(lat, int | float):
            return float(lng), float(lat)

    return None


def extract_destination_label(doc: dict[str, Any]) -> str | None:
    """Extract the best available human-readable destination label from a trip-like doc."""
    for candidate in (
        doc.get("destinationPlaceName"),
        (doc.get("destination") or {}).get("formatted_address"),
        ((doc.get("destination") or {}).get("address_components") or {}).get("street"),
    ):
        if not isinstance(candidate, str):
            continue
        cleaned = candidate.strip()
        if cleaned and cleaned.lower() not in {"unknown", "n/a", "na"}:
            return cleaned
    return None


def build_destination_cluster_boundary(
    *,
    points: list[tuple[float, float]],
    cell_size_m: int,
) -> Any:
    """Create a buffered hull around destination points using local meters."""
    cluster_geom = MultiPoint(points)
    to_meters, to_wgs84 = get_local_transformers(cluster_geom)
    cluster_geom_m = transform(to_meters, cluster_geom)
    hull_m = cluster_geom_m.convex_hull
    centroid_m = cluster_geom_m.centroid
    distances = sorted(centroid_m.distance(pt) for pt in cluster_geom_m.geoms)
    if distances:
        p60_idx = int(0.6 * (len(distances) - 1))
        p60_dist = distances[p60_idx]
    else:
        p60_dist = 0.0
    buffer_m = max(20.0, min(cell_size_m * 0.35, p60_dist * 0.6))
    return transform(to_wgs84, hull_m.buffer(buffer_m))
