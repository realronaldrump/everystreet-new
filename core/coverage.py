"""Coverage update logic for trips and street segments."""

from __future__ import annotations

import itertools
import logging
import time
from collections.abc import Awaitable, Callable
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
from db.models import CoverageArea, CoverageState, Street, Trip
from street_coverage.constants import (
    BACKFILL_BULK_WRITE_SIZE,
    BACKFILL_TRIP_BATCH_SIZE,
    GPS_GAP_MULTIPLIER,
    MATCH_BUFFER_METERS,
    MAX_GPS_GAP_METERS,
    MIN_GPS_GAP_METERS,
    MIN_OVERLAP_METERS,
    SHORT_SEGMENT_OVERLAP_RATIO,
)
from street_coverage.stats import update_area_stats

if TYPE_CHECKING:
    from shapely.geometry.base import BaseGeometry

logger = logging.getLogger(__name__)

BackfillProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]


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

        trip_buffer_wgs84 = trip_line.buffer(buffer_meters / 111139)
        candidate_indices = self.strtree.query(trip_buffer_wgs84)

        if len(candidate_indices) == 0:
            return []

        trip_meters = transform(self.to_meters, trip_line)
        trip_buffer_meters = trip_meters.buffer(buffer_meters)

        matched_ids = []
        for idx in candidate_indices:
            segment = self.segments[idx]
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

        matched_ids: set[str] = set()

        for trip_line in trip_lines:
            if trip_line is None or trip_line.is_empty:
                continue

            trip_buffer_wgs84 = trip_line.buffer(buffer_meters / 111139)
            trip_meters = transform(self.to_meters, trip_line)
            trip_buffer_meters = trip_meters.buffer(buffer_meters)

            candidate_indices = self.strtree.query(trip_buffer_wgs84)

            for idx in candidate_indices:
                segment_id = self.segments[idx].segment_id
                if segment_id in matched_ids:
                    continue
                segment_meters = self.segment_geoms_meters[idx]
                if not trip_buffer_meters.intersects(segment_meters):
                    continue

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
                    matched_ids.add(segment_id)

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
        if not isinstance(value, (list, tuple)) or len(value) < 2:
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
    if "matchedGps" in trip and isinstance(trip["matchedGps"], dict):
        lines = _extract_lines_from_geojson(trip["matchedGps"])

    if lines is None and "gps" in trip and isinstance(trip["gps"], dict):
        geom = trip["gps"]
        lines = _extract_lines_from_geojson(geom)

    if lines is None and "coordinates" in trip:
        raw_coords = trip["coordinates"]
        if isinstance(raw_coords, list):
            coords = _normalize_coords(raw_coords)
            if len(coords) >= 2:
                lines = [coords]

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

    total_updated = 0
    for area_id, segment_ids in matches.items():
        updated = await update_coverage_for_segments(
            area_id=area_id,
            segment_ids=segment_ids,
            trip_id=(
                PydanticObjectId(trip_id) if isinstance(trip_id, str) else trip_id
            ),
            driven_at=trip_driven_at,
        )
        total_updated += updated
        await update_area_stats(area_id)

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
) -> int:
    """
    Mark segments as driven for an area.

    Uses bulk operations for efficiency. Returns the number of segments
    updated.
    """
    if not segment_ids:
        return 0

    undriveable_states = await CoverageState.find(
        {
            "area_id": area_id,
            "segment_id": {"$in": segment_ids},
            "status": "undriveable",
        },
    ).to_list()
    undriveable_ids = {state.segment_id for state in undriveable_states}
    if undriveable_ids:
        segment_ids = [sid for sid in segment_ids if sid not in undriveable_ids]

    if not segment_ids:
        return 0

    driven_at = normalize_to_utc_datetime(driven_at) or get_current_utc_time()

    operations = []
    for segment_id in segment_ids:
        update_pipeline = [
            {
                "$set": {
                    "status": "driven",
                    "last_driven_at": driven_at,
                    "first_driven_at": {
                        "$let": {
                            "vars": {"existing": "$first_driven_at"},
                            "in": {
                                "$cond": [
                                    {
                                        "$or": [
                                            {"$eq": ["$$existing", None]},
                                            {"$gt": ["$$existing", driven_at]},
                                        ],
                                    },
                                    driven_at,
                                    "$$existing",
                                ],
                            },
                        },
                    },
                    "driven_by_trip_id": trip_id,
                    "area_id": area_id,
                    "segment_id": segment_id,
                    "manually_marked": {"$ifNull": ["$manually_marked", False]},
                },
            },
        ]
        operations.append(
            UpdateOne(
                {"area_id": area_id, "segment_id": segment_id},
                update_pipeline,
                upsert=True,
            ),
        )

    updated = 0
    if operations:
        collection = CoverageState.get_motor_collection()
        result = await collection.bulk_write(operations, ordered=False)
        upserted_count = getattr(result, "upserted_count", None)
        if upserted_count is None:
            upserted_count = len(getattr(result, "upserted_ids", {}) or {})
        updated = result.modified_count + upserted_count

    if updated:
        logger.debug(
            "Updated %d segments for area %s",
            updated,
            area_id,
        )

    return updated


async def mark_segment_undriveable(
    area_id: PydanticObjectId,
    segment_id: str,
) -> bool:
    """Mark a segment as undriveable (e.g., highway, private road)."""
    result = await CoverageState.find_one(
        {"area_id": area_id, "segment_id": segment_id},
    )

    if result:
        result.status = "undriveable"
        result.manually_marked = True
        result.marked_at = datetime.now(UTC)
        await result.save()
        return True

    state = CoverageState(
        area_id=area_id,
        segment_id=segment_id,
        status="undriveable",
        manually_marked=True,
        marked_at=datetime.now(UTC),
    )
    await state.insert()
    return True


