"""
Trip-to-street matching logic.

This module handles the geometric intersection between trip GPS traces
and street segments to determine which segments have been driven.
"""

from __future__ import annotations

import itertools
import logging
from statistics import median
from typing import TYPE_CHECKING, Any

from shapely.geometry import LineString, MultiLineString, mapping, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree

from coverage.constants import (
    GPS_GAP_MULTIPLIER,
    MATCH_BUFFER_METERS,
    MAX_GPS_GAP_METERS,
    MIN_GPS_GAP_METERS,
    MIN_OVERLAP_METERS,
    SHORT_SEGMENT_OVERLAP_RATIO,
)
from coverage.geo_utils import geodesic_distance_meters, get_local_transformers
from coverage.models import Street

if TYPE_CHECKING:
    from beanie import PydanticObjectId
    from shapely.geometry.base import BaseGeometry

logger = logging.getLogger(__name__)


class AreaSegmentIndex:
    """
    Pre-built spatial index for an area's street segments.

    This provides O(log n) spatial lookups instead of O(n) database queries
    for each trip during backfill operations.
    """

    def __init__(self, area_id: PydanticObjectId, area_version: int | None = None):
        self.area_id = area_id
        self.area_version = area_version
        self.segments: list[Street] = []
        self.segment_geoms: list[BaseGeometry] = []
        self.segment_geoms_meters: list[BaseGeometry] = []
        self.strtree: STRtree | None = None
        self.to_meters = None
        self.to_wgs84 = None
        self._built = False

    async def build(self) -> AreaSegmentIndex:
        """Load all segments and build STRtree index."""
        query: dict[str, Any] = {"area_id": self.area_id}
        if self.area_version is not None:
            query["area_version"] = self.area_version

        self.segments = await Street.find(query).to_list()

        if not self.segments:
            self._built = True
            return self

        # Parse geometries
        self.segment_geoms = []
        valid_segments = []
        for seg in self.segments:
            try:
                geom = shape(seg.geometry)
                if geom.is_valid and not geom.is_empty:
                    self.segment_geoms.append(geom)
                    valid_segments.append(seg)
            except Exception:
                continue

        self.segments = valid_segments

        if not self.segment_geoms:
            self._built = True
            return self

        # Get transformers from the centroid of the first geometry
        representative_geom = self.segment_geoms[0]
        self.to_meters, self.to_wgs84 = get_local_transformers(representative_geom)

        # Pre-transform all geometries to meters for accurate intersection
        self.segment_geoms_meters = [
            transform(self.to_meters, g) for g in self.segment_geoms
        ]

        # Build STRtree on WGS84 geometries for spatial indexing
        self.strtree = STRtree(self.segment_geoms)

        self._built = True
        logger.info(
            "Built spatial index for area %s with %d segments",
            self.area_id,
            len(self.segments),
        )
        return self

    def find_matching_segments(
        self,
        trip_line: BaseGeometry,
        buffer_meters: float = MATCH_BUFFER_METERS,
        min_overlap_meters: float = MIN_OVERLAP_METERS,
        short_segment_ratio: float = SHORT_SEGMENT_OVERLAP_RATIO,
    ) -> list[str]:
        """
        Find all segments that match a trip line using the spatial index.

        Returns list of segment_ids that were matched.
        """
        if not self._built or not self.strtree or not self.segments:
            return []

        # Create buffered trip geometry
        trip_buffer_wgs84 = trip_line.buffer(buffer_meters / 111139)  # approx degrees

        # Use STRtree to find candidates (O(log n))
        candidate_indices = self.strtree.query(trip_buffer_wgs84)

        if len(candidate_indices) == 0:
            return []

        # Transform trip to meters for accurate intersection
        trip_meters = transform(self.to_meters, trip_line)
        trip_buffer_meters = trip_meters.buffer(buffer_meters)

        matched_ids = []
        for idx in candidate_indices:
            segment = self.segments[idx]
            segment_meters = self.segment_geoms_meters[idx]

            # Check actual intersection
            if not trip_buffer_meters.intersects(segment_meters):
                continue

            # Calculate intersection length
            try:
                intersection = trip_buffer_meters.intersection(segment_meters)
                if intersection.is_empty:
                    continue

                intersection_length = intersection.length
                segment_length = segment_meters.length

                if segment_length <= 0:
                    continue

                required_overlap = min(
                    min_overlap_meters,
                    segment_length * short_segment_ratio,
                )

                if intersection_length >= required_overlap:
                    matched_ids.append(segment.segment_id)
            except Exception:
                continue

        return matched_ids

    def find_matching_segments_batch(
        self,
        trip_lines: list[BaseGeometry],
        buffer_meters: float = MATCH_BUFFER_METERS,
        min_overlap_meters: float = MIN_OVERLAP_METERS,
        short_segment_ratio: float = SHORT_SEGMENT_OVERLAP_RATIO,
    ) -> set[str]:
        """
        Find all segments that match ANY of the given trip lines.

        Uses per-trip STRtree queries - avoids expensive geometry union.
        Returns set of segment_ids that were matched.
        """
        if not self._built or not self.strtree or not self.segments:
            return set()

        buffer_degrees = buffer_meters / 111139  # approx conversion
        matched_ids: set[str] = set()

        # Match each trip individually - faster than union + single query
        for trip_line in trip_lines:
            if trip_line is None or trip_line.is_empty:
                continue

            # Buffer the trip line
            trip_buffer = trip_line.buffer(buffer_degrees)

            # Query STRtree for candidates
            candidate_indices = self.strtree.query(trip_buffer)

            # Check each candidate
            for idx in candidate_indices:
                segment_id = self.segments[idx].segment_id
                if segment_id in matched_ids:
                    continue  # Already matched
                segment_geom = self.segment_geoms[idx]
                if trip_buffer.intersects(segment_geom):
                    matched_ids.add(segment_id)

        return matched_ids


