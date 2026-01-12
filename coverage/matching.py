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

from coverage.constants import (
    MATCH_BUFFER_METERS,
    MIN_OVERLAP_METERS,
)
from coverage.geo_utils import get_local_transformers
from coverage.models import Street

logger = logging.getLogger(__name__)


def trip_to_linestring(trip: dict[str, Any]) -> LineString | None:
    """
    Convert a trip document to a Shapely LineString.

    Handles both GeoJSON geometry and raw coordinate arrays.
    Returns None if trip has no valid geometry.
    """
    # Prefer matched geometry when available
    if "matchedGps" in trip and isinstance(trip["matchedGps"], dict):
        geom = trip["matchedGps"]
        if geom.get("type") == "LineString" and geom.get("coordinates"):
            coords = geom["coordinates"]
            if len(coords) >= 2:
                return LineString(coords)

    # Try GeoJSON geometry next
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
            if isinstance(coords[0], dict):
                coords = [
                    [point["lon"], point["lat"]]
                    for point in coords
                    if "lon" in point and "lat" in point
                ]
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
) -> tuple[Any, Any, Any]:
    """
    Create buffer polygons around a trip line.

    Returns (buffer_meters_geom, buffer_wgs84_geom, to_meters_transform).
    """
    to_meters, to_wgs84 = get_local_transformers(trip_line)
    line_meters = transform(to_meters, trip_line)
    # Buffer
    buffered_meters = line_meters.buffer(buffer_meters)
    buffered_wgs84 = transform(to_wgs84, buffered_meters)
    return buffered_meters, buffered_wgs84, to_meters


def check_segment_overlap(
    segment_geom: dict[str, Any],
    trip_buffer_meters: Any,
    to_meters: Any,
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

        segment_meters = transform(to_meters, segment_line)

        if not trip_buffer_meters.intersects(segment_meters):
            return False

        # Calculate intersection length in meters
        intersection = trip_buffer_meters.intersection(segment_meters)

        if intersection.is_empty:
            return False

        intersection_length = intersection.length

        return intersection_length >= min_overlap_meters

    except Exception as e:
        logger.debug(f"Error checking segment overlap: {e}")
        return False


async def find_matching_segments(
    area_id: PydanticObjectId,
    trip_line: LineString,
    area_version: int | None = None,
) -> list[str]:
    """
    Find all street segments that match a trip line.

    Uses MongoDB geospatial query to find candidate segments,
    then uses Shapely for precise intersection testing.

    Returns list of segment_ids that were matched.
    """
    # Create buffered polygon around trip
    trip_buffer_meters, trip_buffer_wgs84, to_meters = buffer_trip_line(trip_line)

    # Use a simple polygon for MongoDB query
    buffer_geom = trip_buffer_wgs84
    if buffer_geom.geom_type == "MultiPolygon":
        buffer_geom = buffer_geom.convex_hull
    elif buffer_geom.geom_type != "Polygon":
        buffer_geom = buffer_geom.envelope

    buffer_coords = list(buffer_geom.exterior.coords)

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
    if area_version is not None:
        query["area_version"] = area_version

    matched_segment_ids = []

    async for street in Street.find(query):
        if check_segment_overlap(street.geometry, trip_buffer_meters, to_meters):
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
        area_versions = {area.id: area.area_version for area in areas}
    else:
        from coverage.models import CoverageArea

        areas = await CoverageArea.find({"_id": {"$in": area_ids}}).to_list()
        area_versions = {area.id: area.area_version for area in areas}

    if not area_ids:
        logger.debug("No areas to match against")
        return {}

    results = {}
    for area_id in area_ids:
        area_version = area_versions.get(area_id)
        if area_version is None:
            continue
        matched = await find_matching_segments(
            area_id,
            trip_line,
            area_version,
        )
        if matched:
            results[area_id] = matched

    return results
