"""
Spatial and geometry utilities.

Centralizes GeoJSON handling, coordinate validation, distance
calculations, Shapely/pyproj helpers, and routing geometry utilities.
"""

from __future__ import annotations

import json
import logging
import math
from typing import TYPE_CHECKING, Any

import pyproj

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Sequence

    from shapely.geometry.base import BaseGeometry

logger = logging.getLogger(__name__)

WGS84 = pyproj.CRS("EPSG:4326")
GEOD = pyproj.Geod(ellps="WGS84")


class GeometryService:
    """Authoritative geometry operations for the application."""

    EARTH_RADIUS_M = 6371000.0

    @staticmethod
    def validate_coordinate_pair(
        coord: Sequence[Any],
    ) -> tuple[bool, list[float] | None]:
        """Validate a [lon, lat] coordinate pair."""
        if not isinstance(coord, (list, tuple)) or len(coord) < 2:
            return False, None
        try:
            lon = float(coord[0])
            lat = float(coord[1])
        except (TypeError, ValueError, IndexError):
            return False, None
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            return False, None
        return True, [lon, lat]

    @staticmethod
    def validate_bounding_box(
        min_lat: float,
        min_lon: float,
        max_lat: float,
        max_lon: float,
    ) -> bool:
        """Validate bounding box coordinate ranges."""
        valid_min, _ = GeometryService.validate_coordinate_pair([min_lon, min_lat])
        valid_max, _ = GeometryService.validate_coordinate_pair([max_lon, max_lat])
        return valid_min and valid_max

    @staticmethod
    def haversine_distance(
        lon1: float,
        lat1: float,
        lon2: float,
        lat2: float,
        unit: str = "meters",
    ) -> float:
        """Calculate the great-circle distance using the Haversine formula."""
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlmb = math.radians(lon2 - lon1)
        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
        )
        distance_m = (
            2 * GeometryService.EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))
        )
        if unit == "meters":
            return distance_m
        if unit == "miles":
            return distance_m / 1609.344
        if unit == "km":
            return distance_m / 1000.0
        msg = "Invalid unit. Use 'meters', 'miles', or 'km'."
        raise ValueError(msg)

    @staticmethod
    def parse_geojson(value: Any) -> dict[str, Any] | None:
        """Parse GeoJSON geometry from a dict or JSON string."""
        if value is None:
            return None
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                return None
        if isinstance(value, dict):
            if value.get("type") == "Feature":
                geometry = value.get("geometry")
                return geometry if isinstance(geometry, dict) else None
            if "type" in value:
                return value
        return None

    @staticmethod
    def geometry_from_document(
        doc: dict[str, Any],
        geometry_field: str,
    ) -> dict[str, Any] | None:
        """Extract GeoJSON geometry from a document field."""
        if not isinstance(doc, dict):
            return None
        return GeometryService.parse_geojson(doc.get(geometry_field))

    @staticmethod
    def geometry_from_coordinate_pairs(
        coords: Iterable[Sequence[Any]],
        *,
        allow_point: bool = True,
        dedupe: bool = False,
        validate: bool = True,
    ) -> dict[str, Any] | None:
        """Build a GeoJSON Point/LineString from coordinate pairs."""
        if not coords:
            return None

        cleaned: list[list[float]] = []
        for coord in coords:
            if validate:
                is_valid, pair = GeometryService.validate_coordinate_pair(coord)
                if not is_valid or pair is None:
                    continue
            else:
                try:
                    pair = [float(coord[0]), float(coord[1])]
                except (TypeError, ValueError, IndexError):
                    continue
            cleaned.append(pair)

        if not cleaned:
            return None

        if dedupe:
            unique: list[list[float]] = []
            for coord in cleaned:
                if not unique or coord != unique[-1]:
                    unique.append(coord)
            cleaned = unique

        if len(cleaned) == 1:
            return {"type": "Point", "coordinates": cleaned[0]} if allow_point else None
        if len(cleaned) < 2:
            return None
        return {"type": "LineString", "coordinates": cleaned}

    @staticmethod
    def geometry_from_coordinate_dicts(
        coords: Iterable[dict[str, Any]],
        *,
        lon_key: str = "lon",
        lat_key: str = "lat",
        allow_point: bool = True,
        dedupe: bool = True,
        validate: bool = True,
    ) -> dict[str, Any] | None:
        """Build GeoJSON from dicts containing lon/lat keys."""
        pairs: list[list[Any]] = []
        for item in coords:
            if not isinstance(item, dict):
                continue
            lon = item.get(lon_key)
            lat = item.get(lat_key)
            if lon is None or lat is None:
                continue
            pairs.append([lon, lat])
        return GeometryService.geometry_from_coordinate_pairs(
            pairs,
            allow_point=allow_point,
            dedupe=dedupe,
            validate=validate,
        )

    @staticmethod
    def bounding_box_polygon(
        min_lat: float,
        min_lon: float,
        max_lat: float,
        max_lon: float,
    ) -> dict[str, Any] | None:
        """Create a GeoJSON Polygon for a bounding box."""
        if not GeometryService.validate_bounding_box(
            min_lat,
            min_lon,
            max_lat,
            max_lon,
        ):
            return None
        coords = [
            [min_lon, min_lat],
            [max_lon, min_lat],
            [max_lon, max_lat],
            [min_lon, max_lat],
            [min_lon, min_lat],
        ]
        return {"type": "Polygon", "coordinates": [coords]}

    @staticmethod
    def feature_from_geometry(
        geometry: dict[str, Any] | None,
        properties: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build a GeoJSON Feature from geometry and properties."""
        return {
            "type": "Feature",
            "geometry": geometry,
            "properties": properties or {},
        }

    @staticmethod
    def feature_collection(features: list[dict[str, Any]]) -> dict[str, Any]:
        """Build a GeoJSON FeatureCollection."""
        return {"type": "FeatureCollection", "features": features}


def is_valid_geojson_geometry(geojson_data: Any) -> bool:
    """Validate GeoJSON Point or LineString geometry."""
    if not isinstance(geojson_data, dict):
        return False

    geom_type = geojson_data.get("type")
    coordinates = geojson_data.get("coordinates")

    if geom_type == "Point":
        if not isinstance(coordinates, list) or len(coordinates) != 2:
            return False
        if not all(isinstance(coord, (int, float)) for coord in coordinates):
            return False
        lon, lat = coordinates
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            logger.debug("Point coordinates out of WGS84 range: %s", [lon, lat])
            return False
        return True

    if geom_type == "LineString":
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            logger.debug(
                "LineString must have at least 2 coordinate pairs. Found: %d",
                len(coordinates) if isinstance(coordinates, list) else 0,
            )
            return False
        for point in coordinates:
            if not isinstance(point, list) or len(point) != 2:
                return False
            if not all(isinstance(coord, (int, float)) for coord in point):
                return False
            lon, lat = point
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                logger.debug("LineString point out of WGS84 range: %s", [lon, lat])
                return False
        return True

    return False


def derive_geo_points(
    gps: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Derive start and destination GeoJSON points from GPS geometry."""
    if not gps or not isinstance(gps, dict):
        return None, None
    gps_type = gps.get("type")
    coords = gps.get("coordinates")

    if gps_type == "Point" and coords and len(coords) >= 2:
        geo_point = {"type": "Point", "coordinates": [coords[0], coords[1]]}
        return geo_point, geo_point

    if (
        gps_type == "LineString"
        and coords
        and isinstance(coords, list)
        and len(coords) >= 2
    ):
        start_coords = coords[0]
        end_coords = coords[-1]
        if (
            isinstance(start_coords, list)
            and len(start_coords) >= 2
            and isinstance(end_coords, list)
            and len(end_coords) >= 2
        ):
            return (
                {"type": "Point", "coordinates": [start_coords[0], start_coords[1]]},
                {"type": "Point", "coordinates": [end_coords[0], end_coords[1]]},
            )
    return None, None


def get_local_transformers(
    geom: BaseGeometry,
) -> tuple[
    Callable[[float, float], tuple[float, float]],
    Callable[[float, float], tuple[float, float]],
]:
    """
    Build local azimuthal equidistant transformers centered on the geometry.

    Returns (to_meters, to_wgs84) callables.
    """
    centroid = geom.centroid
    lon = float(centroid.x)
    lat = float(centroid.y)

    local_crs = pyproj.CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m +no_defs",
    )
    to_meters = pyproj.Transformer.from_crs(
        WGS84,
        local_crs,
        always_xy=True,
    ).transform
    to_wgs84 = pyproj.Transformer.from_crs(
        local_crs,
        WGS84,
        always_xy=True,
    ).transform
    return to_meters, to_wgs84