def _coerce_coord_pair(value: Any) -> list[float] | None:
    if isinstance(value, dict):
        lon = value.get("lon")
        if lon is None:
            lon = value.get("lng")
        lat = value.get("lat")
    else:
        if not isinstance(value, list | tuple) or len(value) < 2:
            return None
        lon, lat = value[0], value[1]

    try:
        lon_f = float(lon)
        lat_f = float(lat)
    except (TypeError, ValueError):
        return None

    if not (-180 <= lon_f <= 180 and -90 <= lat_f <= 90):
        return None

    return [lon_f, lat_f]


def _normalize_coords(coords: list[Any]) -> list[list[float]]:
    normalized = []
    for coord in coords:
        pair = _coerce_coord_pair(coord)
        if pair is None:
            continue
        if not normalized or pair != normalized[-1]:
            normalized.append(pair)
    return normalized


def _extract_lines_from_geojson(
    geom: dict[str, Any],
) -> list[list[list[float]]] | None:
    geom_type = geom.get("type")
    coords = geom.get("coordinates")
    if geom_type == "LineString":
        if not isinstance(coords, list):
            return None
        normalized = _normalize_coords(coords)
        return [normalized] if len(normalized) >= 2 else None
    if geom_type == "MultiLineString":
        if not isinstance(coords, list):
            return None
        lines: list[list[list[float]]] = []
        for line_coords in coords:
            if not isinstance(line_coords, list):
                continue
            normalized = _normalize_coords(line_coords)
            if len(normalized) >= 2:
                lines.append(normalized)
        return lines if lines else None
    return None


def _adaptive_gap_threshold(distances: list[float]) -> float:
    if not distances:
        return MIN_GPS_GAP_METERS
    typical = median(distances)
    threshold = max(MIN_GPS_GAP_METERS, typical * GPS_GAP_MULTIPLIER)
    return min(threshold, MAX_GPS_GAP_METERS)


def _split_coords_by_gap(coords: list[list[float]]) -> list[LineString]:
    if len(coords) < 2:
        return []
    distances = [
        geodesic_distance_meters(prev[0], prev[1], curr[0], curr[1])
        for prev, curr in itertools.pairwise(coords)
    ]
    gap_threshold = _adaptive_gap_threshold(distances)

    segments: list[LineString] = []
    current: list[list[float]] = [coords[0]]
    for prev, curr in itertools.pairwise(coords):
        gap = geodesic_distance_meters(prev[0], prev[1], curr[0], curr[1])
        if gap > gap_threshold:
            if len(current) >= 2:
                segments.append(LineString(current))
            current = [curr]
        else:
            current.append(curr)

    if len(current) >= 2:
        segments.append(LineString(current))

    return segments


