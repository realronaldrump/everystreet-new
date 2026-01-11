"""
Trip-to-street matching logic.

This module handles the geometric intersection between trip GPS traces
and street segments to determine which segments have been driven.
"""

from __future__ import annotations

import logging
from typing import Any

from beanie import PydanticObjectId
from shapely.geometry import LineString, shape
from shapely.ops import transform
import pyproj

from coverage.models import Street
from coverage.constants import (
    MATCH_BUFFER_METERS,
    MIN_OVERLAP_METERS,
)

logger = logging.getLogger(__name__)

# Coordinate transformers for buffer calculations
# WGS84 to Web Mercator (for meter-based operations)
WGS84 = pyproj.CRS("EPSG:4326")
WEB_MERCATOR = pyproj.CRS("EPSG:3857")

to_meters = pyproj.Transformer.from_crs(WGS84, WEB_MERCATOR, always_xy=True).transform
to_wgs84 = pyproj.Transformer.from_crs(WEB_MERCATOR, WGS84, always_xy=True).transform


def trip_to_linestring(trip: dict[str, Any]) -> LineString | None:
    """
    Convert a trip document to a Shapely LineString.

    Handles both GeoJSON geometry and raw coordinate arrays.
    Returns None if trip has no valid geometry.
    """
    # Try GeoJSON geometry first
    if "gps" in trip and isinstance(trip["gps"], dict):
        geom = trip["gps"]
        if geom.get("type") == "LineString" and geom.get("coordinates"):
            coords = geom["coordinates"]
            if len(coords) >= 2:
                return LineString(coords)

    # Try raw coordinates array
    if "coordinates" in trip:
        coords = trip["coordinates"]
        if len(coords) >= 2:
            return LineString(coords)

    # Try locations array (from live tracking)
    if "locations" in trip:
        locs = trip["locations"]
        if len(locs) >= 2:
            coords = [
                [loc["lon"], loc["lat"]]
                for loc in locs
                if "lon" in loc and "lat" in loc
            ]
            if len(coords) >= 2:
                return LineString(coords)

    return None


def buffer_trip_line(
    trip_line: LineString, buffer_meters: float = MATCH_BUFFER_METERS
) -> Any:
    """
    Create a buffer polygon around a trip line.

    Projects to meters, buffers, then projects back to WGS84.
    """
    # Project to meters
    line_meters = transform(to_meters, trip_line)
    # Buffer
    buffered = line_meters.buffer(buffer_meters)
    # Project back to WGS84
    return transform(to_wgs84, buffered)


def check_segment_overlap(
    segment_geom: dict[str, Any],
    trip_buffer: Any,
    min_overlap_meters: float = MIN_OVERLAP_METERS,
) -> bool:
    """
    Check if a street segment overlaps sufficiently with a trip buffer.

    Returns True if the segment intersects the buffer and the intersection
    length meets the minimum overlap threshold.
    """
    try:
        segment_line = shape(segment_geom)

        if not segment_line.is_valid:
            return False

        if not trip_buffer.intersects(segment_line):
            return False

        # Calculate intersection length in meters
        intersection = trip_buffer.intersection(segment_line)

        if intersection.is_empty:
            return False

        # Project to meters for accurate length calculation
        intersection_meters = transform(to_meters, intersection)
        intersection_length = intersection_meters.length

        return intersection_length >= min_overlap_meters

    except Exception as e:
        logger.debug(f"Error checking segment overlap: {e}")
        return False


async def find_matching_segments(
    area_id: PydanticObjectId,
    trip_line: LineString,
) -> list[str]:
    """
    Find all street segments that match a trip line.

    Uses MongoDB geospatial query to find candidate segments,
    then uses Shapely for precise intersection testing.

    Returns list of segment_ids that were matched.
    """
    # Create buffered polygon around trip
    trip_buffer = buffer_trip_line(trip_line)

    # Get bounding box for initial MongoDB query
    minx, miny, maxx, maxy = trip_buffer.bounds

    # Query segments that intersect the trip buffer's bounding box
    # Using $geoIntersects with a Polygon for better performance
    buffer_coords = list(trip_buffer.exterior.coords)

    query = {
        "area_id": area_id,
        "geometry": {
            "$geoIntersects": {
                "$geometry": {
                    "type": "Polygon",
                    "coordinates": [buffer_coords],
                }
            }
        },
    }

    matched_segment_ids = []

    async for street in Street.find(query):
        if check_segment_overlap(street.geometry, trip_buffer):
            matched_segment_ids.append(street.segment_id)

    logger.debug(
        f"Found {len(matched_segment_ids)} matching segments for trip in area {area_id}"
    )

    return matched_segment_ids


async def match_trip_to_streets(
    trip: dict[str, Any],
    area_ids: list[PydanticObjectId] | None = None,
) -> dict[PydanticObjectId, list[str]]:
    """
    Match a trip to streets in one or more areas.

    If area_ids is None, matches against all ready areas that
    intersect the trip's bounding box.

    Returns dict mapping area_id -> list of matched segment_ids.
    """
    trip_line = trip_to_linestring(trip)
    if trip_line is None:
        logger.warning(f"Trip has no valid geometry, skipping matching")
        return {}

    # If no areas specified, find areas that intersect trip
    if area_ids is None:
        from coverage.models import CoverageArea

        minx, miny, maxx, maxy = trip_line.bounds

        # Find areas whose bounding box intersects trip
        areas = await CoverageArea.find(
            {
                "status": "ready",
                "bounding_box.0": {"$lte": maxx},  # min_lon <= trip_max_lon
                "bounding_box.2": {"$gte": minx},  # max_lon >= trip_min_lon
                "bounding_box.1": {"$lte": maxy},  # min_lat <= trip_max_lat
                "bounding_box.3": {"$gte": miny},  # max_lat >= trip_min_lat
            }
        ).to_list()

        area_ids = [area.id for area in areas]

    if not area_ids:
        logger.debug("No areas to match against")
        return {}

    results = {}
    for area_id in area_ids:
        matched = await find_matching_segments(area_id, trip_line)
        if matched:
            results[area_id] = matched

    return results
