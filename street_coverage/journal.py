"""Exact, current-network history projections for Coverage Field Journal."""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from beanie import PydanticObjectId
from pymongo import ReturnDocument

from core.date_utils import normalize_to_utc_datetime
from db.models import (
    CoverageArea,
    CoverageDriveEvent,
    CoverageJournalRollup,
    CoverageState,
    CoverageStatusEvent,
    Street,
)

logger = logging.getLogger(__name__)

JOURNAL_MATCHING_VERSION = "coverage-v1"
JOURNAL_RANGES = {"all", "365d", "90d"}
JOURNAL_SOURCES = {"all", "trip", "manual"}
MILESTONE_THRESHOLDS = (10, 25, 50, 75, 100)


def normalize_journal_range(value: str | None) -> str:
    normalized = str(value or "all").strip().lower()
    return normalized if normalized in JOURNAL_RANGES else "all"


def normalize_journal_source(value: str | None) -> str:
    normalized = str(value or "all").strip().lower()
    return normalized if normalized in JOURNAL_SOURCES else "all"


def normalize_timezone(value: str | None) -> str:
    candidate = str(value or "UTC").strip() or "UTC"
    try:
        ZoneInfo(candidate)
    except ZoneInfoNotFoundError:
        return "UTC"
    return candidate


