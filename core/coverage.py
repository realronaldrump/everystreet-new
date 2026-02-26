"""Coverage update logic for trips and street segments."""

from __future__ import annotations

import gc
import itertools
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from statistics import median
from typing import TYPE_CHECKING, Any

from beanie import PydanticObjectId
from pymongo import UpdateOne
from shapely.geometry import LineString, MultiLineString, mapping, shape
from shapely.ops import transform
from shapely.strtree import STRtree

from core.date_utils import get_current_utc_time, normalize_to_utc_datetime
from core.spatial import geodesic_distance_meters, get_local_transformers
from core.trip_source_policy import enforce_bouncie_source
from db.models import CoverageArea, CoverageState, Street, Trip
from street_coverage.constants import (
    BACKFILL_BULK_WRITE_SIZE,
    GPS_GAP_MULTIPLIER,
    MATCH_BUFFER_METERS,
    MAX_GPS_GAP_METERS,
    MAX_SEGMENTS_IN_MEMORY,
    MIN_GPS_GAP_METERS,
    MIN_OVERLAP_METERS,
    SHORT_SEGMENT_OVERLAP_RATIO,
)
from street_coverage.stats import apply_area_stats_delta

if TYPE_CHECKING:
    from shapely.geometry.base import BaseGeometry

logger = logging.getLogger(__name__)

BackfillProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]


async def _bulk_write_updates(
    collection: Any,
    updates: list[tuple[dict[str, Any], dict[str, Any], bool]],
    *,
    ordered: bool = False,
) -> tuple[int, int]:
    """Run a batch of update operations efficiently."""
    if not updates:
        return 0, 0

    operations = [UpdateOne(flt, doc, upsert=upsert) for flt, doc, upsert in updates]
    try:
        result = await collection.bulk_write(operations, ordered=ordered)
    except TypeError as exc:
        # pymongo>=4.11 passes `sort=` to UpdateOne bulk internals; older
        # mongomock implementations don't accept this kwarg. Fall back to
        # per-update writes in test environments.
        if "unexpected keyword argument 'sort'" not in str(exc):
            raise
        modified = 0
        upserted = 0
        for flt, doc, upsert in updates:
            single_result = await collection.update_one(flt, doc, upsert=upsert)
            modified += int(getattr(single_result, "modified_count", 0) or 0)
            if getattr(single_result, "upserted_id", None) is not None:
                upserted += 1
        return modified, upserted

    upserted_count = getattr(result, "upserted_count", None)
    if upserted_count is None:
        upserted_count = len(getattr(result, "upserted_ids", {}) or {})
    return int(getattr(result, "modified_count", 0) or 0), int(upserted_count or 0)


@dataclass(frozen=True, slots=True)
class CoverageSegmentsUpdateResult:
    updated: int
    newly_driven_segment_ids: list[str]
    newly_driven_length_miles: float


class AreaSegmentIndex:
    """
    Pre-built spatial index for an area's street segments.

    This provides O(log n) spatial lookups instead of O(n) database
    queries for each trip during backfill operations.
    """

    def __init__(
        self,
        area_id: PydanticObjectId,
        area_version: int | None = None,
    ) -> None:
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

        # Check segment count before loading to prevent memory exhaustion
        segment_count = await Street.find(query).count()
        if segment_count == 0:
            logger.info("No segments found for area %s", self.area_id)
            self._built = True
            return self

        logger.info(
            "Loading %d segments for area %s into spatial index",
            segment_count,
            self.area_id,
        )

        if segment_count > MAX_SEGMENTS_IN_MEMORY:
            msg = (
                f"Area {self.area_id} has {segment_count:,} segments, "
                f"exceeding limit of {MAX_SEGMENTS_IN_MEMORY:,}. "
                "Increase COVERAGE_MAX_SEGMENTS or process in smaller areas."
            )
            logger.error(msg)
            raise MemoryError(msg)

        if segment_count > MAX_SEGMENTS_IN_MEMORY // 2:
            logger.warning(
                "Area %s has %d segments - this may consume significant memory. "
                "Consider splitting into smaller areas if memory issues occur.",
                self.area_id,
                segment_count,
            )

        self.segments = await Street.find(query).to_list()

        if not self.segments:
            self._built = True
            return self

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

        representative_geom = self.segment_geoms[0]
        self.to_meters, self.to_wgs84 = get_local_transformers(representative_geom)

        self.segment_geoms_meters = [
            transform(self.to_meters, g) for g in self.segment_geoms
        ]

        # Index in projected meters space to avoid lon/lat degree distortions.
        self.strtree = STRtree(self.segment_geoms_meters)

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
        *,
        skip_segment_ids: set[str] | None = None,
    ) -> list[str]:
        """
        Find all segments that match a trip line using the spatial index.

        Returns list of segment_ids that were matched.
        """
        if not self._built or not self.strtree or not self.segments:
            return []

        trip_meters = transform(self.to_meters, trip_line)
        trip_buffer_meters = trip_meters.buffer(buffer_meters)
        candidate_indices = self.strtree.query(trip_buffer_meters)

        if len(candidate_indices) == 0:
            return []

        matched_ids = []
        for idx in candidate_indices:
            segment = self.segments[idx]
            if skip_segment_ids and segment.segment_id in skip_segment_ids:
                continue
            segment_meters = self.segment_geoms_meters[idx]

            if not trip_buffer_meters.intersects(segment_meters):
                continue

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


