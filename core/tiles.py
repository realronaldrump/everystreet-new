"""
Slippy-map tile helpers used by vector-tile APIs.

Coordinates:
- WGS84: lon/lat degrees (EPSG:4326)
- WebMercator: meters (EPSG:3857)
"""

from __future__ import annotations

from typing import Final

import mercantile

DEFAULT_EXTENT: Final[int] = 4096
DEFAULT_BUFFER: Final[int] = 64


def tile_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return tile bounds in EPSG:3857 meters as (minx, miny, maxx, maxy)."""
    b = mercantile.xy_bounds(x, y, z)
    return float(b.left), float(b.bottom), float(b.right), float(b.top)


def tile_bounds_wgs84(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return tile bounds in lon/lat degrees as (min_lon, min_lat, max_lon, max_lat)."""
    b = mercantile.bounds(x, y, z)
    return float(b.west), float(b.south), float(b.east), float(b.north)


def buffer_meters(
    bounds_3857: tuple[float, float, float, float],
    *,
    extent: int = DEFAULT_EXTENT,
    buffer: int = DEFAULT_BUFFER,
) -> float:
    """Compute a WebMercator buffer in meters for an MVT tile.

    Buffer is specified in tile coordinate units (0..extent). We convert that
    to meters based on the tile width at the given zoom.
    """
    minx, _miny, maxx, _maxy = bounds_3857
    tile_width_m = maxx - minx
    if tile_width_m <= 0:
        return 0.0
    return float(tile_width_m * (float(buffer) / float(extent)))