def normalize_street_name(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(str(value).split()).strip()
    return cleaned or None


def normalize_street_key(value: str | None) -> str:
    name = normalize_street_name(value)
    return name.casefold() if name else ""


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _range_start(range_key: str, as_of: datetime) -> datetime | None:
    if range_key == "365d":
        return as_of - timedelta(days=365)
    if range_key == "90d":
        return as_of - timedelta(days=90)
    return None


async def mark_journal_pending(area_id: PydanticObjectId, *, session=None) -> int:
    """Advance an area's journal revision and mark its projection stale."""
    snapshot = await CoverageArea.get_pymongo_collection().find_one_and_update(
        {"_id": area_id},
        {
            "$inc": {"journal_revision": 1},
            "$set": {"journal_status": "pending"},
        },
        return_document=ReturnDocument.AFTER,
        **({"session": session} if session else {}),
    )
    return int((snapshot or {}).get("journal_revision", 0) or 0)


async def upsert_drive_event(
    *,
    area_id: PydanticObjectId,
    area_version: int,
    trip_id: PydanticObjectId,
    driven_at: datetime,
    segment_ids: list[str],
    timezone: str | None,
    geometry_source: str,
    matching_mode: str,
    newly_driven_segment_ids: list[str] | None = None,
    invalidate: bool = True,
) -> None:
    """Idempotently store one historical trip's area matches."""
    deduped = sorted({str(segment_id) for segment_id in segment_ids if segment_id})
    if not deduped:
        return
    existing = await CoverageDriveEvent.find_one(
        {
            "area_id": area_id,
            "area_version": int(area_version),
            "trip_id": trip_id,
        },
    )
    normalized_driven_at = normalize_to_utc_datetime(driven_at) or driven_at
    unchanged = bool(
        existing
        and sorted(existing.segment_ids) == deduped
        and existing.driven_at == normalized_driven_at
        and existing.geometry_source == geometry_source
        and existing.matching_mode == matching_mode
    )
    if unchanged:
        return
    now = datetime.now(UTC)
    await CoverageDriveEvent.get_pymongo_collection().update_one(
        {
            "area_id": area_id,
            "area_version": int(area_version),
            "trip_id": trip_id,
        },
        {
            "$set": {
                "driven_at": driven_at,
                "timezone": timezone,
                "geometry_source": geometry_source,
                "matching_mode": matching_mode,
                "matching_version": JOURNAL_MATCHING_VERSION,
                "segment_ids": deduped,
                "updated_at": now,
            },
            "$setOnInsert": {
                "area_id": area_id,
                "area_version": int(area_version),
                "trip_id": trip_id,
                "created_at": now,
            },
        },
        upsert=True,
    )
    if invalidate:
        area_before = await CoverageArea.get(area_id)
        previous_revision = int(area_before.journal_revision or 0) if area_before else 0
        target_revision = await mark_journal_pending(area_id)
        if existing is not None:
            await rebuild_journal_rollup(area_id)
            return
        incremented = await _increment_journal_rollup(
            area_id=area_id,
            area_version=area_version,
            trip_id=trip_id,
            driven_at=normalized_driven_at,
            segment_ids=deduped,
            newly_driven_segment_ids=sorted(
                {
                    str(segment_id)
                    for segment_id in (newly_driven_segment_ids or [])
                    if segment_id
                },
            ),
            previous_revision=previous_revision,
            target_revision=target_revision,
        )
        if not incremented:
            logger.debug(
                "Journal rollup for %s left pending for a full rebuild",
                area_id,
            )


async def append_status_event(
    *,
    area_id: PydanticObjectId,
    area_version: int,
    action: str,
    segment_ids: list[str],
    source: str = "manual",
    occurred_at: datetime | None = None,
    coverage_before: float | None = None,
    coverage_after: float | None = None,
    driven_miles_before: float | None = None,
    driven_miles_after: float | None = None,
) -> CoverageStatusEvent | None:
    """Append an owner-authored state change to the coverage journal."""
    if source != "manual":
        return None
    deduped = sorted({str(segment_id) for segment_id in segment_ids if segment_id})
    if not deduped:
        return None
    event = CoverageStatusEvent(
        area_id=area_id,
        area_version=int(area_version),
        action=action,
        source=source,
        occurred_at=occurred_at or datetime.now(UTC),
        segment_ids=deduped,
        coverage_before=coverage_before,
        coverage_after=coverage_after,
        driven_miles_before=driven_miles_before,
        driven_miles_after=driven_miles_after,
    )
    await event.insert()
    await mark_journal_pending(area_id)
    return event


async def clear_journal_data(area_id: PydanticObjectId) -> None:
    """Remove all rebuildable Journal facts and projections for an area."""
    await CoverageDriveEvent.find({"area_id": area_id}).delete()
    await CoverageStatusEvent.find({"area_id": area_id}).delete()
    await CoverageJournalRollup.find({"area_id": area_id}).delete()
    await CoverageArea.get_pymongo_collection().update_one(
        {"_id": area_id},
        {
            "$inc": {"journal_revision": 1},
            "$set": {"journal_status": "pending", "journal_built_at": None},
        },
    )


def _street_label(street: Street | None) -> str:
    return (
        normalize_street_name(street.street_name if street else None) or "Unnamed road"
    )


def _candidate(
    *,
    occurred_at: datetime,
    source: str,
    segment_ids: list[str],
    trip_id: str | None = None,
    action: str = "mark_driven",
) -> dict[str, Any]:
    priority = {"trip": 0, "manual": 1, "unattributed": 2}.get(source, 3)
    return {
        "occurred_at": occurred_at,
        "source": source,
        "segment_ids": segment_ids,
        "trip_id": trip_id,
        "action": action,
        "priority": priority,
    }


async def _increment_journal_rollup(
    *,
    area_id: PydanticObjectId,
    area_version: int,
    trip_id: PydanticObjectId,
    driven_at: datetime,
    segment_ids: list[str],
    newly_driven_segment_ids: list[str],
    previous_revision: int,
    target_revision: int,
) -> bool:
    """Advance a ready rollup for one normal, in-order historical trip."""
    area = await CoverageArea.get(area_id)
    rollup = await CoverageJournalRollup.find_one(
        {
            "area_id": area_id,
            "area_version": int(area_version),
            "revision": int(previous_revision),
            "status": "ready",
        },
    )
    if area is None or rollup is None:
        return False

    high_water = normalize_to_utc_datetime(rollup.through_trip_endtime)
    if high_water is not None and driven_at < high_water:
        await rebuild_journal_rollup(area_id)
        return True

    street_docs = await Street.find(
        {
            "area_id": area_id,
            "area_version": int(area_version),
            "segment_id": {"$in": segment_ids},
        },
    ).to_list()
    street_by_id = {street.segment_id: street for street in street_docs}
    if not street_by_id:
        return False
    state_docs = await CoverageState.find(
        {"area_id": area_id, "segment_id": {"$in": list(street_by_id)}},
    ).to_list()
    state_by_id = {state.segment_id: state for state in state_docs}
    currently_driven = {
        segment_id
        for segment_id, state in state_by_id.items()
        if state.status == "driven"
    }

    data = deepcopy(rollup.data or {})
    data["area"] = {
        **(data.get("area") or {}),
        "id": str(area.id),
        "display_name": area.display_name,
        "coverage_percentage": round(float(area.coverage_percentage or 0.0), 2),
        "driven_length_miles": round(float(area.driven_length_miles or 0.0), 3),
        "driveable_length_miles": round(
            float(area.driveable_length_miles or 0.0),
            3,
        ),
        "total_segments": int(area.total_segments or 0),
        "driven_segments": int(area.driven_segments or 0),
        "bounding_box": area.bounding_box,
    }

    segment_metrics = data.setdefault("segment_metrics", {})
    named_touched: dict[str, list[Street]] = defaultdict(list)
    for street in street_docs:
        segment_id = street.segment_id
        state = state_by_id.get(segment_id)
        metric = segment_metrics.setdefault(segment_id, {})
        if segment_id in currently_driven:
            metric["trip_count"] = int(metric.get("trip_count", 0) or 0) + 1
            key = normalize_street_key(street.street_name)
            if key:
                named_touched[key].append(street)
        metric.update(
            {
                "status": state.status if state else "undriven",
                "street_key": normalize_street_key(street.street_name),
                "first_driven_at": _iso(state.first_driven_at if state else None),
                "last_driven_at": _iso(state.last_driven_at if state else None),
                "manually_marked": bool(state.manually_marked) if state else False,
            },
        )

    street_ranking_by_key = {
        row.get("street_key"): row for row in data.get("street_rankings") or []
    }
    for key, touched in named_touched.items():
        representative_name = normalize_street_name(touched[0].street_name)
        normalized_parts = (representative_name or "").split()
        name_pattern = (
            r"^\s*"
            + r"\s+".join(re.escape(part) for part in normalized_parts)
            + r"\s*$"
        )
        network_docs = await Street.find(
            {
                "area_id": area_id,
                "area_version": int(area_version),
                "street_name": {"$regex": name_pattern, "$options": "i"},
            },
        ).to_list()
        network_ids = [street.segment_id for street in network_docs]
        network_states = await CoverageState.find(
            {"area_id": area_id, "segment_id": {"$in": network_ids}},
        ).to_list()
        driven_network_ids = {
            state.segment_id for state in network_states if state.status == "driven"
        }
        length_miles = sum(
            float(street.length_miles or 0.0)
            for street in network_docs
            if street.segment_id in driven_network_ids
        )
        ranking = street_ranking_by_key.get(key)
        if ranking is None:
            ranking = {
                "street_key": key,
                "street_name": representative_name or "Unnamed road",
                "trip_count": 0,
            }
            street_ranking_by_key[key] = ranking
        ranking["trip_count"] = int(ranking.get("trip_count", 0) or 0) + 1
        ranking["length_miles"] = round(length_miles, 3)
        ranking["segment_ids"] = sorted(network_ids)
        ranking["first_driven_at"] = min(
            filter(
                None,
                [ranking.get("first_driven_at"), _iso(driven_at)],
            ),
            default=_iso(driven_at),
        )
        ranking["last_driven_at"] = max(
            filter(
                None,
                [ranking.get("last_driven_at"), _iso(driven_at)],
            ),
            default=_iso(driven_at),
        )
    street_rankings = list(street_ranking_by_key.values())
    street_rankings.sort(
        key=lambda row: (
            -int(row.get("trip_count", 0) or 0),
            -float(row.get("length_miles", 0.0) or 0.0),
            str(row.get("street_name") or ""),
        ),
    )
    data["street_rankings"] = street_rankings

    new_ids = [
        segment_id
        for segment_id in newly_driven_segment_ids
        if segment_id in street_by_id and segment_id in currently_driven
    ]
    contributions = data.setdefault("contributions", [])
    if new_ids:
        new_miles = sum(
            float(street_by_id[segment_id].length_miles or 0.0)
            for segment_id in new_ids
        )
        coverage_after = round(float(area.coverage_percentage or 0.0), 2)
        coverage_before = (
            round(float(contributions[-1].get("coverage_after") or 0.0), 2)
            if contributions
            else max(
                0.0,
                round(
                    coverage_after
                    - (new_miles / float(area.driveable_length_miles or 1.0) * 100.0),
                    2,
                ),
            )
        )
        name_miles: dict[str, float] = defaultdict(float)
        for segment_id in new_ids:
            name_miles[_street_label(street_by_id[segment_id])] += float(
                street_by_id[segment_id].length_miles or 0.0,
            )
        street_names = [
            name
            for name, _miles in sorted(
                name_miles.items(),
                key=lambda pair: (-pair[1], pair[0].casefold()),
            )[:4]
        ]
        contribution = {
            "occurred_at": _iso(driven_at),
            "source": "trip",
            "trip_id": str(trip_id),
            "action": "mark_driven",
            "new_segment_ids": new_ids,
            "new_segments": len(new_ids),
            "new_miles": round(new_miles, 4),
            "coverage_before": coverage_before,
            "coverage_after": coverage_after,
            "resulting_miles": round(float(area.driven_length_miles or 0.0), 4),
            "street_names": street_names,
        }
        previous_at = (
            normalize_to_utc_datetime(contributions[-1].get("occurred_at"))
            if contributions
            else None
        )
        contributions.append(contribution)

        milestones = data.setdefault("milestones", [])
        if len(contributions) == 1:
            milestones.append(
                {
                    "key": "first",
                    "label": "First mark",
                    "threshold": 0,
                    "reached_at": contribution["occurred_at"],
                    "coverage": coverage_after,
                    "street_names": street_names,
                    "new_segment_ids": new_ids,
                },
            )
        for threshold in MILESTONE_THRESHOLDS:
            if coverage_before < threshold <= coverage_after and not any(
                milestone.get("key") == f"pct-{threshold}" for milestone in milestones
            ):
                milestones.append(
                    {
                        "key": f"pct-{threshold}",
                        "label": f"{threshold}% covered",
                        "threshold": threshold,
                        "reached_at": contribution["occurred_at"],
                        "coverage": coverage_after,
                        "street_names": street_names,
                        "new_segment_ids": new_ids,
                    },
                )

        records = data.setdefault("records", {})
        if not records.get("first_covered_at"):
            records["first_covered_at"] = contribution["occurred_at"]
        records["last_new_street_at"] = contribution["occurred_at"]
        records["last_new_street_names"] = street_names
        if float(contribution["new_miles"]) > float(
            (records.get("biggest_push") or {}).get("new_miles", 0.0),
        ):
            records["biggest_push"] = contribution
        if previous_at is not None:
            pause_days = (driven_at - previous_at).total_seconds() / 86400.0
            records["longest_pause_days"] = round(
                max(float(records.get("longest_pause_days", 0.0) or 0.0), pause_days),
                1,
            )

        road_class_by_name = {
            row.get("road_class"): row for row in data.get("road_classes") or []
        }
        frontier_by_key = {
            row.get("street_key"): row for row in data.get("frontier") or []
        }
        for segment_id in new_ids:
            street = street_by_id[segment_id]
            length_miles = float(street.length_miles or 0.0)
            road_class = str(street.highway_type or "unclassified")
            bucket = road_class_by_name.get(road_class)
            if bucket:
                bucket["driven_segments"] = int(bucket.get("driven_segments", 0)) + 1
                bucket["remaining_segments"] = max(
                    0,
                    int(bucket.get("remaining_segments", 0)) - 1,
                )
                bucket["driven_miles"] = round(
                    float(bucket.get("driven_miles", 0.0)) + length_miles,
                    3,
                )
                bucket["remaining_miles"] = round(
                    max(0.0, float(bucket.get("remaining_miles", 0.0)) - length_miles),
                    3,
                )
                driveable = max(
                    0.0,
                    float(bucket.get("total_miles", 0.0))
                    - float(bucket.get("undriveable_miles", 0.0)),
                )
                bucket["coverage_percentage"] = round(
                    min(100.0, float(bucket["driven_miles"]) / driveable * 100.0)
                    if driveable
                    else 0.0,
                    2,
                )
            key = normalize_street_key(street.street_name)
            frontier = frontier_by_key.get(key)
            if frontier:
                frontier["segment_ids"] = [
                    value
                    for value in frontier.get("segment_ids") or []
                    if value != segment_id
                ]
                frontier["segments"] = len(frontier["segment_ids"])
                frontier["length_miles"] = round(
                    max(0.0, float(frontier.get("length_miles", 0.0)) - length_miles),
                    3,
                )
                if not frontier["segment_ids"]:
                    frontier_by_key.pop(key, None)
        data["road_classes"] = sorted(
            road_class_by_name.values(),
            key=lambda row: (
                -float(row.get("total_miles", 0.0) or 0.0),
                str(row.get("road_class") or ""),
            ),
        )
        data["frontier"] = sorted(
            frontier_by_key.values(),
            key=lambda row: (
                -float(row.get("length_miles", 0.0) or 0.0),
                str(row.get("street_name") or ""),
            ),
        )

    records = data.setdefault("records", {})
    records["historical_trip_count"] = (
        int(
            records.get("historical_trip_count", 0) or 0,
        )
        + 1
    )
    now = datetime.now(UTC)
    result = await CoverageJournalRollup.get_pymongo_collection().update_one(
        {
            "_id": rollup.id,
            "revision": int(previous_revision),
        },
        {
            "$set": {
                "revision": int(target_revision),
                "status": "ready",
                "built_at": now,
                "through_trip_endtime": max(
                    filter(None, [high_water, driven_at]),
                    default=driven_at,
                ),
                "data": data,
            },
        },
    )
    if int(getattr(result, "modified_count", 0) or 0) != 1:
        return False
    await CoverageArea.get_pymongo_collection().update_one(
        {"_id": area_id, "journal_revision": int(target_revision)},
        {"$set": {"journal_status": "ready", "journal_built_at": now}},
    )
    return True


async def rebuild_journal_rollup(
    area_id: PydanticObjectId,
) -> CoverageJournalRollup:
    """Rebuild one area's Journal read model from current streets and facts."""
    area = await CoverageArea.get(area_id)
    if area is None:
        raise ValueError(f"Coverage area not found: {area_id}")

    target_revision = int(area.journal_revision or 0)
    await area.set({"journal_status": "building"})

    streets = await Street.find(
        {"area_id": area_id, "area_version": area.area_version},
    ).to_list()
    states = await CoverageState.find({"area_id": area_id}).to_list()
    drive_events = (
        await CoverageDriveEvent.find(
            {"area_id": area_id, "area_version": area.area_version},
        )
        .sort([("driven_at", 1), ("_id", 1)])
        .to_list()
    )
    status_events = (
        await CoverageStatusEvent.find(
            {"area_id": area_id, "area_version": area.area_version},
        )
        .sort([("occurred_at", 1), ("_id", 1)])
        .to_list()
    )

    recorded_manual_ids = {
        segment_id for event in status_events for segment_id in event.segment_ids
    }
    baseline_events: list[CoverageStatusEvent] = []
    for state in states:
        if not state.manually_marked or state.segment_id in recorded_manual_ids:
            continue
        action = (
            "mark_driven"
            if state.status == "driven"
            else "mark_undriveable"
            if state.status == "undriveable"
            else "mark_undriven"
        )
        baseline_events.append(
            CoverageStatusEvent(
                area_id=area_id,
                area_version=area.area_version,
                action=action,
                source="manual",
                occurred_at=(
                    state.marked_at
                    or state.first_driven_at
                    or state.last_driven_at
                    or area.created_at
                ),
                segment_ids=[state.segment_id],
            ),
        )
    if baseline_events:
        await CoverageStatusEvent.insert_many(baseline_events)
        status_events.extend(baseline_events)
        status_events.sort(key=lambda event: (event.occurred_at, str(event.id or "")))

    street_by_id = {street.segment_id: street for street in streets}
    state_by_id = {state.segment_id: state for state in states}
    driven_ids = {
        segment_id
        for segment_id, state in state_by_id.items()
        if state.status == "driven" and segment_id in street_by_id
    }
    candidates: list[dict[str, Any]] = [
        _candidate(
            occurred_at=event.driven_at,
            source="trip",
            trip_id=str(event.trip_id),
            segment_ids=[sid for sid in event.segment_ids if sid in driven_ids],
        )
        for event in drive_events
    ]
    candidates.extend(
        _candidate(
            occurred_at=event.occurred_at,
            source="manual",
            segment_ids=[sid for sid in event.segment_ids if sid in driven_ids],
        )
        for event in status_events
        if event.action == "mark_driven"
    )
    for segment_id in driven_ids:
        state = state_by_id[segment_id]
        candidates.append(
            _candidate(
                occurred_at=(
                    state.first_driven_at or state.marked_at or area.created_at
                ),
                source="manual" if state.manually_marked else "unattributed",
                segment_ids=[segment_id],
            ),
        )

    candidates.sort(
        key=lambda item: (
            item["occurred_at"],
            item["priority"],
            item.get("trip_id") or "",
        ),
    )

    denominator = max(0.0, float(area.driveable_length_miles or 0.0))
    seen: set[str] = set()
    cumulative_miles = 0.0
    contributions: list[dict[str, Any]] = []

    for item in candidates:
        new_ids = [sid for sid in item["segment_ids"] if sid not in seen]
        if not new_ids:
            continue
        seen.update(new_ids)
        new_miles = sum(float(street_by_id[sid].length_miles or 0.0) for sid in new_ids)
        coverage_before = (
            min(100.0, cumulative_miles / denominator * 100.0) if denominator else 0.0
        )
        cumulative_miles += new_miles
        coverage_after = (
            min(100.0, cumulative_miles / denominator * 100.0) if denominator else 0.0
        )
        name_miles: dict[str, float] = defaultdict(float)
        for sid in new_ids:
            name_miles[_street_label(street_by_id[sid])] += float(
                street_by_id[sid].length_miles or 0.0,
            )
        representative = [
            name
            for name, _miles in sorted(
                name_miles.items(),
                key=lambda pair: (-pair[1], pair[0].casefold()),
            )[:4]
        ]
        contributions.append(
            {
                "occurred_at": _iso(item["occurred_at"]),
                "source": item["source"],
                "trip_id": item.get("trip_id"),
                "action": item.get("action") or "mark_driven",
                "new_segment_ids": new_ids,
                "new_segments": len(new_ids),
                "new_miles": round(new_miles, 4),
                "coverage_before": round(coverage_before, 2),
                "coverage_after": round(coverage_after, 2),
                "street_names": representative,
            },
        )

    # The read model is normalized to current effective coverage. Keep its last
    # point bit-for-bit aligned with the cached area statistics.
    if contributions:
        contributions[-1]["coverage_after"] = round(
            float(area.coverage_percentage or 0.0),
            2,
        )
        contributions[-1]["resulting_miles"] = round(
            float(area.driven_length_miles or cumulative_miles),
            4,
        )

    milestones: list[dict[str, Any]] = []
    if contributions:
        first = contributions[0]
        milestones.append(
            {
                "key": "first",
                "label": "First mark",
                "threshold": 0,
                "reached_at": first["occurred_at"],
                "coverage": first["coverage_after"],
                "street_names": first["street_names"],
                "new_segment_ids": first["new_segment_ids"],
            },
        )
        for threshold in MILESTONE_THRESHOLDS:
            crossing = next(
                (
                    contribution
                    for contribution in contributions
                    if float(contribution["coverage_after"]) >= threshold
                ),
                None,
            )
            if crossing is not None:
                milestones.append(
                    {
                        "key": f"pct-{threshold}",
                        "label": f"{threshold}% covered",
                        "threshold": threshold,
                        "reached_at": crossing["occurred_at"],
                        "coverage": crossing["coverage_after"],
                        "street_names": crossing["street_names"],
                        "new_segment_ids": crossing["new_segment_ids"],
                    },
                )
        deduped_milestones: list[dict[str, Any]] = []
        seen_crossings: set[tuple[str | None, float]] = set()
        for milestone in milestones:
            fingerprint = (
                milestone.get("reached_at"),
                round(float(milestone.get("coverage") or 0.0), 2),
            )
            if fingerprint in seen_crossings:
                continue
            seen_crossings.add(fingerprint)
            deduped_milestones.append(milestone)
        milestones = deduped_milestones

    segment_trip_sets: dict[str, set[str]] = defaultdict(set)
    street_trip_sets: dict[str, set[str]] = defaultdict(set)
    street_driven_segment_ids: dict[str, set[str]] = defaultdict(set)
    street_network_segment_ids: dict[str, set[str]] = defaultdict(set)
    street_last: dict[str, datetime] = {}
    street_first: dict[str, datetime] = {}
    for event in drive_events:
        trip_key = str(event.trip_id)
        event_street_keys: set[str] = set()
        for segment_id in event.segment_ids:
            if segment_id not in driven_ids:
                continue
            segment_trip_sets[segment_id].add(trip_key)
            street = street_by_id.get(segment_id)
            key = normalize_street_key(street.street_name if street else None)
            if not key:
                continue
            event_street_keys.add(key)
            street_driven_segment_ids[key].add(segment_id)
            street_first[key] = min(
                street_first.get(key, event.driven_at), event.driven_at
            )
            street_last[key] = max(
                street_last.get(key, event.driven_at), event.driven_at
            )
        for key in event_street_keys:
            street_trip_sets[key].add(trip_key)

    for street in streets:
        key = normalize_street_key(street.street_name)
        if key:
            street_network_segment_ids[key].add(street.segment_id)

    street_rankings: list[dict[str, Any]] = []
    for key, trip_ids in street_trip_sets.items():
        driven_segment_ids = sorted(street_driven_segment_ids[key])
        segment_ids = sorted(street_network_segment_ids[key])
        if not driven_segment_ids or not segment_ids:
            continue
        street_rankings.append(
            {
                "street_key": key,
                "street_name": _street_label(street_by_id[driven_segment_ids[0]]),
                "trip_count": len(trip_ids),
                "length_miles": round(
                    sum(
                        float(street_by_id[sid].length_miles or 0.0)
                        for sid in driven_segment_ids
                    ),
                    3,
                ),
                "first_driven_at": _iso(street_first.get(key)),
                "last_driven_at": _iso(street_last.get(key)),
                "segment_ids": segment_ids,
            },
        )
    street_rankings.sort(
        key=lambda row: (
            -int(row["trip_count"]),
            -float(row["length_miles"]),
            row["street_name"],
        ),
    )

    road_classes: dict[str, dict[str, Any]] = {}
    frontier_names: dict[str, dict[str, Any]] = {}
    segment_metrics: dict[str, dict[str, Any]] = {}
    for street in streets:
        state = state_by_id.get(street.segment_id)
        current_status = state.status if state else "undriven"
        length_miles = float(street.length_miles or 0.0)
        road_class = str(street.highway_type or "unclassified")
        bucket = road_classes.setdefault(
            road_class,
            {
                "road_class": road_class,
                "total_segments": 0,
                "driven_segments": 0,
                "remaining_segments": 0,
                "undriveable_segments": 0,
                "total_miles": 0.0,
                "driven_miles": 0.0,
                "remaining_miles": 0.0,
                "undriveable_miles": 0.0,
            },
        )
        bucket["total_segments"] += 1
        bucket["total_miles"] += length_miles
        if current_status == "driven":
            bucket["driven_segments"] += 1
            bucket["driven_miles"] += length_miles
        elif current_status == "undriveable":
            bucket["undriveable_segments"] += 1
            bucket["undriveable_miles"] += length_miles
        else:
            bucket["remaining_segments"] += 1
            bucket["remaining_miles"] += length_miles
            key = normalize_street_key(street.street_name)
            if key:
                frontier = frontier_names.setdefault(
                    key,
                    {
                        "street_key": key,
                        "street_name": _street_label(street),
                        "length_miles": 0.0,
                        "segments": 0,
                        "segment_ids": [],
                    },
                )
                frontier["length_miles"] += length_miles
                frontier["segments"] += 1
                frontier["segment_ids"].append(street.segment_id)

        segment_metrics[street.segment_id] = {
            "status": current_status,
            "street_key": normalize_street_key(street.street_name),
            "trip_count": len(segment_trip_sets.get(street.segment_id, set())),
            "first_driven_at": _iso(state.first_driven_at if state else None),
            "last_driven_at": _iso(state.last_driven_at if state else None),
            "manually_marked": bool(state.manually_marked) if state else False,
        }

    for bucket in road_classes.values():
        driveable = max(0.0, bucket["total_miles"] - bucket["undriveable_miles"])
        bucket["coverage_percentage"] = round(
            min(100.0, bucket["driven_miles"] / driveable * 100.0)
            if driveable
            else 0.0,
            2,
        )
        for key in (
            "total_miles",
            "driven_miles",
            "remaining_miles",
            "undriveable_miles",
        ):
            bucket[key] = round(float(bucket[key]), 3)

    frontier = sorted(
        frontier_names.values(),
        key=lambda row: (-float(row["length_miles"]), row["street_name"]),
    )
    for row in frontier:
        row["length_miles"] = round(float(row["length_miles"]), 3)

    pauses: list[float] = []
    for previous, current in pairwise(contributions):
        previous_at = normalize_to_utc_datetime(previous["occurred_at"])
        current_at = normalize_to_utc_datetime(current["occurred_at"])
        if previous_at and current_at:
            pauses.append((current_at - previous_at).total_seconds() / 86400.0)
    biggest_push = max(
        contributions,
        key=lambda contribution: float(contribution["new_miles"]),
        default=None,
    )
    newest = contributions[-1] if contributions else None

    now = datetime.now(UTC)
    through_trip_endtime = max(
        filter(
            None,
            [
                normalize_to_utc_datetime(area.last_backfill_trip_endtime),
                *(event.driven_at for event in drive_events),
            ],
        ),
        default=None,
    )
    data = {
        "area": {
            "id": str(area.id),
            "display_name": area.display_name,
            "area_type": area.area_type,
            "coverage_percentage": round(float(area.coverage_percentage or 0.0), 2),
            "driven_length_miles": round(float(area.driven_length_miles or 0.0), 3),
            "driveable_length_miles": round(
                float(area.driveable_length_miles or 0.0), 3
            ),
            "total_segments": int(area.total_segments or 0),
            "driven_segments": int(area.driven_segments or 0),
            "bounding_box": area.bounding_box,
        },
        "milestones": milestones,
        "contributions": contributions,
        "street_rankings": street_rankings,
        "road_classes": sorted(
            road_classes.values(),
            key=lambda row: (-float(row["total_miles"]), row["road_class"]),
        ),
        "frontier": frontier,
        "segment_metrics": segment_metrics,
        "records": {
            "first_covered_at": contributions[0]["occurred_at"]
            if contributions
            else None,
            "last_new_street_at": newest["occurred_at"] if newest else None,
            "last_new_street_names": newest["street_names"] if newest else [],
            "biggest_push": biggest_push,
            "longest_pause_days": round(max(pauses), 1) if pauses else 0.0,
            "historical_trip_count": len(drive_events),
        },
        "status_notes": [
            {
                "occurred_at": _iso(event.occurred_at),
                "source": "manual",
                "action": event.action,
                "segment_ids": event.segment_ids,
                "new_segments": 0,
                "new_miles": 0.0,
                "coverage_before": event.coverage_before,
                "coverage_after": event.coverage_after,
                "driven_miles_before": event.driven_miles_before,
                "driven_miles_after": event.driven_miles_after,
                "street_names": [
                    _street_label(street_by_id.get(segment_id))
                    for segment_id in event.segment_ids[:4]
                    if segment_id in street_by_id
                ],
            }
            for event in status_events
            if event.action != "mark_driven"
        ],
        "methodology": (
            "History is reconstructed from stored Bouncie trips against the current "
            "boundary, road filter, and street inventory."
        ),
    }

    await CoverageJournalRollup.get_pymongo_collection().update_one(
        {"area_id": area_id, "area_version": area.area_version},
        {
            "$set": {
                "revision": target_revision,
                "status": "ready",
                "built_at": now,
                "through_trip_endtime": through_trip_endtime,
                "data": data,
            },
            "$setOnInsert": {
                "area_id": area_id,
                "area_version": area.area_version,
            },
        },
        upsert=True,
    )
    await CoverageArea.get_pymongo_collection().update_one(
        {
            "_id": area_id,
            "area_version": area.area_version,
            "journal_revision": target_revision,
        },
        {
            "$set": {
                "journal_status": "ready",
                "journal_built_at": now,
            },
        },
    )
    rollup = await CoverageJournalRollup.find_one(
        {"area_id": area_id, "area_version": area.area_version},
    )
    if rollup is None:  # pragma: no cover - guarded by successful upsert
        raise RuntimeError("Coverage Journal rollup was not persisted")
    return rollup


async def ensure_journal_rollup(area_id: PydanticObjectId) -> CoverageJournalRollup:
    area = await CoverageArea.get(area_id)
    if area is None:
        raise ValueError(f"Coverage area not found: {area_id}")
    rollup = await CoverageJournalRollup.find_one(
        {"area_id": area_id, "area_version": area.area_version},
    )
    if rollup is None or int(rollup.revision) != int(area.journal_revision or 0):
        return await rebuild_journal_rollup(area_id)
    return rollup


def _bucket_contributions(
    contributions: list[dict[str, Any]],
    *,
    timezone: str,
) -> list[dict[str, Any]]:
    zone = ZoneInfo(timezone)
    buckets: dict[str, dict[str, Any]] = {}
    for contribution in contributions:
        occurred_at = normalize_to_utc_datetime(contribution.get("occurred_at"))
        if occurred_at is None:
            continue
        day = occurred_at.astimezone(zone).date().isoformat()
        bucket = buckets.setdefault(
            day,
            {
                "date": day,
                "new_miles": 0.0,
                "new_segments": 0,
                "coverage_percentage": contribution.get("coverage_before", 0.0),
                "contributions": 0,
            },
        )
        bucket["new_miles"] += float(contribution.get("new_miles") or 0.0)
        bucket["new_segments"] += int(contribution.get("new_segments") or 0)
        bucket["coverage_percentage"] = float(
            contribution.get("coverage_after") or bucket["coverage_percentage"],
        )
        bucket["contributions"] += 1
    result = [buckets[key] for key in sorted(buckets)]
    for bucket in result:
        bucket["new_miles"] = round(float(bucket["new_miles"]), 3)
        bucket["coverage_percentage"] = round(
            float(bucket["coverage_percentage"]),
            2,
        )
    return result


async def _period_rankings(
    area: CoverageArea,
    *,
    start: datetime | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    query: dict[str, Any] = {
        "area_id": area.id,
        "area_version": area.area_version,
    }
    if start is not None:
        query["driven_at"] = {"$gte": start}
    events = await CoverageDriveEvent.find(query).to_list()
    streets = await Street.find(
        {"area_id": area.id, "area_version": area.area_version},
    ).to_list()
    states = await CoverageState.find(
        {"area_id": area.id, "status": "driven"},
    ).to_list()
    driven_ids = {state.segment_id for state in states}
    street_by_id = {street.segment_id: street for street in streets}

    segment_trips: dict[str, set[str]] = defaultdict(set)
    segment_first: dict[str, datetime] = {}
    segment_last: dict[str, datetime] = {}
    street_trips: dict[str, set[str]] = defaultdict(set)
    street_segments: dict[str, set[str]] = defaultdict(set)
    first: dict[str, datetime] = {}
    last: dict[str, datetime] = {}
    for event in events:
        trip_id = str(event.trip_id)
        touched_streets: set[str] = set()
        for segment_id in event.segment_ids:
            if segment_id not in driven_ids or segment_id not in street_by_id:
                continue
            segment_trips[segment_id].add(trip_id)
            segment_first[segment_id] = min(
                segment_first.get(segment_id, event.driven_at),
                event.driven_at,
            )
            segment_last[segment_id] = max(
                segment_last.get(segment_id, event.driven_at),
                event.driven_at,
            )
            street = street_by_id[segment_id]
            key = normalize_street_key(street.street_name)
            if key:
                touched_streets.add(key)
                street_segments[key].add(segment_id)
                first[key] = min(first.get(key, event.driven_at), event.driven_at)
                last[key] = max(last.get(key, event.driven_at), event.driven_at)
        for key in touched_streets:
            street_trips[key].add(trip_id)

    street_rows = []
    for key, trip_ids in street_trips.items():
        segment_ids = sorted(street_segments[key])
        street_rows.append(
            {
                "street_key": key,
                "street_name": _street_label(street_by_id[segment_ids[0]]),
                "trip_count": len(trip_ids),
                "length_miles": round(
                    sum(
                        float(street_by_id[sid].length_miles or 0.0)
                        for sid in segment_ids
                    ),
                    3,
                ),
                "first_driven_at": _iso(first.get(key)),
                "last_driven_at": _iso(last.get(key)),
                "segment_ids": segment_ids,
            },
        )
    street_rows.sort(
        key=lambda row: (
            -int(row["trip_count"]),
            -float(row["length_miles"]),
            row["street_name"],
        ),
    )

    segment_rows = [
        {
            "segment_id": segment_id,
            "street_name": _street_label(street_by_id[segment_id]),
            "trip_count": len(trip_ids),
            "length_miles": round(
                float(street_by_id[segment_id].length_miles or 0.0), 4
            ),
            "first_driven_at": _iso(segment_first.get(segment_id)),
            "last_driven_at": _iso(segment_last.get(segment_id)),
        }
        for segment_id, trip_ids in segment_trips.items()
    ]
    segment_rows.sort(
        key=lambda row: (
            -int(row["trip_count"]),
            -float(row["length_miles"]),
            row["street_name"],
        ),
    )
    return (
        street_rows,
        segment_rows,
        {segment_id: len(trip_ids) for segment_id, trip_ids in segment_trips.items()},
    )


async def get_journal_payload(
    area_id: PydanticObjectId,
    *,
    range_key: str = "all",
    timezone: str = "UTC",
) -> dict[str, Any]:
    rollup = await ensure_journal_rollup(area_id)
    area = await CoverageArea.get(area_id)
    if area is None:  # pragma: no cover - ensure already checked
        raise ValueError("Coverage area not found")
    normalized_range = normalize_journal_range(range_key)
    normalized_timezone = normalize_timezone(timezone)
    as_of = datetime.now(UTC)
    start = _range_start(normalized_range, as_of)
    data = dict(rollup.data or {})

    contributions = list(data.get("contributions") or [])
    ranged_contributions = [
        contribution
        for contribution in contributions
        if start is None
        or (
            (timestamp := normalize_to_utc_datetime(contribution.get("occurred_at")))
            is not None
            and timestamp >= start
        )
    ]
    (
        period_street_rankings,
        period_segment_rankings,
        _segment_counts,
    ) = await _period_rankings(
        area,
        start=start,
    )
    all_streets = {
        row.get("street_key"): row for row in data.get("street_rankings") or []
    }
    street_rankings = []
    for period_row in period_street_rankings:
        all_time = all_streets.get(period_row.get("street_key")) or {}
        street_rankings.append(
            {
                **period_row,
                "first_driven_at": all_time.get("first_driven_at"),
                "last_driven_at": all_time.get("last_driven_at"),
                "length_miles": all_time.get(
                    "length_miles",
                    period_row.get("length_miles", 0.0),
                ),
                "segment_ids": all_time.get(
                    "segment_ids",
                    period_row.get("segment_ids", []),
                ),
                "all_time_trip_count": int(all_time.get("trip_count", 0) or 0),
                "period_trip_count": int(period_row.get("trip_count", 0) or 0),
            },
        )
    all_segments = data.get("segment_metrics") or {}
    segment_rankings = []
    for period_row in period_segment_rankings:
        all_time = all_segments.get(period_row.get("segment_id")) or {}
        segment_rankings.append(
            {
                **period_row,
                "first_driven_at": all_time.get("first_driven_at")
                or period_row.get("first_driven_at"),
                "last_driven_at": all_time.get("last_driven_at")
                or period_row.get("last_driven_at"),
                "all_time_trip_count": int(all_time.get("trip_count", 0) or 0),
                "period_trip_count": int(period_row.get("trip_count", 0) or 0),
            },
        )
    active_days = {
        normalize_to_utc_datetime(contribution.get("occurred_at"))
        .astimezone(ZoneInfo(normalized_timezone))
        .date()
        .isoformat()
        for contribution in ranged_contributions
        if normalize_to_utc_datetime(contribution.get("occurred_at")) is not None
    }

    ranged_pauses: list[float] = []
    for previous, current in pairwise(ranged_contributions):
        previous_at = normalize_to_utc_datetime(previous.get("occurred_at"))
        current_at = normalize_to_utc_datetime(current.get("occurred_at"))
        if previous_at and current_at:
            ranged_pauses.append((current_at - previous_at).total_seconds() / 86400.0)
    ranged_biggest = max(
        ranged_contributions,
        key=lambda contribution: float(contribution.get("new_miles") or 0.0),
        default=None,
    )
    base_records = data.get("records") or {}
    range_records = {
        **base_records,
        "biggest_push": ranged_biggest,
        "longest_pause_days": round(max(ranged_pauses), 1) if ranged_pauses else 0.0,
        "last_period_addition": (
            ranged_contributions[-1] if ranged_contributions else None
        ),
    }

    return {
        "success": True,
        "area": data.get("area") or {},
        "summary": {
            **(data.get("area") or {}),
            "historical_trip_count": int(
                (data.get("records") or {}).get("historical_trip_count", 0),
            ),
            "active_coverage_days": len(active_days),
            "first_covered_at": (data.get("records") or {}).get("first_covered_at"),
            "last_new_street_at": (data.get("records") or {}).get("last_new_street_at"),
            "last_new_street_names": (data.get("records") or {}).get(
                "last_new_street_names",
                [],
            ),
        },
        "milestones": data.get("milestones") or [],
        "series": _bucket_contributions(
            ranged_contributions,
            timezone=normalized_timezone,
        ),
        "records": range_records,
        "recent_contributions": sorted(
            [*(data.get("status_notes") or []), *ranged_contributions],
            key=lambda item: item.get("occurred_at") or "",
            reverse=True,
        )[:12],
        "street_rankings": street_rankings[:25],
        "segment_rankings": segment_rankings[:25],
        "road_classes": data.get("road_classes") or [],
        "frontier": (data.get("frontier") or [])[:20],
        "methodology": data.get("methodology") or "",
        "range": normalized_range,
        "timezone": normalized_timezone,
        "revision": int(rollup.revision),
        "built_at": _iso(rollup.built_at),
        "as_of": _iso(as_of),
    }


async def get_journal_contributions(
    area_id: PydanticObjectId,
    *,
    range_key: str,
    source: str,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    rollup = await ensure_journal_rollup(area_id)
    normalized_range = normalize_journal_range(range_key)
    normalized_source = normalize_journal_source(source)
    as_of = datetime.now(UTC)
    start = _range_start(normalized_range, as_of)
    data = rollup.data or {}
    items = [*(data.get("contributions") or []), *(data.get("status_notes") or [])]
    filtered = []
    for item in items:
        occurred_at = normalize_to_utc_datetime(item.get("occurred_at"))
        if occurred_at is None or (start is not None and occurred_at < start):
            continue
        item_source = str(item.get("source") or "unattributed")
        if normalized_source == "trip" and item_source not in {"trip", "unattributed"}:
            continue
        if normalized_source == "manual" and item_source != "manual":
            continue
        filtered.append(item)
    filtered.sort(key=lambda item: item.get("occurred_at") or "", reverse=True)
    try:
        offset = max(0, int(cursor or "0"))
    except ValueError:
        offset = 0
    page = filtered[offset : offset + limit]
    next_offset = offset + len(page)
    return {
        "success": True,
        "contributions": page,
        "next_cursor": str(next_offset) if next_offset < len(filtered) else None,
        "total": len(filtered),
        "revision": int(rollup.revision),
    }


async def get_journal_segments(
    area_id: PydanticObjectId,
    *,
    range_key: str,
) -> tuple[dict[str, Any], int, int]:
    rollup = await ensure_journal_rollup(area_id)
    area = await CoverageArea.get(area_id)
    if area is None:
        raise ValueError("Coverage area not found")
    normalized_range = normalize_journal_range(range_key)
    start = _range_start(normalized_range, datetime.now(UTC))
    _streets, _segments, period_counts = await _period_rankings(area, start=start)
    all_metrics = (rollup.data or {}).get("segment_metrics") or {}
    street_docs = await Street.find(
        {"area_id": area_id, "area_version": area.area_version},
    ).to_list()
    features = []
    for street in street_docs:
        metrics = all_metrics.get(street.segment_id) or {}
        features.append(
            {
                "type": "Feature",
                "geometry": street.geometry,
                "properties": {
                    "segment_id": street.segment_id,
                    "street_name": street.street_name,
                    "street_key": normalize_street_key(street.street_name),
                    "highway_type": street.highway_type,
                    "length_miles": street.length_miles,
                    "status": metrics.get("status", "undriven"),
                    "first_driven_at": metrics.get("first_driven_at"),
                    "last_driven_at": metrics.get("last_driven_at"),
                    "trip_count": int(metrics.get("trip_count", 0) or 0),
                    "period_trip_count": int(period_counts.get(street.segment_id, 0)),
                    "manually_marked": bool(metrics.get("manually_marked", False)),
                },
            },
        )
    return (
        {"type": "FeatureCollection", "features": features},
        int(rollup.revision),
        int(area.area_version),
    )
