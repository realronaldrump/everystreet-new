"""
Coverage statistics calculation.

This module computes and updates coverage statistics for areas by
aggregating data from the CoverageState collection.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from core.date_utils import normalize_to_utc_datetime
from db.aggregation import aggregate_to_list
from db.models import CoverageArea, CoverageDriveEvent, CoverageState, Street
from street_coverage.segment_ids import segment_id_regex_for_area_version

if TYPE_CHECKING:
    from beanie import PydanticObjectId

logger = logging.getLogger(__name__)


def _increment_nonnegative_expr(field: str, delta: float) -> dict[str, Any]:
    return {"$max": [0, {"$add": [{"$ifNull": [f"${field}", 0]}, delta]}]}


def _round_nonnegative_expr(expression: Any, places: int) -> dict[str, Any]:
    factor = 10**places
    return {
        "$divide": [
            {"$trunc": {"$add": [{"$multiply": [expression, factor]}, 0.5]}},
            factor,
        ],
    }


async def apply_area_stats_delta(
    area_id: PydanticObjectId,
    *,
    driven_segments_delta: int = 0,
    driven_length_miles_delta: float = 0.0,
    undriveable_segments_delta: int = 0,
    undriveable_length_miles_delta: float = 0.0,
    update_last_synced: bool = True,
) -> CoverageArea | None:
    """
    Apply incremental deltas to CoverageArea cached stats.

    This avoids expensive full recomputes for frequent updates (trip
    ingestion, live navigation mark-driven, manual segment edits).

    The raw counters and derived fields are updated in one MongoDB update
    pipeline. That keeps concurrent callers from losing increments or
    overwriting freshly-computed percentages with stale snapshots.
    """
    if (
        driven_segments_delta == 0
        and driven_length_miles_delta == 0.0
        and undriveable_segments_delta == 0
        and undriveable_length_miles_delta == 0.0
        and not update_last_synced
    ):
        return await CoverageArea.get(area_id)

    now = datetime.now(UTC)

    counter_set: dict[str, Any] = {
        "driven_segments": _increment_nonnegative_expr(
            "driven_segments",
            int(driven_segments_delta),
        ),
        "driven_length_miles": _increment_nonnegative_expr(
            "driven_length_miles",
            float(driven_length_miles_delta),
        ),
        "undriveable_segments": _increment_nonnegative_expr(
            "undriveable_segments",
            int(undriveable_segments_delta),
        ),
        "undriveable_length_miles": _increment_nonnegative_expr(
            "undriveable_length_miles",
            float(undriveable_length_miles_delta),
        ),
    }
    if update_last_synced:
        counter_set["last_synced"] = now

    update_pipeline: list[dict[str, Any]] = [
        {"$set": counter_set},
        {
            "$set": {
                "driveable_length_miles": {
                    "$max": [
                        0.0,
                        {
                            "$subtract": [
                                {"$ifNull": ["$total_length_miles", 0.0]},
                                {
                                    "$ifNull": [
                                        "$undriveable_length_miles",
                                        0.0,
                                    ]
                                },
                            ]
                        },
                    ]
                },
            },
        },
        {
            "$set": {
                "driven_length_miles": {
                    "$cond": [
                        {
                            "$and": [
                                {"$gt": ["$driveable_length_miles", 0.0]},
                                {
                                    "$gt": [
                                        "$driven_length_miles",
                                        "$driveable_length_miles",
                                    ],
                                },
                            ],
                        },
                        "$driveable_length_miles",
                        "$driven_length_miles",
                    ],
                },
            },
        },
        {
            "$set": {
                "coverage_percentage": {
                    "$cond": [
                        {"$gt": ["$driveable_length_miles", 0.0]},
                        {
                            "$min": [
                                100.0,
                                _round_nonnegative_expr(
                                    {
                                        "$multiply": [
                                            {
                                                "$divide": [
                                                    "$driven_length_miles",
                                                    "$driveable_length_miles",
                                                ],
                                            },
                                            100.0,
                                        ],
                                    },
                                    2,
                                ),
                            ],
                        },
                        0.0,
                    ],
                },
            },
        },
    ]

    collection = CoverageArea.get_pymongo_collection()
    snapshot = await collection.find_one_and_update(
        {"_id": area_id},
        update_pipeline,
        return_document=ReturnDocument.AFTER,
    )

    if snapshot is None:
        return None

    return await CoverageArea.get(area_id)


async def reconcile_area_state_from_drive_events(
    area_id: PydanticObjectId,
    area_version: int | None = None,
) -> tuple[int, float]:
    """Restore missing current-version states from exact historical drive events.

    ``CoverageDriveEvent`` is the durable record of a matched historical drive,
    while ``CoverageState`` is the mutable projection used by the map and
    cached statistics.  If the projection is lost but the event journal remains,
    rebuilding stats from states alone silently turns real coverage into zero.

    Only segment IDs that still belong to the current street inventory are
    restored. Existing undriveable states are never changed.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        return 0, 0.0

    effective_version = area.area_version if area_version is None else area_version
    if effective_version != area.area_version:
        return 0, 0.0

    events = (
        await CoverageDriveEvent.find(
            {"area_id": area_id, "area_version": effective_version},
        )
        .sort([("driven_at", 1), ("_id", 1)])
        .to_list()
    )
    if not events:
        return 0, 0.0

    # Collapse the event journal into the exact first/last drive facts required
    # by CoverageState. Sorting makes the latest trip deterministic for equal
    # timestamps as well.
    history: dict[str, tuple[datetime, datetime, Any]] = {}
    for event in events:
        driven_at = normalize_to_utc_datetime(event.driven_at)
        if driven_at is None:
            continue
        for raw_segment_id in event.segment_ids:
            segment_id = str(raw_segment_id)
            existing = history.get(segment_id)
            if existing is None:
                history[segment_id] = (driven_at, driven_at, event.trip_id)
                continue

            first_at, last_at, latest_trip_id = existing
            first_at = min(first_at, driven_at)
            if driven_at >= last_at:
                last_at = driven_at
                latest_trip_id = event.trip_id
            history[segment_id] = (first_at, last_at, latest_trip_id)

    if not history:
        return 0, 0.0

    segment_ids = list(history)
    streets = await Street.find(
        {
            "area_id": area_id,
            "area_version": effective_version,
            "segment_id": {"$in": segment_ids},
        },
    ).to_list()
    length_by_segment = {
        str(street.segment_id): float(street.length_miles or 0.0) for street in streets
    }
    if not length_by_segment:
        return 0, 0.0

    states = await CoverageState.find(
        {
            "area_id": area_id,
            "segment_id": {"$in": list(length_by_segment)},
        },
    ).to_list()
    state_by_segment = {state.segment_id: state for state in states}
    candidates = [
        segment_id
        for segment_id in length_by_segment
        if (
            (state := state_by_segment.get(segment_id)) is None
            or state.status not in {"driven", "undriveable"}
        )
    ]
    if not candidates:
        return 0, 0.0

    collection = CoverageState.get_pymongo_collection()
    semaphore = asyncio.Semaphore(32)

    async def restore_one(segment_id: str) -> bool:
        first_at, last_at, latest_trip_id = history[segment_id]
        state_set: dict[str, Any] = {
            "area_id": area_id,
            "segment_id": segment_id,
            "status": "driven",
            "first_driven_at": {
                "$min": [
                    {"$ifNull": ["$first_driven_at", first_at]},
                    first_at,
                ],
            },
            "last_driven_at": {
                "$max": [
                    {"$ifNull": ["$last_driven_at", last_at]},
                    last_at,
                ],
            },
            "manually_marked": {"$ifNull": ["$manually_marked", False]},
        }
        if latest_trip_id is not None:
            state_set["driven_by_trip_id"] = latest_trip_id
        update_pipeline = [{"$set": state_set}]

        async with semaphore:
            try:
                previous = await collection.find_one_and_update(
                    {
                        "area_id": area_id,
                        "segment_id": segment_id,
                        "status": {"$ne": "undriveable"},
                    },
                    update_pipeline,
                    upsert=True,
                    return_document=ReturnDocument.BEFORE,
                )
            except DuplicateKeyError:
                # A concurrent writer may have inserted an undriveable state or
                # won the unique-key race. Only retry an already-driveable row.
                previous = await collection.find_one_and_update(
                    {
                        "area_id": area_id,
                        "segment_id": segment_id,
                        "status": "driven",
                    },
                    update_pipeline,
                    upsert=False,
                    return_document=ReturnDocument.BEFORE,
                )
                if previous is None:
                    return False

        return previous is None or previous.get("status") != "driven"

    restored = [
        restored
        for start in range(0, len(candidates), 128)
        for restored in await asyncio.gather(
            *(
                restore_one(segment_id)
                for segment_id in candidates[start : start + 128]
            ),
        )
    ]
    restored_ids = [
        segment_id
        for segment_id, was_restored in zip(candidates, restored, strict=True)
        if was_restored
    ]
    restored_length = sum(length_by_segment[segment_id] for segment_id in restored_ids)

    if restored_ids:
        logger.warning(
            "Restored %d missing coverage states for area %s from %d drive events",
            len(restored_ids),
            area.display_name,
            len(events),
        )
    return len(restored_ids), restored_length


