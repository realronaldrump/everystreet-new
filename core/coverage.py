"""Historical coverage matching and atomic replacement of derived projections."""

from __future__ import annotations

import asyncio
import logging
import os
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from statistics import median
from types import SimpleNamespace
from typing import Literal
from uuid import uuid4

import shapely
from beanie import PydanticObjectId
from pymongo import ReturnDocument
from shapely.geometry import LineString, MultiLineString, box, shape
from shapely.ops import transform
from shapely.strtree import STRtree

from core.date_utils import normalize_to_utc_datetime
from core.spatial import (
    extract_line_sequences,
    geodesic_distance_meters,
    get_local_transformers,
)
from core.trip_query_spec import apply_trip_record_filters
from core.trip_source_policy import enforce_bouncie_source
from db.models import CoverageArea, CoverageDriveEvent, Street, Trip
from street_coverage.constants import (
    MATCH_BUFFER_METERS,
    RAW_GPS_BUFFER_METERS,
    MAX_SEGMENTS_IN_MEMORY,
)
from street_coverage.identity import trip_input_revision
from street_coverage.matching import MATCHING_VERSION, match_projected_intervals
from street_coverage.projection import (
    CoverageDeferred,
    claim_area,
    project_segments,
    set_manual_status,
)
from street_coverage import transactions

logger = logging.getLogger(__name__)
CoverageTripMode = Literal["regular", "matched", "both"]
DEFAULT_COVERAGE_TRIP_MODE: CoverageTripMode = "both"
VALID_COVERAGE_TRIP_MODES = frozenset({"regular", "matched", "both"})
INDEX_MEMORY_BUDGET = 128 * 1024 * 1024
_INDEXES: OrderedDict[tuple, AreaSegmentIndex] = OrderedDict()


def normalize_coverage_trip_mode(value, *, default=DEFAULT_COVERAGE_TRIP_MODE):
    mode = str(value or "").strip().lower()
    return mode if mode in VALID_COVERAGE_TRIP_MODES else default


async def get_effective_coverage_trip_mode(trip_mode=None):
    if trip_mode:
        return normalize_coverage_trip_mode(trip_mode)
    if os.getenv("COVERAGE_TRIP_MODE"):
        return normalize_coverage_trip_mode(os.environ["COVERAGE_TRIP_MODE"])
    from core.service_config import get_service_config

    settings = await get_service_config()
    return normalize_coverage_trip_mode(settings.streetCoverageTripMode)


class AreaSegmentIndex:
    def __init__(self, area_id, area_version=None):
        self.area_id = area_id
        self.area_version = area_version
        self.segments = []
        self.segment_geoms_meters = []
        self.strtree = None
        self.to_meters = self.to_wgs84 = None
        self._built = False
        self._lock = asyncio.Lock()
        self.estimated_bytes = 0

    async def build(self):
        async with self._lock:
            if self._built:
                return self
            query = {"area_id": self.area_id, "area_version": self.area_version}
            collection = Street.get_pymongo_collection()
            rows = (
                await collection.find(query, {"segment_id": 1, "geometry": 1})
                .limit(MAX_SEGMENTS_IN_MEMORY + 1)
                .to_list(None)
            )
            if len(rows) > MAX_SEGMENTS_IN_MEMORY:
                raise ValueError(
                    "Coverage inventory exceeds the bounded spatial index size"
                )

            def build_index():
                valid = []
                geometries = []
                for row in rows:
                    geometry = shape(row["geometry"])
                    if (
                        geometry.geom_type != "LineString"
                        or not geometry.is_valid
                        or geometry.is_empty
                        or geometry.length == 0
                    ):
                        raise ValueError(
                            f"Invalid street geometry: {row['segment_id']}"
                        )
                    valid.append(SimpleNamespace(segment_id=row["segment_id"]))
                    geometries.append(geometry)
                if not geometries:
                    return valid, [], None, None, None, 0
                forward, inverse = get_local_transformers(
                    box(*shapely.total_bounds(geometries))
                )
                projected = [transform(forward, geometry) for geometry in geometries]
                estimate = sum(len(g.wkb) + 512 for g in projected)
                return valid, projected, STRtree(projected), forward, inverse, estimate

            (
                self.segments,
                self.segment_geoms_meters,
                self.strtree,
                self.to_meters,
                self.to_wgs84,
                self.estimated_bytes,
            ) = await asyncio.to_thread(build_index)
            self._built = True
            return self

    def find_coverage_intervals(self, trip_line, *, buffer_meters=MATCH_BUFFER_METERS):
        if not self._built or self.strtree is None:
            return {}
        return match_projected_intervals(
            [s.segment_id for s in self.segments],
            self.segment_geoms_meters,
            self.strtree,
            transform(self.to_meters, trip_line),
            buffer_meters,
        )

    def find_matching_segments(self, trip_line, *, buffer_meters=MATCH_BUFFER_METERS):
        """IDs with supported traveled intervals, for spatial inspection callers."""
        return list(
            self.find_coverage_intervals(trip_line, buffer_meters=buffer_meters)
        )