def geodesic_distance_meters(
    lon1: float,
    lat1: float,
    lon2: float,
    lat2: float,
) -> float:
    """Return the geodesic distance between two lon/lat points in meters."""
    _, _, dist = GEOD.inv(lon1, lat1, lon2, lat2)
    return abs(dist)


def _line_length_meters(coords: list[tuple[float, float]]) -> float:
    if len(coords) < 2:
        return 0.0
    lons, lats = zip(*coords, strict=False)
    return abs(GEOD.line_length(lons, lats))


def geodesic_length_meters(geom: BaseGeometry) -> float:
    """Return the geodesic length of a LineString or MultiLineString in meters."""
    if geom.is_empty:
        return 0.0
    geom_type = geom.geom_type
    if geom_type == "LineString":
        return _line_length_meters(list(geom.coords))
    if geom_type == "MultiLineString":
        return sum(_line_length_meters(list(line.coords)) for line in geom.geoms)
    return 0.0


def buffer_polygon_for_routing(
    polygon: Any,
    buffer_ft: float,
    *,
    feet_per_meter: float = 3.28084,
) -> Any:
    """Buffer a WGS84 polygon by feet (project to UTM, buffer, reproject)."""
    if buffer_ft <= 0:
        return polygon
    try:
        import geopandas as gpd
        import osmnx as ox

        buffer_m = buffer_ft / feet_per_meter
        gdf = gpd.GeoDataFrame(geometry=[polygon], crs="EPSG:4326")
        projected = ox.projection.project_gdf(gdf)
        buffered = projected.geometry.iloc[0].buffer(buffer_m)
        buffered_gdf = gpd.GeoDataFrame(geometry=[buffered], crs=projected.crs)
        return buffered_gdf.to_crs("EPSG:4326").geometry.iloc[0]
    except Exception as exc:
        logger.warning("Routing buffer failed, using original polygon: %s", exc)
        return polygon