async def calculate_area_stats(
    area_id: PydanticObjectId,
    area_version: int | None = None,
) -> dict:
    """
    Calculate coverage statistics for an area.

    Returns statistics dict with:
    - total_segments: Total number of street segments
    - driven_segments: Number of driven segments
    - total_length_miles: Total street length in miles
    - driven_length_miles: Driven street length in miles
    - driveable_length_miles: Total excluding undriveable
    - coverage_percentage: Percentage of driveable streets driven
    """
    if area_version is None:
        area = await CoverageArea.get(area_id)
        if not area:
            return {
                "total_segments": 0,
                "driven_segments": 0,
                "undriveable_segments": 0,
                "total_length_miles": 0.0,
                "driven_length_miles": 0.0,
                "undriveable_length_miles": 0.0,
                "driveable_length_miles": 0.0,
                "coverage_percentage": 0.0,
            }
        area_version = area.area_version

    # Get all segments for this area with their status
    pipeline = [
        {"$match": {"area_id": area_id, "area_version": area_version}},
        {
            "$lookup": {
                "from": "coverage_state",
                "localField": "segment_id",
                "foreignField": "segment_id",
                "as": "state",
            },
        },
        {"$unwind": {"path": "$state", "preserveNullAndEmptyArrays": True}},
        {
            "$group": {
                "_id": None,
                "total_segments": {"$sum": 1},
                "total_length_miles": {"$sum": "$length_miles"},
                "driven_segments": {
                    "$sum": {"$cond": [{"$eq": ["$state.status", "driven"]}, 1, 0]},
                },
                "driven_length_miles": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$state.status", "driven"]},
                            "$length_miles",
                            0,
                        ],
                    },
                },
                "undriveable_segments": {
                    "$sum": {
                        "$cond": [{"$eq": ["$state.status", "undriveable"]}, 1, 0],
                    },
                },
                "undriveable_length_miles": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$state.status", "undriveable"]},
                            "$length_miles",
                            0,
                        ],
                    },
                },
            },
        },
    ]

    results = await aggregate_to_list(Street, pipeline)

    if not results:
        return {
            "total_segments": 0,
            "driven_segments": 0,
            "undriveable_segments": 0,
            "total_length_miles": 0.0,
            "driven_length_miles": 0.0,
            "undriveable_length_miles": 0.0,
            "driveable_length_miles": 0.0,
            "coverage_percentage": 0.0,
        }

    r = results[0]
    total_length = r.get("total_length_miles", 0.0)
    driven_length = r.get("driven_length_miles", 0.0)
    undriveable_length = r.get("undriveable_length_miles", 0.0)
    driveable_length = total_length - undriveable_length

    coverage_pct = 0.0
    if driveable_length > 0:
        coverage_pct = round((driven_length / driveable_length) * 100, 2)

    if coverage_pct > 100.0:
        logger.warning("Coverage exceeded 100%% for area %s", area_id)
        coverage_pct = 100.0

    return {
        "total_segments": r.get("total_segments", 0),
        "driven_segments": r.get("driven_segments", 0),
        "undriveable_segments": r.get("undriveable_segments", 0),
        "total_length_miles": total_length,
        "driven_length_miles": driven_length,
        "undriveable_length_miles": undriveable_length,
        "driveable_length_miles": driveable_length,
        "coverage_percentage": coverage_pct,
    }