async def get_area_segment_index(area_id, area_version=None):
    if area_version is None:
        area = await CoverageArea.get(area_id)
        if area is None:
            raise ValueError("Coverage area not found")
        area_version = area.area_version
    key = (area_id, area_version)
    index = _INDEXES.setdefault(key, AreaSegmentIndex(area_id, area_version))
    await index.build()
    _INDEXES.move_to_end(key)
    while (
        len(_INDEXES) > 1
        and sum(item.estimated_bytes for item in _INDEXES.values())
        > INDEX_MEMORY_BUDGET
    ):
        _INDEXES.popitem(last=False)
    return index


def invalidate_area_index(area_id, area_version):
    _INDEXES.pop((area_id, area_version), None)


def _split_coords_by_gap(coords, timestamps=None):
    distances = [geodesic_distance_meters(*a[:2], *b[:2]) for a, b in pairwise(coords)]
    threshold = min(500.0, max(100.0, median(distances) * 5)) if distances else 100.0
    lines, current = [], []
    for index, point in enumerate(coords):
        gap = index > 0 and distances[index - 1] > threshold
        if (
            index
            and timestamps
            and timestamps[index - 1] is not None
            and timestamps[index] is not None
        ):
            seconds = (timestamps[index] - timestamps[index - 1]).total_seconds()
            gap = (
                gap
                or seconds > 120
                or (seconds <= 0 and distances[index - 1] > 2)
                or (seconds > 0 and distances[index - 1] / seconds > 70)
            )
        if gap:
            if len(current) > 1:
                lines.append(LineString(current))
            current = []
        current.append(point)
    if len(current) > 1:
        lines.append(LineString(current))
    return lines


def _has_confirmed_matched_geometry(trip):
    status = str(trip.get("matchStatus") or "").lower()
    confidence = trip.get("matchConfidence")
    if isinstance(confidence, (int, float)) and confidence < 0.5:
        return False
    return status.startswith("matched") or trip.get("matched_at") is not None


def _trip_to_matched_linestring(trip):
    if not _has_confirmed_matched_geometry(trip):
        return None
    lines = [
        LineString(coords)
        for coords in extract_line_sequences(trip.get("matchedGps"))
        if len(coords) >= 2
    ]
    return lines[0] if len(lines) == 1 else MultiLineString(lines) if lines else None


def _trip_to_raw_linestring(trip):
    result = []
    samples = trip.get("coordinates") or []
    for coords in extract_line_sequences(trip.get("gps")):
        timestamps = None
        if len(samples) == len(coords) and all(
            isinstance(sample, dict) for sample in samples
        ):
            timestamps = [
                normalize_to_utc_datetime(sample.get("timestamp")) for sample in samples
            ]
        result.extend(_split_coords_by_gap(coords, timestamps))
    return (
        result[0] if len(result) == 1 else MultiLineString(result) if result else None
    )


def trip_to_linestring_candidates(trip, trip_mode=DEFAULT_COVERAGE_TRIP_MODE):
    mode = normalize_coverage_trip_mode(trip_mode)
    matched = _trip_to_matched_linestring(trip) if mode != "regular" else None
    if matched is not None:
        return [(matched, True)]
    if mode == "matched":
        return []
    raw = _trip_to_raw_linestring(trip)
    return [(raw, False)] if raw is not None else []


async def match_trip_to_streets(trip, area_ids=None, trip_mode=None):
    mode = await get_effective_coverage_trip_mode(trip_mode)
    candidates = trip_to_linestring_candidates(trip, mode)
    if not candidates:
        return {}
    trace, matched = candidates[0]
    if area_ids is None:
        minx, miny, maxx, maxy = trace.bounds
        query = {
            "bounding_box.0": {"$lte": maxx},
            "bounding_box.2": {"$gte": minx},
            "bounding_box.1": {"$lte": maxy},
            "bounding_box.3": {"$gte": miny},
        }
    else:
        query = {"_id": {"$in": area_ids}}
    areas = await CoverageArea.find(query).to_list()
    results = {}
    for area in areas:
        if area.status != "ready" or area.coverage_rebuild_token:
            results[area.id] = {
                "deferred": True,
                "area_version": area.area_version,
                "evidence": {},
                "geometry_source": "none",
            }
            continue
        index = await get_area_segment_index(area.id, area.area_version)
        evidence = await asyncio.to_thread(
            index.find_coverage_intervals,
            trace,
            buffer_meters=MATCH_BUFFER_METERS if matched else RAW_GPS_BUFFER_METERS,
        )
        results[area.id] = {
            "area_version": area.area_version,
            "evidence": evidence,
            "geometry_source": "matchedGps" if matched else "gps",
        }
    return results