def segment_midpoint(coords: list[list[float]]) -> tuple[float, float] | None:
    """Midpoint (lon, lat) for a LineString coordinate list."""
    if not coords or len(coords) < 2:
        return None
    try:
        from shapely.geometry import LineString

        ls = LineString(coords)
        mid = ls.interpolate(0.5, normalized=True)
        return (float(mid.x), float(mid.y))
    except Exception:
        try:
            mx = float((coords[0][0] + coords[-1][0]) / 2.0)
            my = float((coords[0][1] + coords[-1][1]) / 2.0)
        except Exception:
            return None
        else:
            return (mx, my)


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


def extract_timestamps_for_coordinates(
    coordinates: list[list[float]],
    trip_data: dict[str, Any],
) -> list[int | None]:
    """
    Extract timestamps for coordinates, interpolating if necessary.

    Args:
        coordinates: List of [lon, lat] coordinates
        trip_data: Trip data containing optional timestamp info

    Returns:
        List of elapsed seconds (relative to first point) or None values
    """
    from core.date_utils import parse_timestamp

    timestamps: list[int | None] = []

    def _normalize_timestamp(value: Any) -> int | None:
        if isinstance(value, str):
            parsed = parse_timestamp(value)
            return int(parsed.timestamp()) if parsed else None
        if hasattr(value, "timestamp"):
            return int(value.timestamp())
        if isinstance(value, (int, float)):
            return int(value)
        return None

    def _to_elapsed(values: list[int]) -> list[int]:
        if not values:
            return []
        start = values[0]
        return [int(v - start) for v in values]

    trip_coords = trip_data.get("coordinates", [])
    if trip_coords and len(trip_coords) == len(coordinates):
        for coord_obj in trip_coords:
            if isinstance(coord_obj, dict) and "timestamp" in coord_obj:
                timestamps.append(_normalize_timestamp(coord_obj["timestamp"]))
            else:
                timestamps.append(None)

        if all(t is not None for t in timestamps):
            return _to_elapsed([t for t in timestamps if t is not None])
        timestamps = []

    start_time = trip_data.get("startTime")
    end_time = trip_data.get("endTime")

    if start_time and end_time:
        if isinstance(start_time, str):
            start_time = parse_timestamp(start_time)
        if isinstance(end_time, str):
            end_time = parse_timestamp(end_time)

        if start_time and end_time:
            start_ts = int(start_time.timestamp())
            end_ts = int(end_time.timestamp())
            duration = end_ts - start_ts
            if duration < 0:
                return [None] * len(coordinates)

            if len(coordinates) > 1:
                for i in range(len(coordinates)):
                    ratio = i / (len(coordinates) - 1)
                    timestamps.append(int(duration * ratio))
            else:
                timestamps.append(0)

            return timestamps

    return [None] * len(coordinates)
