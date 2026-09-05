"""Derive effective coverage from interval evidence and explicit owner decisions."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from pymongo import DeleteOne, ReplaceOne

from db.models import (
    CoverageArea,
    CoverageDriveEvent,
    CoverageGoal,
    CoverageOverride,
    CoverageState,
    CoverageStatusEvent,
    Street,
)
from street_coverage.identity import road_key
from street_coverage.intervals import (
    covered_fraction,
    union_intervals,
    interval_discoveries,
)
from street_coverage.matching import MATCHING_VERSION


class CoverageDeferred(RuntimeError):
    """Temporary area work blocks credit without consuming a failure attempt."""


from street_coverage import transactions


def area_metrics(
    *,
    total_segments: int,
    total_length_miles: float,
    driven_segments: int,
    driven_length_miles: float,
    undriveable_segments: int,
    undriveable_length_miles: float,
) -> dict[str, Any]:
    values = (total_length_miles, driven_length_miles, undriveable_length_miles)
    if any(not math.isfinite(value) or value < -1e-9 for value in values):
        raise ValueError("Coverage lengths must be finite and nonnegative")
    if (
        min(total_segments, driven_segments, undriveable_segments) < 0
        or driven_segments + undriveable_segments > total_segments
    ):
        raise ValueError("Coverage segment counts disagree with the street inventory")
    eligible = total_length_miles - undriveable_length_miles
    if eligible < -1e-9 or driven_length_miles > eligible + 1e-9:
        raise ValueError("Covered length exceeds the eligible street inventory")
    eligible = max(0.0, eligible)
    covered = max(0.0, min(driven_length_miles, eligible))
    remaining = max(0.0, eligible - covered)
    remaining_segments = total_segments - driven_segments - undriveable_segments
    return {
        "total_segments": total_segments,
        "total_length_miles": total_length_miles,
        "driven_segments": driven_segments,
        "driven_length_miles": covered,
        "undriveable_segments": undriveable_segments,
        "undriveable_length_miles": undriveable_length_miles,
        "driveable_length_miles": eligible,
        "remaining_length_miles": remaining,
        "remaining_segments": remaining_segments,
        "coverage_percentage": covered / eligible * 100 if eligible else 0.0,
        "is_complete": eligible > 0 and remaining_segments == 0 and remaining <= 1e-9,
    }


async def claim_area(area_id, session, *, version=None, rebuild_token=None):
    area = await CoverageArea.get(area_id, session=session)
    if area is None:
        raise ValueError("Coverage area not found")
    if version is not None and area.area_version != version:
        raise ValueError("The street inventory changed; retry coverage")
    now = datetime.now(UTC)
    lease = area.coverage_rebuild_until
    if lease and lease.tzinfo is None:
        lease = lease.replace(tzinfo=UTC)
    if (
        area.coverage_rebuild_token
        and lease
        and lease > now
        and area.coverage_rebuild_token != rebuild_token
    ):
        raise CoverageDeferred("Coverage is recalculating; retry when it finishes")
    if area.status != "ready" and rebuild_token is None:
        raise CoverageDeferred("The coverage inventory is not ready")
    # Taking a write on the same area document serializes concurrent state writers
    # under MongoDB's transaction retries, before any projection reads occur.
    await CoverageArea.get_pymongo_collection().update_one(
        {"_id": area.id, "area_version": area.area_version},
        {"$inc": {"journal_revision": 1}, "$set": {"journal_status": "pending"}},
        session=session,
    )
    area.journal_revision += 1
    return area


def state_from_evidence(street, events, override=None) -> dict[str, Any] | None:
    evidence = [
        event for event in events if event.segment_intervals.get(street.segment_id)
    ]
    intervals = union_intervals(
        interval
        for event in evidence
        for interval in event.segment_intervals[street.segment_id]
    )
    if override:
        intervals = [[0.0, 1.0]] if override.status == "driven" else []
    fraction = covered_fraction(intervals)
    status = (
        override.status
        if override
        else "driven"
        if fraction >= 1 - 1e-9
        else "undriven"
    )
    if not evidence and override is None:
        return None
    first = min((event.driven_at for event in evidence), default=None)
    last = max((event.driven_at for event in evidence), default=None)
    latest = max(
        evidence, key=lambda event: (event.driven_at, str(event.trip_id)), default=None
    )
    if override:
        first = last = override.marked_at if override.status == "driven" else None
    sources = sorted({event.geometry_source for event in evidence})
    timeline = [
        (event.driven_at, event.segment_intervals[street.segment_id])
        for event in evidence
    ]
    if override and override.status == "driven":
        timeline.append((override.marked_at, [[0.0, 1.0]]))
    discoveries = interval_discoveries(timeline, intervals)
    first = min((row["first_driven_at"] for row in discoveries), default=None)
    return {
        "area_id": street.area_id,
        "segment_id": street.segment_id,
        "status": status,
        "intervals": intervals,
        "discovery_intervals": discoveries,
        "coverage_fraction": fraction,
        "covered_length_miles": street.length_miles * fraction,
        "first_driven_at": first,
        "last_driven_at": last,
        "driven_by_trip_id": latest.trip_id if latest and not override else None,
        "manually_marked": override is not None,
        "marked_at": override.marked_at if override else None,
        "trip_count": len({event.trip_id for event in evidence}),
        "evidence_source": "manual" if override else "+".join(sources) or None,
        "max_offset_meters": max(
            (event.segment_offsets.get(street.segment_id, 0.0) for event in evidence),
            default=None,
        ),
    }


async def project_segments(area, segment_ids, session, *, replace_all=False):
    query = {"area_id": area.id, "area_version": area.area_version}
    if not replace_all:
        query["segment_id"] = {"$in": list(set(segment_ids))}
    streets = await Street.find(query, session=session).to_list()
    ids = [street.segment_id for street in streets]
    event_query = {
        "area_id": area.id,
        "area_version": area.area_version,
        "matching_version": MATCHING_VERSION,
    }
    if not replace_all:
        event_query["segment_ids"] = {"$in": ids}
    events = await CoverageDriveEvent.find(event_query, session=session).to_list()
    by_segment = defaultdict(list)
    for event in events:
        for sid in event.segment_intervals:
            by_segment[sid].append(event)
    overrides = await CoverageOverride.find(
        {"area_id": area.id}, session=session
    ).to_list()
    by_road = {item.road_key: item for item in overrides}
    previous = await CoverageState.find(
        {"area_id": area.id, "segment_id": {"$in": ids}}, session=session
    ).to_list()
    old = {state.segment_id: state for state in previous}
    next_states = {
        street.segment_id: state_from_evidence(
            street,
            by_segment[street.segment_id],
            by_road.get(road_key(street.geometry, street.road_tags)),
        )
        for street in streets
    }
    operations = []
    new_complete = []
    covered_delta = 0.0
    driven_delta = excluded_delta = 0
    excluded_length_delta = 0.0
    for street in streets:
        sid = street.segment_id
        before, after = old.get(sid), next_states[sid]
        before_status = before.status if before else "undriven"
        after_status = after["status"] if after else "undriven"
        covered_delta += (after["covered_length_miles"] if after else 0.0) - (
            before.covered_length_miles if before else 0.0
        )
        driven_delta += int(after_status == "driven") - int(before_status == "driven")
        excluded_delta += int(after_status == "undriveable") - int(
            before_status == "undriveable"
        )
        excluded_length_delta += street.length_miles * (
            int(after_status == "undriveable") - int(before_status == "undriveable")
        )
        if after_status == "driven" and before_status != "driven":
            new_complete.append(sid)
        flt = {"area_id": area.id, "segment_id": sid}
        operations.append(
            ReplaceOne(flt, after, upsert=True) if after else DeleteOne(flt)
        )
    collection = CoverageState.get_pymongo_collection()
    if replace_all:
        await collection.delete_many({"area_id": area.id}, session=session)
    for start in range(0, len(operations), 500):
        await collection.bulk_write(
            operations[start : start + 500], ordered=True, session=session
        )

    if replace_all:
        states = [state for state in next_states.values() if state]
        excluded_ids = {
            state["segment_id"] for state in states if state["status"] == "undriveable"
        }
        metrics = area_metrics(
            total_segments=len(streets),
            total_length_miles=math.fsum(s.length_miles for s in streets),
            driven_segments=sum(state["status"] == "driven" for state in states),
            driven_length_miles=math.fsum(
                state["covered_length_miles"] for state in states
            ),
            undriveable_segments=len(excluded_ids),
            undriveable_length_miles=math.fsum(
                s.length_miles for s in streets if s.segment_id in excluded_ids
            ),
        )
    else:
        metrics = area_metrics(
            total_segments=area.total_segments,
            total_length_miles=area.total_length_miles,
            driven_segments=area.driven_segments + driven_delta,
            driven_length_miles=area.driven_length_miles + covered_delta,
            undriveable_segments=area.undriveable_segments + excluded_delta,
            undriveable_length_miles=area.undriveable_length_miles
            + excluded_length_delta,
        )
    now = datetime.now(UTC)
    await CoverageArea.get_pymongo_collection().update_one(
        {"_id": area.id, "area_version": area.area_version},
        {
            "$set": {
                **metrics,
                "coverage_matching_version": MATCHING_VERSION,
                "coverage_built_at": now,
                "last_synced": now,
            }
        },
        session=session,
    )
    goal = await CoverageGoal.find_one({"area_id": area.id}, session=session)
    if goal and goal.status in {"active", "completed"}:
        reached = (
            metrics["is_complete"]
            if goal.target_percentage >= 100
            else metrics["driveable_length_miles"] > 0
            and metrics["coverage_percentage"] >= goal.target_percentage
        )
        await CoverageGoal.get_pymongo_collection().update_one(
            {"_id": goal.id},
            {
                "$set": {
                    "status": "completed" if reached else "active",
                    "completed_at": (goal.completed_at or now) if reached else None,
                    "updated_at": now,
                }
            },
            session=session,
        )
    return {
        "newly_driven_segment_ids": new_complete,
        "covered_miles_delta": covered_delta,
        "metrics": metrics,
        "states": next_states,
    }


async def set_manual_status(area_id, segment_ids, status):
    if status not in {"driven", "undriven", "undriveable", "automatic"}:
        raise ValueError("Unknown coverage decision")
    ids = sorted(set(segment_ids))
    if not ids or len(ids) > 1000:
        raise ValueError("Select between 1 and 1,000 streets")

    async def commit(session):
        area = await claim_area(area_id, session)
        streets = await Street.find(
            {
                "area_id": area_id,
                "area_version": area.area_version,
                "segment_id": {"$in": ids},
            },
            session=session,
        ).to_list()
        if len(streets) != len(ids):
            raise ValueError("Selected streets changed. Refresh the map and try again.")
        now = datetime.now(UTC)
        for street in streets:
            query = {
                "area_id": area_id,
                "road_key": road_key(street.geometry, street.road_tags),
            }
            collection = CoverageOverride.get_pymongo_collection()
            if status == "automatic":
                await collection.delete_one(query, session=session)
            else:
                await collection.update_one(
                    query,
                    {
                        "$set": {
                            **query,
                            "status": status,
                            "geometry": street.geometry,
                            "street_name": street.street_name,
                            "marked_at": now,
                        }
                    },
                    upsert=True,
                    session=session,
                )
        result = await project_segments(area, ids, session)
        event = CoverageStatusEvent(
            area_id=area_id,
            area_version=area.area_version,
            action=f"mark_{status}",
            source="manual",
            occurred_at=now,
            segment_ids=ids,
            coverage_before=area.coverage_percentage,
            coverage_after=result["metrics"]["coverage_percentage"],
            driven_miles_before=area.driven_length_miles,
            driven_miles_after=result["metrics"]["driven_length_miles"],
        )
        await event.insert(session=session)
        return {
            "success": True,
            "updated": len(ids),
            "states": {sid: state for sid, state in result["states"].items()},
            "coverage_revision": area.journal_revision,
            **result["metrics"],
        }

    result = await transactions.run_transaction(commit)
    for state in result["states"].values():
        if state:
            state["area_id"] = str(state["area_id"])
            state["driven_by_trip_id"] = (
                str(state["driven_by_trip_id"]) if state["driven_by_trip_id"] else None
            )
    from trips.services.coverage_processing import notify_coverage_updated

    await notify_coverage_updated()
    return result