async def mark_segment_undriven(
    area_id: PydanticObjectId,
    segment_id: str,
) -> bool:
    """Reset a segment to undriven state."""
    result = await CoverageState.find_one(
        {"area_id": area_id, "segment_id": segment_id},
    )

    if result:
        result.status = "undriven"
        result.last_driven_at = None
        result.first_driven_at = None
        result.driven_by_trip_id = None
        result.manually_marked = True
        result.marked_at = datetime.now(UTC)
        await result.save()
        return True

    return False


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

    if area.status != "ready":
        logger.warning(
            "Skipping backfill for area %s: status=%s",
            area.display_name,
            area.status,
        )
        return 0

    segment_index = await get_area_segment_index(area_id, area.area_version)

    processed_trips = 0
    total_updated = 0
    matched_batches = 0
    last_reported_time = time.time()

    async def report_progress(
        *,
        total_trips: int | None = None,
        segments_found: int | None = None,
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
            "segments_found": segments_found,
            "stage": "matching",
        }
        await progress_callback(payload)
        last_reported_time = now

    query: dict[str, Any] = {
        "gps": {"$ne": None},
        "invalid": {"$ne": True},
    }
    if since:
        query["endTime"] = {"$gte": since}

    total_trip_count = await Trip.find(query).count()
    logger.info(
        "Processing %d trips for area %s in batches of %d",
        total_trip_count,
        area.display_name,
        BACKFILL_TRIP_BATCH_SIZE,
    )
    await report_progress(total_trips=total_trip_count, force=True)

    mega_batch_size = 50
    all_matched_segments: set[str] = set()
    total_line_count = 0
    earliest_driven_at: datetime | None = None
    skip = 0

    while True:
        batch = (
            await Trip.find(query).skip(skip).limit(BACKFILL_TRIP_BATCH_SIZE).to_list()
        )
        if not batch:
            break

        batch_lines: list[Any] = []
        for trip in batch:
            trip_data = trip.model_dump()
            line = trip_to_linestring(trip_data)
            if line is not None:
                batch_lines.append(line)
                total_line_count += 1
                trip_time = get_trip_driven_at(trip_data)
                if trip_time and (
                    earliest_driven_at is None or trip_time < earliest_driven_at
                ):
                    earliest_driven_at = trip_time

        for batch_start in range(0, len(batch_lines), mega_batch_size):
            batch_end = min(batch_start + mega_batch_size, len(batch_lines))
            batch_lines_slice = batch_lines[batch_start:batch_end]
            if not batch_lines_slice:
                continue
            matched = segment_index.find_matching_segments_batch(batch_lines_slice)
            all_matched_segments.update(matched)
            matched_batches += 1
            await report_progress(
                total_trips=total_trip_count,
                segments_found=len(all_matched_segments),
            )

        processed_trips += len(batch)
        skip += len(batch)
        await report_progress(total_trips=total_trip_count)

    logger.info(
        "Converted %d/%d trips to valid geometries",
        total_line_count,
        total_trip_count,
    )

    if not total_line_count:
        logger.warning("No valid trip geometries found for area %s", area.display_name)
        await update_area_stats(area_id)
        return 0

    logger.info(
        "Batch matching complete: %d segments matched from %d trips",
        len(all_matched_segments),
        total_line_count,
    )

    if all_matched_segments:
        logger.info(
            "Bulk updating %d segments for area %s",
            len(all_matched_segments),
            area.display_name,
        )

        undriveable_states = await CoverageState.find(
            {"area_id": area_id, "status": "undriveable"},
        ).to_list()
        undriveable_ids = {state.segment_id for state in undriveable_states}

        segments_to_update = all_matched_segments - undriveable_ids

        driven_at = earliest_driven_at or get_current_utc_time()

        operations = []
        for seg_id in segments_to_update:
            operations.append(
                UpdateOne(
                    {"area_id": area_id, "segment_id": seg_id},
                    {
                        "$set": {
                            "status": "driven",
                            "last_driven_at": driven_at,
                        },
                        "$min": {"first_driven_at": driven_at},
                        "$setOnInsert": {
                            "area_id": area_id,
                            "segment_id": seg_id,
                            "manually_marked": False,
                            "driven_by_trip_id": None,
                        },
                    },
                    upsert=True,
                ),
            )

            if len(operations) >= BACKFILL_BULK_WRITE_SIZE:
                collection = CoverageState.get_pymongo_collection()
                result = await collection.bulk_write(operations, ordered=False)
                total_updated += result.modified_count + result.upserted_count
                operations = []
                await report_progress(
                    total_trips=total_trip_count,
                    segments_found=len(all_matched_segments),
                )

        if operations:
            collection = CoverageState.get_pymongo_collection()
            result = await collection.bulk_write(operations, ordered=False)
            total_updated += result.modified_count + result.upserted_count

    await update_area_stats(area_id)
    await report_progress(
        total_trips=total_trip_count,
        segments_found=len(all_matched_segments),
        force=True,
    )

    logger.info(
        "Backfill complete for area %s: %d segments from %d trips in %d batches",
        area.display_name,
        total_updated,
        total_line_count,
        matched_batches,
    )

    return total_updated


def get_trip_driven_at(trip_data: dict[str, Any] | None) -> datetime | None:
    if not trip_data:
        return None

    driven_at = (
        trip_data.get("endTime")
        or trip_data.get("startTime")
        or trip_data.get("lastUpdate")
    )
    return normalize_to_utc_datetime(driven_at)
