"""
Coverage statistics calculation.

This module computes and updates coverage statistics for areas by
aggregating data from the CoverageState collection.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from db.aggregation import aggregate_to_list
from db.models import CoverageArea, CoverageState, Street

if TYPE_CHECKING:
    from beanie import PydanticObjectId

logger = logging.getLogger(__name__)

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
    ingestion, turn-by-turn mark-driven, manual segment edits).

    The update is applied atomically via an aggregation pipeline update,
    and the derived fields (driveable_length_miles, coverage_percentage,
    last_synced) are recomputed from the updated totals.
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
    area = await CoverageArea.get(area_id)
    if not area:
        return None

    area.driven_segments = max(0, area.driven_segments + int(driven_segments_delta))
    area.driven_length_miles = max(
        0.0,
        area.driven_length_miles + float(driven_length_miles_delta),
    )
    area.undriveable_segments = max(
        0,
        area.undriveable_segments + int(undriveable_segments_delta),
    )
    area.undriveable_length_miles = max(
        0.0,
        area.undriveable_length_miles + float(undriveable_length_miles_delta),
    )

    driveable_length = max(0.0, area.total_length_miles - area.undriveable_length_miles)
    area.driveable_length_miles = round(driveable_length, 3)

    # Clamp driven length in case of floating drift or unexpected transitions.
    if area.driven_length_miles > area.driveable_length_miles and driveable_length > 0:
        area.driven_length_miles = area.driveable_length_miles

    if driveable_length > 0:
        pct = (area.driven_length_miles / driveable_length) * 100.0
        area.coverage_percentage = min(100.0, round(pct, 2))
    else:
        area.coverage_percentage = 0.0

    if update_last_synced:
        area.last_synced = now

    await area.save()
    return area


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
                "let": {"segment_id": "$segment_id"},
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$and": [
                                    {"$eq": ["$area_id", area_id]},
                                    {"$eq": ["$segment_id", "$$segment_id"]},
                                ],
                            },
                        },
                    },
                ],
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
        "total_length_miles": round(total_length, 3),
        "driven_length_miles": round(driven_length, 3),
        "undriveable_length_miles": round(undriveable_length, 3),
        "driveable_length_miles": round(driveable_length, 3),
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
        match["segment_id"] = {"$regex": f"^{area_id}-{area_version}-"}

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
