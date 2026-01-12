"""
Geo helpers for coverage calculations.

Provides local projections for meter-based geometry work and geodesic length
calculations for accurate distances.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pyproj

if TYPE_CHECKING:
    from collections.abc import Callable

    from shapely.geometry.base import BaseGeometry

WGS84 = pyproj.CRS("EPSG:4326")
GEOD = pyproj.Geod(ellps="WGS84")


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