def trip_to_linestring(trip: dict[str, Any]) -> BaseGeometry | None:
    """
    Convert a trip document to a Shapely LineString/MultiLineString.

    Handles both GeoJSON geometry and raw coordinate arrays. Returns
    None if trip has no valid geometry.
    """
    lines = None
    # Prefer matched geometry when available
    if "matchedGps" in trip and isinstance(trip["matchedGps"], dict):
        lines = _extract_lines_from_geojson(trip["matchedGps"])

    # Try GeoJSON geometry next
    if lines is None and "gps" in trip and isinstance(trip["gps"], dict):
        geom = trip["gps"]
        lines = _extract_lines_from_geojson(geom)

    # Try raw coordinates array
    if lines is None and "coordinates" in trip:
        raw_coords = trip["coordinates"]
        if isinstance(raw_coords, list):
            coords = _normalize_coords(raw_coords)
            if len(coords) >= 2:
                lines = [coords]

    # Try locations array (from live tracking)
    if lines is None and "locations" in trip:
        locs = trip["locations"]
        if isinstance(locs, list):
            coords = _normalize_coords(locs)
            if len(coords) >= 2:
                lines = [coords]

    if not lines:
        return None

    segments: list[LineString] = []
    for line_coords in lines:
        segments.extend(_split_coords_by_gap(line_coords))

    if not segments:
        return None
    if len(segments) == 1:
        return segments[0]
    return MultiLineString(segments)


def buffer_trip_line(
    trip_line: BaseGeometry,
    buffer_meters: float = MATCH_BUFFER_METERS,
) -> tuple[Any, Any, Any]:
    """
    Create buffer polygons around a trip line.

    Returns (buffer_meters_geom, buffer_wgs84_geom,
    to_meters_transform).
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
    short_segment_ratio: float = SHORT_SEGMENT_OVERLAP_RATIO,
) -> bool:
    """
    Check if a street segment overlaps sufficiently with a trip buffer.

    Returns True if the segment intersects the buffer and the
    intersection length meets the minimum overlap threshold.
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
        segment_length = segment_meters.length
        if segment_length <= 0:
            return False

        required_overlap = min(
            min_overlap_meters,
            segment_length * short_segment_ratio,
        )

        return intersection_length >= required_overlap

    except Exception as e:
        logger.debug(f"Error checking segment overlap: {e}")
        return False


def _buffer_to_geojson(buffer_geom: BaseGeometry) -> dict[str, Any] | None:
    if buffer_geom.is_empty:
        return None
    if buffer_geom.geom_type not in ("Polygon", "MultiPolygon"):
        buffer_geom = buffer_geom.envelope
    return mapping(buffer_geom)


async def find_matching_segments(
    area_id: PydanticObjectId,
    trip_line: BaseGeometry,
    area_version: int | None = None,
) -> list[str]:
    """
    Find all street segments that match a trip line.

    Uses MongoDB geospatial query to find candidate segments, then uses
    Shapely for precise intersection testing.

    Returns list of segment_ids that were matched.
    """
    # Create buffered polygon around trip
    trip_buffer_meters, trip_buffer_wgs84, to_meters = buffer_trip_line(trip_line)

    # Use a simple polygon for MongoDB query
    buffer_geom = trip_buffer_wgs84
    buffer_geojson = _buffer_to_geojson(buffer_geom)
    if buffer_geojson is None:
        return []

    query = {
        "area_id": area_id,
        "geometry": {
            "$geoIntersects": {
                "$geometry": {
                    "type": buffer_geojson["type"],
                    "coordinates": buffer_geojson["coordinates"],
                },
            },
        },
    }
    if area_version is not None:
        query["area_version"] = area_version

    matched_segment_ids = []

    async for street in Street.find(query):
        if check_segment_overlap(street.geometry, trip_buffer_meters, to_meters):
            matched_segment_ids.append(street.segment_id)

    logger.debug(
        f"Found {len(matched_segment_ids)} matching segments for trip in area {area_id}",
    )

    return matched_segment_ids


async def match_trip_to_streets(
    trip: dict[str, Any],
    area_ids: list[PydanticObjectId] | None = None,
) -> dict[PydanticObjectId, list[str]]:
    """
    Match a trip to streets in one or more areas.

    If area_ids is None, matches against all ready areas that intersect
    the trip's bounding box.

    Returns dict mapping area_id -> list of matched segment_ids.
    """
    trip_line = trip_to_linestring(trip)
    if trip_line is None:
        logger.warning("Trip has no valid geometry, skipping matching")
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
            },
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