async def update_coverage_for_trip(trip_data, trip_id=None, trip_mode=None):
    trip_oid = _coerce_trip_id(trip_id)
    if trip_oid is None or trip_data.get("source") != "bouncie":
        raise ValueError("Coverage requires a persisted Bouncie Historical Trip")
    mode = await get_effective_coverage_trip_mode(trip_mode)
    matches = (
        {}
        if trip_data.get("inactive") or trip_data.get("invalid")
        else await match_trip_to_streets(trip_data, trip_mode=mode)
    )
    # Changed/deleted geometry must retract evidence from previously touched areas.
    previous = await CoverageDriveEvent.find({"trip_id": trip_oid}).to_list()
    for event in previous:
        if event.area_id not in matches:
            matches[event.area_id] = {
                "area_version": event.area_version,
                "evidence": {},
                "geometry_source": "none",
            }
    from street_coverage.trip_credit import credit_trip_area

    total = 0
    deferred = False
    for area_id, match in matches.items():
        if match.get("deferred"):
            deferred = True
            continue
        total += await credit_trip_area(
            trip_data,
            trip_oid,
            area_id,
            match["evidence"],
            mode,
            area_version=match["area_version"],
            geometry_source=match["geometry_source"],
        )
    if deferred:
        raise CoverageDeferred(
            "Waiting for an intersected area to finish recalculating"
        )
    return total


@dataclass(frozen=True)
class CoverageSegmentsUpdateResult:
    updated: int
    newly_driven_segment_ids: list[str]
    newly_driven_length_miles: float


async def update_coverage_for_segments(area_id, segment_ids):
    """Explicit owner marking; automatic credit must provide historical intervals."""
    result = await set_manual_status(area_id, segment_ids, "driven")
    return CoverageSegmentsUpdateResult(
        result["updated"],
        list(segment_ids),
        sum(
            state["covered_length_miles"]
            for state in result["states"].values()
            if state
        ),
    )


async def mark_segment_undriveable(area_id, segment_id):
    await set_manual_status(area_id, [segment_id], "undriveable")
    return True


async def mark_segment_undriven(area_id, segment_id):
    await set_manual_status(area_id, [segment_id], "undriven")
    return True


def _build_backfill_trip_query(area, *, since=None, trip_mode="both"):
    minx, miny, maxx, maxy = area.bounding_box
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]
        ],
    }
    geo = {"$geoIntersects": {"$geometry": polygon}}
    query = enforce_bouncie_source(
        apply_trip_record_filters({"invalid": {"$ne": True}}, include_invalid=True)
    )
    query["$or"] = [{"gps": geo}, {"matchedGps": geo}]
    return query