async def update_area_stats(area_id: PydanticObjectId) -> CoverageArea | None:
    """
    Calculate and persist coverage statistics for an area.

    Updates the CoverageArea document with fresh statistics. Returns the
    updated area or None if not found.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        logger.warning("Area %s not found for stats update", area_id)
        return None

    await reconcile_area_state_from_drive_events(area_id, area.area_version)
    stats = await calculate_area_stats(area_id, area.area_version)

    area.total_segments = stats["total_segments"]
    area.driven_segments = stats["driven_segments"]
    area.undriveable_segments = stats["undriveable_segments"]
    area.total_length_miles = stats["total_length_miles"]
    area.driven_length_miles = stats["driven_length_miles"]
    area.undriveable_length_miles = stats["undriveable_length_miles"]
    area.driveable_length_miles = stats["driveable_length_miles"]
    area.coverage_percentage = stats["coverage_percentage"]
    area.last_synced = datetime.now(UTC)

    await area.save()

    logger.info(
        "Updated stats for area %s: %s/%s segments, %s%% coverage",
        area.display_name,
        stats["driven_segments"],
        stats["total_segments"],
        stats["coverage_percentage"],
    )

    return area


async def get_segment_status_counts(
    area_id: PydanticObjectId,
    area_version: int | None = None,
) -> dict[str, int]:
    """
    Get counts of segments by status for an area.

    Returns dict like: {"undriven": 150, "driven": 50, "undriveable": 10}
    """
    # CoverageState intentionally may not store "undriven" rows for every segment.
    # We derive the undriven count from CoverageArea totals and the counts of the
    # explicitly stored statuses.
    area = await CoverageArea.get(area_id)
    total_segments = int(area.total_segments) if area else 0

    match: dict[str, Any] = {"area_id": area_id}
    if area_version is not None:
        match["segment_id"] = segment_id_regex_for_area_version(area_id, area_version)

    pipeline = [
        {"$match": match},
        {"$group": {"_id": "$status", "count": {"$sum": 1}}},
    ]
    results = await aggregate_to_list(CoverageState, pipeline)

    driven = 0
    undriveable = 0
    for r in results:
        status = r.get("_id")
        if status == "driven":
            driven = int(r.get("count", 0) or 0)
        elif status == "undriveable":
            undriveable = int(r.get("count", 0) or 0)

    undriven = max(0, total_segments - driven - undriveable)
    return {"undriven": undriven, "driven": driven, "undriveable": undriveable}
