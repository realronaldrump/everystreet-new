"""Exact coverage totals and revision-safe projection verification."""

from db.aggregation import aggregate_to_list
from db.models import CoverageArea, CoverageState, Street
from street_coverage import transactions
from street_coverage.matching import MATCHING_VERSION
from street_coverage.projection import area_metrics, claim_area, project_segments
from street_coverage.segment_ids import segment_id_regex_for_area_version


async def calculate_area_stats(area_id, area_version=None):
    area = await CoverageArea.get(area_id)
    if area is None:
        raise ValueError("Coverage area not found")
    version = area.area_version if area_version is None else area_version
    pipeline = [
        {"$match": {"area_id": area_id, "area_version": version}},
        {
            "$lookup": {
                "from": "coverage_state",
                "localField": "segment_id",
                "foreignField": "segment_id",
                "as": "state",
            }
        },
        {"$unwind": {"path": "$state", "preserveNullAndEmptyArrays": True}},
        {
            "$group": {
                "_id": None,
                "total_segments": {"$sum": 1},
                "total_length_miles": {"$sum": "$length_miles"},
                "driven_segments": {
                    "$sum": {"$cond": [{"$eq": ["$state.status", "driven"]}, 1, 0]}
                },
                "driven_length_miles": {
                    "$sum": {"$ifNull": ["$state.covered_length_miles", 0.0]}
                },
                "undriveable_segments": {
                    "$sum": {"$cond": [{"$eq": ["$state.status", "undriveable"]}, 1, 0]}
                },
                "undriveable_length_miles": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$state.status", "undriveable"]},
                            "$length_miles",
                            0,
                        ]
                    }
                },
            }
        },
    ]
    rows = await aggregate_to_list(Street, pipeline)
    values = (
        rows[0]
        if rows
        else dict(
            total_segments=0,
            total_length_miles=0,
            driven_segments=0,
            driven_length_miles=0,
            undriveable_segments=0,
            undriveable_length_miles=0,
        )
    )
    values.pop("_id", None)
    return area_metrics(**values)


async def update_area_stats(area_id):
    """Reconcile evidence, states, counters, and revision in the same transaction."""

    async def commit(session):
        area = await CoverageArea.get(area_id, session=session)
        if area is None:
            return None
        if area.coverage_matching_version != MATCHING_VERSION:
            raise ValueError(
                "Recalculate historical coverage before refreshing its totals"
            )
        area = await claim_area(area_id, session)
        await project_segments(area, [], session, replace_all=True)
        return await CoverageArea.get(area_id, session=session)

    return await transactions.run_transaction(commit)


async def get_segment_status_counts(area_id, area_version=None):
    area = await CoverageArea.get(area_id)
    if area is None:
        raise ValueError("Coverage area not found")
    query = {
        "area_id": area_id,
        "segment_id": segment_id_regex_for_area_version(
            area_id, area_version or area.area_version
        ),
    }
    rows = await aggregate_to_list(
        CoverageState,
        [{"$match": query}, {"$group": {"_id": "$status", "count": {"$sum": 1}}}],
    )
    counts = {row["_id"]: row["count"] for row in rows}
    return {
        "driven": counts.get("driven", 0),
        "undriveable": counts.get("undriveable", 0),
        "undriven": max(
            0,
            area.total_segments
            - counts.get("driven", 0)
            - counts.get("undriveable", 0),
        ),
    }