async def backfill_coverage_for_area(
    area_id,
    since=None,
    progress_callback=None,
    progress_interval=100,
    progress_time_seconds=0.5,
    trip_mode=None,
    *,
    full=False,
    inventory_version=None,
    inventory_metadata=None,
):
    """Replace all eligible evidence and projection atomically; reuse unchanged matches."""
    area = await CoverageArea.get(area_id)
    if area is None:
        raise ValueError("Coverage area not found")
    token = uuid4().hex
    now = datetime.now(UTC)
    lease_until = now + timedelta(hours=2)
    collection = CoverageArea.get_pymongo_collection()
    claimed = await collection.find_one_and_update(
        {
            "_id": area_id,
            "$or": [
                {"coverage_rebuild_token": None},
                {"coverage_rebuild_until": {"$lte": now}},
            ],
        },
        {
            "$set": {
                "coverage_rebuild_token": token,
                "coverage_rebuild_until": lease_until,
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    if claimed is None:
        raise ValueError("Coverage recalculation is already running")
    original_version = area.area_version
    version = inventory_version or area.area_version
    mode = await get_effective_coverage_trip_mode(trip_mode)
    try:
        index = await get_area_segment_index(area_id, version)
        current_events = await CoverageDriveEvent.find(
            {"area_id": area_id, "area_version": version}
        ).to_list()
        by_trip = {str(event.trip_id): event for event in current_events}
        events = []
        processed = 0
        query = _build_backfill_trip_query(area, trip_mode=mode)
        total = await Trip.find(query).count()
        latest = None
        async for trip in Trip.find(query).sort([("endTime", 1), ("_id", 1)]):
            processed += 1
            data = trip.model_dump()
            revision = trip_input_revision(data)
            previous = by_trip.get(str(trip.id))
            driven_at = get_trip_driven_at(data)
            if driven_at is None:
                continue
            latest = max(latest, driven_at) if latest else driven_at
            if (
                not full
                and previous
                and previous.input_revision == revision
                and previous.matching_version == MATCHING_VERSION
                and previous.matching_mode == mode
            ):
                events.append(previous.model_dump(exclude={"id"}))
            else:
                candidates = trip_to_linestring_candidates(data, mode)
                if candidates:
                    trace, matched = candidates[0]
                    evidence = await asyncio.to_thread(
                        index.find_coverage_intervals,
                        trace,
                        buffer_meters=MATCH_BUFFER_METERS
                        if matched
                        else RAW_GPS_BUFFER_METERS,
                    )
                    if evidence:
                        events.append(
                            CoverageDriveEvent(
                                area_id=area_id,
                                area_version=version,
                                trip_id=trip.id,
                                driven_at=driven_at,
                                timezone=trip.endTimeZone or trip.startTimeZone,
                                geometry_source="matchedGps" if matched else "gps",
                                matching_mode=mode,
                                input_revision=revision,
                                segment_ids=sorted(evidence),
                                segment_intervals={
                                    sid: item["intervals"]
                                    for sid, item in evidence.items()
                                },
                                segment_offsets={
                                    sid: item["max_offset_meters"]
                                    for sid, item in evidence.items()
                                },
                            ).model_dump(exclude={"id"})
                        )
            if progress_callback and (
                processed % max(1, progress_interval) == 0 or processed == total
            ):
                await progress_callback(
                    {
                        "processed_trips": processed,
                        "total_trips": total,
                        "matched_trips": len(events),
                        "segments_updated": 0,
                        "trip_mode": mode,
                    }
                )
            if processed % 100 == 0:
                await collection.update_one(
                    {"_id": area_id, "coverage_rebuild_token": token},
                    {
                        "$set": {
                            "coverage_rebuild_until": datetime.now(UTC)
                            + timedelta(hours=2)
                        }
                    },
                )

        async def publish(session):
            active = await claim_area(
                area_id, session, version=original_version, rebuild_token=token
            )
            metadata = dict(inventory_metadata or {})
            if version != original_version:
                metadata.update(
                    {
                        "area_version": version,
                        "optimal_route_id": None,
                        "optimal_route_generated_at": None,
                    }
                )
                active.area_version = version
            await collection.update_one(
                {"_id": area_id},
                {"$set": {**metadata, "status": "ready"}},
                session=session,
            )
            history = CoverageDriveEvent.get_pymongo_collection()
            await history.delete_many(
                {"area_id": area_id, "area_version": version}, session=session
            )
            for start in range(0, len(events), 250):
                await history.insert_many(events[start : start + 250], session=session)
            result = await project_segments(active, [], session, replace_all=True)
            await collection.update_one(
                {"_id": area_id},
                {
                    "$set": {
                        "coverage_rebuild_token": None,
                        "coverage_rebuild_until": None,
                        "pending_area_version": None,
                        "last_backfill_trip_endtime": latest,
                        "last_coverage_trip_at": latest,
                    }
                },
                session=session,
            )
            return result

        result = await transactions.run_transaction(publish)
        from street_coverage.journal import rebuild_journal_rollup

        await rebuild_journal_rollup(area_id)
        from trips.services.coverage_processing import notify_coverage_updated

        await notify_coverage_updated()
        if progress_callback:
            await progress_callback(
                {
                    "processed_trips": processed,
                    "total_trips": total,
                    "matched_trips": len(events),
                    "segments_updated": result["metrics"]["driven_segments"],
                    "trip_mode": mode,
                }
            )
        return len(result["newly_driven_segment_ids"])
    finally:
        await collection.update_one(
            {"_id": area_id, "coverage_rebuild_token": token},
            {"$set": {"coverage_rebuild_token": None, "coverage_rebuild_until": None}},
        )


def get_trip_driven_at(trip_data):
    return (
        normalize_to_utc_datetime(
            trip_data.get("endTime") or trip_data.get("startTime")
        )
        if trip_data
        else None
    )


def _coerce_trip_id(trip_id):
    try:
        return PydanticObjectId(str(trip_id)) if trip_id is not None else None
    except (ValueError, TypeError):
        return None