@lru_cache(maxsize=10)
def _get_area_segment_index(
    area_id: PydanticObjectId,
    area_version: int | None = None,
) -> AreaSegmentIndex:
    return AreaSegmentIndex(area_id, area_version)


async def get_area_segment_index(
    area_id: PydanticObjectId,
    area_version: int | None = None,
) -> AreaSegmentIndex:
    index = _get_area_segment_index(area_id, area_version)
    if not index._built:
        await index.build()
    return index


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

    Prefers map-matched geometry (matchedGps) when available because it
    is snapped to the road network and significantly more accurate for
    coverage matching.  Falls back to raw GPS (trip["gps"]) when
    matching was not performed or failed.

    Returns None if trip has no valid geometry.
    """
    # Prefer map-matched geometry — it is snapped to the actual road
    # network so coverage attribution is far more accurate, especially
    # on parallel roads.
    matched_gps = trip.get("matchedGps")
    match_status = trip.get("matchStatus") or ""
    if isinstance(matched_gps, dict) and match_status.startswith("matched"):
        matched_lines = _extract_lines_from_geojson(matched_gps)
        if matched_lines:
            segments: list[LineString] = []
            for line_coords in matched_lines:
                # Map-matched geometry doesn't have GPS gaps so we can
                # use the coordinates directly without gap splitting.
                if len(line_coords) >= 2:
                    segments.append(LineString(line_coords))
            if segments:
                if len(segments) == 1:
                    return segments[0]
                return MultiLineString(segments)

    # Fall back to raw GPS trace.
    geom = trip.get("gps")
    if not isinstance(geom, dict):
        return None

    lines = _extract_lines_from_geojson(geom)
    if not lines:
        return None

    segments_raw: list[LineString] = []
    for line_coords in lines:
        segments_raw.extend(_split_coords_by_gap(line_coords))

    if not segments_raw:
        return None
    if len(segments_raw) == 1:
        return segments_raw[0]
    return MultiLineString(segments_raw)


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
        meets_overlap = intersection_length >= required_overlap

    except Exception:
        logger.debug("Error checking segment overlap")
        return False
    else:
        return meets_overlap


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
    trip_buffer_meters, trip_buffer_wgs84, to_meters = buffer_trip_line(trip_line)

    buffer_geojson = _buffer_to_geojson(trip_buffer_wgs84)
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

    matched_segment_ids = [
        street.segment_id
        async for street in Street.find(query)
        if check_segment_overlap(street.geometry, trip_buffer_meters, to_meters)
    ]

    logger.debug(
        "Found %d matching segments for trip in area %s",
        len(matched_segment_ids),
        area_id,
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

    if area_ids is None:
        minx, miny, maxx, maxy = trip_line.bounds

        areas = await CoverageArea.find(
            {
                "status": "ready",
                "bounding_box.0": {"$lte": maxx},
                "bounding_box.2": {"$gte": minx},
                "bounding_box.1": {"$lte": maxy},
                "bounding_box.3": {"$gte": miny},
            },
        ).to_list()

        area_ids = [area.id for area in areas]
        area_versions = {area.id: area.area_version for area in areas}
    else:
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


async def update_coverage_for_trip(
    trip_data: dict[str, Any],
    trip_id: PydanticObjectId | str | None = None,
) -> int:
    """Update coverage state for a completed trip."""
    if not trip_data:
        return 0

    matches = await match_trip_to_streets(trip_data)

    if not matches:
        logger.debug("Trip did not match any coverage areas")
        return 0

    trip_driven_at = get_trip_driven_at(trip_data)
    trip_oid = _coerce_trip_id(trip_id)

    total_updated = 0
    for area_id, segment_ids in matches.items():
        result = await update_coverage_for_segments(
            area_id=area_id,
            segment_ids=segment_ids,
            trip_id=trip_oid,
            driven_at=trip_driven_at,
        )
        total_updated += result.updated

    logger.info(
        "Trip coverage updated %s segments across %s areas",
        total_updated,
        len(matches),
    )
    return total_updated


async def update_coverage_for_segments(
    area_id: PydanticObjectId,
    segment_ids: list[str],
    trip_id: PydanticObjectId | None = None,
    driven_at: datetime | str | None = None,
) -> CoverageSegmentsUpdateResult:
    """
    Mark segments as driven for an area.

    Uses bulk operations for efficiency. Returns the number of segments
    updated and which segments were newly driven.
    """
    if not segment_ids:
        return CoverageSegmentsUpdateResult(
            updated=0,
            newly_driven_segment_ids=[],
            newly_driven_length_miles=0.0,
        )

    # De-dupe but keep stable order for predictable behavior and smaller writes.
    segment_ids = list(dict.fromkeys(segment_ids))

    area = await CoverageArea.get(area_id)
    if not area:
        return CoverageSegmentsUpdateResult(
            updated=0,
            newly_driven_segment_ids=[],
            newly_driven_length_miles=0.0,
        )

    length_by_segment: dict[str, float] = {}
    streets = await Street.find(
        {
            "area_id": area_id,
            "area_version": area.area_version,
            "segment_id": {"$in": segment_ids},
        },
    ).to_list()
    length_by_segment = {
        str(street.segment_id): float(street.length_miles or 0.0) for street in streets
    }
    # Ignore unknown segment IDs to avoid inflating coverage counters.
    segment_ids = [sid for sid in segment_ids if sid in length_by_segment]

    if not segment_ids:
        return CoverageSegmentsUpdateResult(
            updated=0,
            newly_driven_segment_ids=[],
            newly_driven_length_miles=0.0,
        )

    states = await CoverageState.find(
        {
            "area_id": area_id,
            "segment_id": {"$in": segment_ids},
            "status": {"$in": ["driven", "undriveable"]},
        },
    ).to_list()
    undriveable_ids = {s.segment_id for s in states if s.status == "undriveable"}
    if undriveable_ids:
        segment_ids = [sid for sid in segment_ids if sid not in undriveable_ids]

    if not segment_ids:
        return CoverageSegmentsUpdateResult(
            updated=0,
            newly_driven_segment_ids=[],
            newly_driven_length_miles=0.0,
        )

    # Determine which segments are newly driven so we can update cached stats
    # without a full recompute.
    driven_ids = {s.segment_id for s in states if s.status == "driven"}
    newly_driven_ids = [sid for sid in segment_ids if sid not in driven_ids]

    driven_at = normalize_to_utc_datetime(driven_at) or get_current_utc_time()

    collection = CoverageState.get_pymongo_collection()
    updates = [
        (
            {"area_id": area_id, "segment_id": segment_id},
            {
                "$set": {"status": "driven"},
                "$max": {"last_driven_at": driven_at},
                "$min": {"first_driven_at": driven_at},
                "$setOnInsert": {
                    "area_id": area_id,
                    "segment_id": segment_id,
                    "manually_marked": False,
                },
            },
            True,
        )
        for segment_id in segment_ids
    ]
    modified, upserted = await _bulk_write_updates(collection, updates, ordered=False)
    updated = modified + upserted

    # Only associate a trip with the segment if this update sets the most recent
    # last_driven_at value. This preserves driven_by_trip_id for out-of-order trips.
    if trip_id is not None and segment_ids:
        trip_updates = [
            (
                {
                    "area_id": area_id,
                    "segment_id": segment_id,
                    "last_driven_at": driven_at,
                },
                {"$set": {"driven_by_trip_id": trip_id}},
                False,
            )
            for segment_id in segment_ids
        ]
        if trip_updates:
            await _bulk_write_updates(collection, trip_updates, ordered=False)

    if updated:
        logger.debug(
            "Updated %d segments for area %s",
            updated,
            area_id,
        )

    newly_driven_length = 0.0
    # Sum lengths for newly driven segments to update cached area stats.
    if newly_driven_ids:
        newly_driven_length = sum(
            length_by_segment.get(segment_id, 0.0) for segment_id in newly_driven_ids
        )
        await apply_area_stats_delta(
            area_id,
            driven_segments_delta=len(newly_driven_ids),
            driven_length_miles_delta=newly_driven_length,
        )

    return CoverageSegmentsUpdateResult(
        updated=updated,
        newly_driven_segment_ids=newly_driven_ids,
        newly_driven_length_miles=newly_driven_length,
    )


async def mark_segment_undriveable(
    area_id: PydanticObjectId,
    segment_id: str,
) -> bool:
    """Mark a segment as undriveable (e.g., highway, private road)."""
    street = await Street.find_one({"area_id": area_id, "segment_id": segment_id})
    if not street:
        return False

    length_miles = float(street.length_miles or 0.0)

    existing = await CoverageState.find_one(
        {"area_id": area_id, "segment_id": segment_id},
    )
    previous_status = existing.status if existing else "undriven"

    if existing and previous_status == "undriveable":
        # Ensure the manual flag is set, but no stats change needed.
        existing.manually_marked = True
        existing.marked_at = datetime.now(UTC)
        await existing.save()
        return True

    if existing:
        existing.status = "undriveable"
        existing.last_driven_at = None
        existing.first_driven_at = None
        existing.driven_by_trip_id = None
        existing.manually_marked = True
        existing.marked_at = datetime.now(UTC)
        await existing.save()
    else:
        state = CoverageState(
            area_id=area_id,
            segment_id=segment_id,
            status="undriveable",
            manually_marked=True,
            marked_at=datetime.now(UTC),
        )
        await state.insert()

    driven_delta = -1 if previous_status == "driven" else 0
    driven_len_delta = -length_miles if previous_status == "driven" else 0.0

    await apply_area_stats_delta(
        area_id,
        driven_segments_delta=driven_delta,
        driven_length_miles_delta=driven_len_delta,
        undriveable_segments_delta=1,
        undriveable_length_miles_delta=length_miles,
    )

    return True


async def mark_segment_undriven(
    area_id: PydanticObjectId,
    segment_id: str,
) -> bool:
    """Reset a segment to undriven state."""
    street = await Street.find_one({"area_id": area_id, "segment_id": segment_id})
    if not street:
        return False

    length_miles = float(street.length_miles or 0.0)

    existing = await CoverageState.find_one(
        {"area_id": area_id, "segment_id": segment_id},
    )

    if not existing:
        # Missing state implies undriven already.
        return True

    previous_status = existing.status
    await existing.delete()

    driven_delta = -1 if previous_status == "driven" else 0
    driven_len_delta = -length_miles if previous_status == "driven" else 0.0

    undriveable_delta = -1 if previous_status == "undriveable" else 0
    undriveable_len_delta = -length_miles if previous_status == "undriveable" else 0.0

    if driven_delta or undriveable_delta:
        await apply_area_stats_delta(
            area_id,
            driven_segments_delta=driven_delta,
            driven_length_miles_delta=driven_len_delta,
            undriveable_segments_delta=undriveable_delta,
            undriveable_length_miles_delta=undriveable_len_delta,
        )

    return True


async def backfill_coverage_for_area(
    area_id: PydanticObjectId,
    since: datetime | None = None,
    progress_callback: BackfillProgressCallback | None = None,
    progress_interval: int = 100,
    progress_time_seconds: float = 0.5,
) -> int:
    """
    Backfill coverage for an area based on historical trips.

    Returns number of segments updated.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        return 0

    # Ingestion calls backfill before marking an area "ready", so allow it for
    # in-progress states as long as segments exist.
    allowed_statuses = {"ready", "initializing", "rebuilding"}
    if area.status not in allowed_statuses:
        logger.warning(
            "Skipping backfill for area %s: status=%s",
            area.display_name,
            area.status,
        )
        return 0

    segment_index = await get_area_segment_index(area_id, area.area_version)

    processed_trips = 0
    matched_trips = 0
    last_reported_time = time.time()

    # Track per-segment first/last driven timestamps (and the most-recent trip id).
    segment_first: dict[str, datetime] = {}
    segment_last: dict[str, datetime] = {}
    segment_last_trip: dict[str, PydanticObjectId] = {}

    undriveable_states = await CoverageState.find(
        {"area_id": area_id, "status": "undriveable"},
    ).to_list()
    undriveable_ids = {state.segment_id for state in undriveable_states}

    async def report_progress(
        *,
        total_trips: int | None = None,
        force: bool = False,
    ) -> None:
        nonlocal last_reported_time
        if not progress_callback:
            return

        now = time.time()
        if (
            not force
            and processed_trips % progress_interval != 0
            and now - last_reported_time < progress_time_seconds
        ):
            return

        payload = {
            "area_id": str(area_id),
            "processed_trips": processed_trips,
            "total_trips": total_trips,
            "matched_trips": matched_trips,
            "segments_updated": len(segment_first),
            "stage": "matching",
        }
        await progress_callback(payload)
        last_reported_time = now

    gps_filter: dict[str, Any] = {"$ne": None}
    if (
        isinstance(area.bounding_box, list)
        and len(area.bounding_box) == 4
        and all(isinstance(v, int | float) for v in area.bounding_box)
    ):
        min_lon, min_lat, max_lon, max_lat = map(float, area.bounding_box)
        bbox_polygon = {
            "type": "Polygon",
            "coordinates": [
                [
                    [min_lon, min_lat],
                    [max_lon, min_lat],
                    [max_lon, max_lat],
                    [min_lon, max_lat],
                    [min_lon, min_lat],
                ],
            ],
        }
        # Mongo expects a pure geospatial clause for this field predicate.
        gps_filter = {"$geoIntersects": {"$geometry": bbox_polygon}}

    query: dict[str, Any] = {
        "gps": gps_filter,
        "invalid": {"$ne": True},
    }
    if since:
        query["endTime"] = {"$gte": since}
    query = enforce_bouncie_source(query)

    total_trip_count = await Trip.find(query).count()

    logger.info(
        "Processing %d trips for area %s",
        total_trip_count,
        area.display_name,
    )
    await report_progress(total_trips=total_trip_count, force=True)

    cursor = Trip.find(query).sort([("endTime", 1), ("_id", 1)])
    async for trip in cursor:
        processed_trips += 1
        trip_data = trip.model_dump()
        trip_line = trip_to_linestring(trip_data)
        if trip_line is None:
            await report_progress(total_trips=total_trip_count)
            continue

        trip_time = get_trip_driven_at(trip_data)
        if trip_time is None:
            await report_progress(total_trips=total_trip_count)
            continue

        matched_segment_ids = segment_index.find_matching_segments(trip_line)
        if not matched_segment_ids:
            await report_progress(total_trips=total_trip_count)
            continue

        matched_trips += 1

        for segment_id in matched_segment_ids:
            if segment_id in undriveable_ids:
                continue

            existing_first = segment_first.get(segment_id)
            if existing_first is None or trip_time < existing_first:
                segment_first[segment_id] = trip_time

            existing_last = segment_last.get(segment_id)
            if existing_last is None or trip_time > existing_last:
                segment_last[segment_id] = trip_time
                if trip.id is not None:
                    segment_last_trip[segment_id] = trip.id

        await report_progress(total_trips=total_trip_count)

        # Periodic garbage collection to reduce peak memory when scanning
        # large trip histories.
        if processed_trips % (progress_interval * 10) == 0:
            gc.collect()

    if not segment_first:
        logger.info(
            "Backfill found no matching segments for area %s",
            area.display_name,
        )
        await report_progress(total_trips=total_trip_count, force=True)
        return 0

    segments_to_update = list(segment_first.keys())
    logger.info(
        "Backfill matching complete for area %s: %d segments from %d trips",
        area.display_name,
        len(segments_to_update),
        matched_trips,
    )

    # Determine which segments are newly driven for stats deltas.
    driven_states = await CoverageState.find(
        {
            "area_id": area_id,
            "segment_id": {"$in": segments_to_update},
            "status": "driven",
        },
    ).to_list()
    existing_driven = {s.segment_id for s in driven_states}
    newly_driven_ids = [sid for sid in segments_to_update if sid not in existing_driven]

    # Bulk upsert coverage state with accurate first/last driven timestamps.
    collection = CoverageState.get_pymongo_collection()
    operations: list[tuple[dict[str, Any], dict[str, Any], bool]] = []
    trip_updates: list[tuple[dict[str, Any], dict[str, Any], bool]] = []

    for segment_id in segments_to_update:
        first_at = segment_first[segment_id]
        last_at = segment_last.get(segment_id, first_at)

        operations.append(
            (
                {"area_id": area_id, "segment_id": segment_id},
                {
                    "$set": {"status": "driven"},
                    "$max": {"last_driven_at": last_at},
                    "$min": {"first_driven_at": first_at},
                    "$setOnInsert": {
                        "area_id": area_id,
                        "segment_id": segment_id,
                        "manually_marked": False,
                    },
                },
                True,
            ),
        )

        last_trip_id = segment_last_trip.get(segment_id)
        if last_trip_id is not None:
            trip_updates.append(
                (
                    {
                        "area_id": area_id,
                        "segment_id": segment_id,
                        "last_driven_at": last_at,
                    },
                    {"$set": {"driven_by_trip_id": last_trip_id}},
                    False,
                ),
            )

        if len(operations) >= BACKFILL_BULK_WRITE_SIZE:
            await _bulk_write_updates(collection, operations, ordered=False)
            operations = []

    if operations:
        await _bulk_write_updates(collection, operations, ordered=False)

    if trip_updates:
        # Run in a second pass so last_driven_at is settled before we bind trip ids.
        for i in range(0, len(trip_updates), BACKFILL_BULK_WRITE_SIZE):
            chunk = trip_updates[i : i + BACKFILL_BULK_WRITE_SIZE]
            await _bulk_write_updates(collection, chunk, ordered=False)

    newly_driven_length = 0.0
    if newly_driven_ids:
        streets = await Street.find(
            {
                "area_id": area_id,
                "area_version": area.area_version,
                "segment_id": {"$in": newly_driven_ids},
            },
        ).to_list()
        newly_driven_length = sum(s.length_miles or 0.0 for s in streets)
        await apply_area_stats_delta(
            area_id,
            driven_segments_delta=len(newly_driven_ids),
            driven_length_miles_delta=newly_driven_length,
        )

    await report_progress(total_trips=total_trip_count, force=True)

    logger.info(
        "Backfill complete for area %s: %d segments updated (%d newly driven), %.2f mi",
        area.display_name,
        len(segments_to_update),
        len(newly_driven_ids),
        newly_driven_length,
    )

    # Return the number of segments that were newly marked driven.
    return len(newly_driven_ids)


def get_trip_driven_at(trip_data: dict[str, Any] | None) -> datetime | None:
    if not trip_data:
        return None

    driven_at = (
        trip_data.get("endTime")
        or trip_data.get("startTime")
        or trip_data.get("lastUpdate")
    )
    return normalize_to_utc_datetime(driven_at)


def _coerce_trip_id(trip_id: PydanticObjectId | str | None) -> PydanticObjectId | None:
    if trip_id is None or isinstance(trip_id, PydanticObjectId):
        return trip_id
    try:
        return PydanticObjectId(str(trip_id))
    except Exception:
        logger.warning("Ignoring invalid trip_id for coverage update: %r", trip_id)
        return None
