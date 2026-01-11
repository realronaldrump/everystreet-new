import logging
from typing import Any

import geopandas as gpd
import osmnx as ox
from shapely.geometry import LineString

from geometry_service import GeometryService

from .constants import FEET_PER_METER

logger = logging.getLogger(__name__)


def _buffer_polygon_for_routing(polygon: Any, buffer_ft: float) -> Any:
    """Buffer a WGS84 polygon by feet (project to UTM, buffer, reproject)."""
    if buffer_ft <= 0:
        return polygon
    try:
        # Convert feet to meters for internal projection operations
        buffer_m = buffer_ft / FEET_PER_METER
        gdf = gpd.GeoDataFrame(geometry=[polygon], crs="EPSG:4326")
        projected = ox.projection.project_gdf(gdf)
        buffered = projected.geometry.iloc[0].buffer(buffer_m)
        buffered_gdf = gpd.GeoDataFrame(geometry=[buffered], crs=projected.crs)
        return buffered_gdf.to_crs("EPSG:4326").geometry.iloc[0]
    except Exception as e:
        logger.warning("Routing buffer failed, using original polygon: %s", e)
        return polygon


def _segment_midpoint(coords: list[list[float]]) -> tuple[float, float] | None:
    """Midpoint (lon, lat) for a LineString coordinate list."""
    if not coords or len(coords) < 2:
        return None
    try:
        ls = LineString(coords)
        mid = ls.interpolate(0.5, normalized=True)
        return (float(mid.x), float(mid.y))
    except Exception:
        try:
            mx = float((coords[0][0] + coords[-1][0]) / 2.0)
            my = float((coords[0][1] + coords[-1][1]) / 2.0)
            return (mx, my)
        except Exception:
            return None


def calculate_max_route_gap(route_coords: list[list[float]]) -> float:
    """Maximum haversine gap between consecutive route coordinates in feet."""
    max_gap = 0.0
    for idx in range(1, len(route_coords)):
        prev = route_coords[idx - 1]
        cur = route_coords[idx]
        if len(prev) < 2 or len(cur) < 2:
            continue
        d_miles = GeometryService.haversine_distance(
            prev[0],
            prev[1],
            cur[0],
            cur[1],
            unit="miles",
        )
        d_ft = d_miles * 5280.0
        max_gap = max(max_gap, d_ft)
    return max_gap


def log_jump_distance(
    old_node: int,
    new_node: int,
    node_xy: dict[int, tuple[float, float]],
) -> None:
    """Log distance of jump between disconnected components."""
    old_xy = node_xy.get(old_node)
    new_xy = node_xy.get(new_node)
    if old_xy and new_xy:
        jump_dist = GeometryService.haversine_distance(
            old_xy[0],
            old_xy[1],
            new_xy[0],
            new_xy[1],
            unit="miles",
        )
        logger.warning(
            "Route contains %.2f mile gap between disconnected components "
            "(nodes %d -> %d). Run bridge_disconnected_clusters() to fix.",
            jump_dist,
            old_node,
            new_node,
        )
