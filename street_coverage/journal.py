"""Revisioned journal summaries and bounded, indexed history rows."""

from __future__ import annotations

import asyncio
import math
from collections import defaultdict
from datetime import UTC, datetime, time, timedelta
from itertools import pairwise
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pymongo import ReturnDocument

from core.date_utils import normalize_to_utc_datetime
from db.models import (
    CoverageArea,
    CoverageDriveEvent,
    CoverageJournalEntry,
    CoverageJournalRollup,
    CoverageState,
    CoverageStatusEvent,
    Street,
)
from street_coverage import transactions
from street_coverage.intervals import covered_fraction, union_intervals
from street_coverage.matching import MATCHING_VERSION

JOURNAL_MATCHING_VERSION = MATCHING_VERSION
JOURNAL_RANGES = {"all", "365d", "90d"}
JOURNAL_SOURCES = {"all", "trip", "manual"}
MILESTONE_THRESHOLDS = (10, 25, 50, 75, 100)


class JournalPending(ValueError):
    pass


def normalize_journal_range(value):
    return value if value in JOURNAL_RANGES else "all"


def normalize_journal_source(value):
    return value if value in JOURNAL_SOURCES else "all"


def normalize_timezone(value):
    try:
        return ZoneInfo(value or "UTC").key
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"


def normalize_street_name(value):
    return " ".join(str(value).split()) if value else None


def normalize_street_key(value):
    return (normalize_street_name(value) or "").casefold()


def _iso(value):
    value = normalize_to_utc_datetime(value)
    return value.isoformat() if value else None


def _range_start(range_key, as_of, timezone="UTC"):
    days = {"365d": 365, "90d": 90}.get(range_key)
    if not days:
        return None
    zone = ZoneInfo(normalize_timezone(timezone))
    first = as_of.astimezone(zone).date() - timedelta(days=days - 1)
    return datetime.combine(first, time.min, zone).astimezone(UTC)


async def mark_journal_pending(area_id, *, session=None):
    row = await CoverageArea.get_pymongo_collection().find_one_and_update(
        {"_id": area_id},
        {"$inc": {"journal_revision": 1}, "$set": {"journal_status": "pending"}},
        return_document=ReturnDocument.AFTER,
        session=session,
    )
    return int(row["journal_revision"]) if row else 0


async def append_status_event(**kwargs):
    """Record an owner decision as part of the caller's coverage transaction."""
    event = CoverageStatusEvent(**kwargs)
    await event.insert()
    await mark_journal_pending(event.area_id)


async def clear_journal_data(area_id):
    for model in (
        CoverageDriveEvent,
        CoverageStatusEvent,
        CoverageJournalRollup,
        CoverageJournalEntry,
    ):
        await model.find({"area_id": area_id}).delete()


def _intersection_intervals(left, right):
    return union_intervals(
        [
            [max(a, c), min(b, d)]
            for a, b in left
            for c, d in right
            if min(b, d) > max(a, c)
        ]
    )


def _build_read_model(area, streets, states, events, notes):
    street_by_id = {street.segment_id: street for street in streets}
    state_by_id = {state.segment_id: state for state in states}
    eligible = float(area.driveable_length_miles)
    timeline = []
    visits = []
    segment_trips = defaultdict(set)
    street_trips = defaultdict(set)
    for event in events:
        portions = {}
        for sid, intervals in event.segment_intervals.items():
            state = state_by_id.get(sid)
            if sid not in street_by_id or not state:
                continue
            effective = _intersection_intervals(intervals, state.intervals)
            if not effective:
                continue
            portions[sid] = effective
            segment_trips[sid].add(str(event.trip_id))
            key = normalize_street_key(street_by_id[sid].street_name)
            if key:
                street_trips[key].add(str(event.trip_id))
        if portions:
            visits.append(
                {
                    "occurred_at": _iso(event.driven_at),
                    "trip_id": str(event.trip_id),
                    "segment_ids": sorted(portions),
                    "street_keys": sorted(
                        {
                            normalize_street_key(street_by_id[sid].street_name)
                            for sid in portions
                        }
                    ),
                }
            )
            timeline.append((event.driven_at, "trip", str(event.trip_id), portions))
    for state in states:
        if (
            state.manually_marked
            and state.status == "driven"
            and state.segment_id in street_by_id
        ):
            timeline.append(
                (state.marked_at, "manual", None, {state.segment_id: [[0.0, 1.0]]})
            )
    timeline.sort(key=lambda item: (item[0], item[1], item[2] or ""))
    seen = defaultdict(list)
    cumulative = 0.0
    contributions = []
    for when, source, trip_id, portions in timeline:
        gains = {}
        completed = 0
        for sid, intervals in portions.items():
            before = covered_fraction(seen[sid])
            seen[sid] = union_intervals([*seen[sid], *intervals])
            after = covered_fraction(seen[sid])
            if after > before + 1e-12:
                gains[sid] = (after - before) * street_by_id[sid].length_miles
                completed += int(before < 1 and after == 1)
        gain = math.fsum(gains.values())
        if gain <= 0:
            continue
        before = cumulative
        cumulative += gain
        name_miles = defaultdict(float)
        for sid, miles in gains.items():
            name_miles[street_by_id[sid].street_name or "Unnamed road"] += miles
        contributions.append(
            {
                "occurred_at": _iso(when),
                "source": source,
                "trip_id": trip_id,
                "action": "mark_driven",
                "new_segment_ids": sorted(gains),
                "new_segments": completed,
                "touched_segments": len(gains),
                "new_miles": gain,
                "coverage_before": 100 * before / eligible if eligible else 0.0,
                "coverage_after": 100 * cumulative / eligible if eligible else 0.0,
                "resulting_miles": cumulative,
                "street_names": [
                    name
                    for name, _ in sorted(
                        name_miles.items(), key=lambda pair: (-pair[1], pair[0])
                    )[:4]
                ],
            }
        )
    if not math.isclose(cumulative, area.driven_length_miles, abs_tol=1e-7):
        raise ValueError(
            "Coverage history and credited mileage disagree; recalculate this area"
        )
    milestones = []
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
            }
        )
        for threshold in MILESTONE_THRESHOLDS:
            if threshold == 100 and not area.is_complete:
                continue
            crossing = next(
                (
                    row
                    for row in contributions
                    if row["coverage_after"] >= threshold - 1e-9
                ),
                None,
            )
            if crossing:
                milestones.append(
                    {
                        "key": f"pct-{threshold}",
                        "label": f"{threshold}% covered",
                        "threshold": threshold,
                        "reached_at": crossing["occurred_at"],
                        "coverage": crossing["coverage_after"],
                        "street_names": crossing["street_names"],
                        "new_segment_ids": crossing["new_segment_ids"],
                    }
                )
    road_classes = {}
    named = {}
    segment_rows = []
    for street in streets:
        state = state_by_id.get(street.segment_id)
        status = state.status if state else "undriven"
        covered = state.covered_length_miles if state else 0.0
        excluded = status == "undriveable"
        remaining = 0.0 if excluded else max(0.0, street.length_miles - covered)
        key = normalize_street_key(street.street_name)
        metric = {
            "segment_id": street.segment_id,
            "street_name": street.street_name,
            "street_key": key,
            "length_miles": street.length_miles,
            "covered_length_miles": covered,
            "remaining_length_miles": remaining,
            "status": status,
            "trip_count": len(segment_trips[street.segment_id]),
            "first_driven_at": _iso(state.first_driven_at) if state else None,
            "last_driven_at": _iso(state.last_driven_at) if state else None,
            "manually_marked": bool(state.manually_marked) if state else False,
            "coverage_fraction": state.coverage_fraction if state else 0.0,
            "intervals": state.intervals if state else [],
            "discovery_intervals": state.discovery_intervals if state else [],
        }
        segment_rows.append(metric)
        bucket = road_classes.setdefault(
            street.highway_type,
            {
                "road_class": street.highway_type,
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
        bucket["total_miles"] += street.length_miles
        bucket["driven_segments"] += int(status == "driven")
        bucket["remaining_segments"] += int(not excluded and status != "driven")
        bucket["undriveable_segments"] += int(excluded)
        bucket["driven_miles"] += covered
        bucket["remaining_miles"] += remaining
        bucket["undriveable_miles"] += street.length_miles if excluded else 0.0
        if key:
            row = named.setdefault(
                key,
                {
                    "street_key": key,
                    "street_name": street.street_name,
                    "trip_count": len(street_trips[key]),
                    "length_miles": 0.0,
                    "remaining_miles": 0.0,
                    "segment_ids": [],
                    "remaining_segment_ids": [],
                    "first_driven_at": None,
                    "last_driven_at": None,
                },
            )
            row["segment_ids"].append(street.segment_id)
            row["length_miles"] += covered
            row["remaining_miles"] += remaining
            if remaining > 0:
                row["remaining_segment_ids"].append(street.segment_id)
            for name, op in (("first_driven_at", min), ("last_driven_at", max)):
                candidates = [value for value in (row[name], metric[name]) if value]
                row[name] = op(candidates) if candidates else None
    for bucket in road_classes.values():
        denominator = bucket["total_miles"] - bucket["undriveable_miles"]
        bucket["coverage_percentage"] = (
            100 * bucket["driven_miles"] / denominator if denominator else 0.0
        )
    rankings = sorted(
        (row for row in named.values() if row["trip_count"]),
        key=lambda row: (-row["trip_count"], -row["length_miles"], row["street_key"]),
    )
    frontier = sorted(
        [
            {
                "street_key": row["street_key"],
                "street_name": row["street_name"],
                "segment_ids": row["remaining_segment_ids"],
                "segments": len(row["remaining_segment_ids"]),
                "length_miles": row["remaining_miles"],
            }
            for row in named.values()
            if row["remaining_miles"] > 0
        ],
        key=lambda row: (-row["length_miles"], row["street_key"]),
    )
    notes_data = [
        {
            "occurred_at": _iso(event.occurred_at),
            "source": "manual",
            "action": event.action,
            "segment_ids": event.segment_ids,
            "new_segments": 0,
            "new_miles": 0.0,
            "coverage_before": event.coverage_before,
            "coverage_after": event.coverage_after,
            "street_names": [
                street_by_id[sid].street_name or "Unnamed road"
                for sid in event.segment_ids[:4]
                if sid in street_by_id
            ],
        }
        for event in notes
        if event.action != "mark_driven"
    ]
    pauses = [
        (
            normalize_to_utc_datetime(b["occurred_at"])
            - normalize_to_utc_datetime(a["occurred_at"])
        ).total_seconds()
        / 86400
        for a, b in pairwise(contributions)
    ]
    area_data = {
        key: getattr(area, key)
        for key in (
            "display_name",
            "area_type",
            "coverage_percentage",
            "driven_length_miles",
            "driveable_length_miles",
            "total_segments",
            "driven_segments",
            "remaining_length_miles",
            "remaining_segments",
            "is_complete",
            "bounding_box",
        )
    }
    area_data.update({"id": str(area.id), "coverage_revision": area.journal_revision})
    header = {
        "schema": MATCHING_VERSION,
        "area": area_data,
        "milestones": milestones,
        "road_classes": list(road_classes.values()),
        "records": {
            "first_covered_at": contributions[0]["occurred_at"]
            if contributions
            else None,
            "last_new_street_at": contributions[-1]["occurred_at"]
            if contributions
            else None,
            "last_new_street_names": contributions[-1]["street_names"]
            if contributions
            else [],
            "biggest_push": max(
                contributions, key=lambda row: row["new_miles"], default=None
            ),
            "longest_pause_days": max(pauses, default=0),
            "historical_trip_count": len(events),
        },
        "methodology": "Supported traveled intervals from Bouncie history, with owner overrides, against the current eligible street inventory. Dates use trip completion time.",
    }
    return header, {
        "contribution": contributions,
        "segment": segment_rows,
        "street": rankings,
        "frontier": frontier,
        "note": notes_data,
        "visit": visits,
    }


async def rebuild_journal_rollup(area_id):
    area = await CoverageArea.get(area_id)
    if area is None:
        raise ValueError("Coverage area not found")
    if area.coverage_matching_version != MATCHING_VERSION:
        raise JournalPending("Recalculating historical coverage")
    token = uuid4().hex
    now = datetime.now(UTC)
    collection = CoverageArea.get_pymongo_collection()
    claim = await collection.update_one(
        {
            "_id": area_id,
            "$or": [
                {"journal_build_token": None},
                {"journal_build_until": {"$lte": now}},
            ],
        },
        {
            "$set": {
                "journal_build_token": token,
                "journal_build_until": now + timedelta(minutes=5),
            }
        },
    )
    if claim.modified_count != 1:
        return None
    try:
        streets, states, events, notes = await asyncio.gather(
            Street.find(
                {"area_id": area_id, "area_version": area.area_version}
            ).to_list(),
            CoverageState.find({"area_id": area_id}).to_list(),
            CoverageDriveEvent.find(
                {
                    "area_id": area_id,
                    "area_version": area.area_version,
                    "matching_version": MATCHING_VERSION,
                }
            ).to_list(),
            CoverageStatusEvent.find(
                {"area_id": area_id, "area_version": area.area_version}
            ).to_list(),
        )
        header, sections = await asyncio.to_thread(
            _build_read_model, area, streets, states, events, notes
        )
        query = {
            "area_id": area_id,
            "area_version": area.area_version,
            "revision": area.journal_revision,
        }
        entries = CoverageJournalEntry.get_pymongo_collection()
        await entries.delete_many(query)
        rows = []
        for kind, items in sections.items():
            for index, item in enumerate(items):
                key = (
                    item.get("segment_id")
                    if kind == "segment"
                    else item.get("street_key")
                    if kind in {"street", "frontier"}
                    else f"{index:09d}"
                )
                rows.append(
                    {
                        **query,
                        "kind": kind,
                        "key": key,
                        "order": index,
                        "occurred_at": normalize_to_utc_datetime(
                            item.get("occurred_at")
                        ),
                        "data": item,
                        "created_at": now,
                    }
                )
        for start in range(0, len(rows), 500):
            await entries.insert_many(rows[start : start + 500])

        async def publish(session):
            current = await CoverageArea.get(area_id, session=session)
            if (
                current is None
                or current.area_version != area.area_version
                or current.journal_revision != area.journal_revision
            ):
                return False
            await collection.update_one(
                {"_id": area_id},
                {"$set": {"journal_status": "ready", "journal_built_at": now}},
                session=session,
            )
            await CoverageJournalRollup.get_pymongo_collection().update_one(
                {"area_id": area_id, "area_version": area.area_version},
                {
                    "$set": {
                        **query,
                        "status": "ready",
                        "built_at": now,
                        "through_trip_endtime": max(
                            (event.driven_at for event in events), default=None
                        ),
                        "data": header,
                    }
                },
                upsert=True,
                session=session,
            )
            return True

        published = await transactions.run_transaction(publish)
        if published:
            await entries.delete_many(
                {
                    "area_id": area_id,
                    "revision": {"$ne": area.journal_revision},
                    "created_at": {"$lt": now - timedelta(minutes=15)},
                }
            )
        return await CoverageJournalRollup.find_one(
            {"area_id": area_id, "area_version": area.area_version}
        )
    finally:
        await collection.update_one(
            {"_id": area_id, "journal_build_token": token},
            {"$set": {"journal_build_token": None, "journal_build_until": None}},
        )


async def drain_pending_journals(_ctx=None):
    areas = (
        await CoverageArea.find(
            {
                "status": "ready",
                "coverage_matching_version": MATCHING_VERSION,
                "journal_status": {"$ne": "ready"},
            }
        )
        .limit(3)
        .to_list()
    )
    completed = 0
    for area in areas:
        try:
            completed += int(await rebuild_journal_rollup(area.id) is not None)
        except ValueError:
            continue
    if completed:
        from trips.services.coverage_processing import notify_coverage_updated

        await notify_coverage_updated()
    return {"processed": completed}


async def ensure_journal_rollup(area_id):
    area = await CoverageArea.get(area_id)
    if area is None:
        raise ValueError("Coverage area not found")
    rollup = await CoverageJournalRollup.find_one(
        {"area_id": area_id, "area_version": area.area_version}
    )
    if rollup is None or rollup.data.get("schema") != MATCHING_VERSION:
        raise JournalPending(
            "The coverage journal is updating. Please try again shortly."
        )
    return rollup


def _entry_query(rollup, kind):
    return {
        "area_id": rollup.area_id,
        "area_version": rollup.area_version,
        "revision": rollup.revision,
        "kind": kind,
    }


async def _rows(rollup, kind, *, limit=None):
    query = CoverageJournalEntry.find(_entry_query(rollup, kind)).sort("order")
    if limit is not None:
        query = query.limit(limit)
    return [row.data for row in await query.to_list()]


def _bucket_contributions(contributions, *, timezone):
    zone = ZoneInfo(timezone)
    result = {}
    for item in contributions:
        when = normalize_to_utc_datetime(item["occurred_at"])
        day = when.astimezone(zone).date().isoformat()
        row = result.setdefault(
            day,
            {
                "date": day,
                "new_miles": 0.0,
                "new_segments": 0,
                "coverage_percentage": item["coverage_before"],
                "contributions": 0,
            },
        )
        row["new_miles"] += item["new_miles"]
        row["new_segments"] += item["new_segments"]
        row["coverage_percentage"] = item["coverage_after"]
        row["contributions"] += 1
    return [result[day] for day in sorted(result)]


async def _period_rankings(rollup, start):
    if start is None:
        streets = await _rows(rollup, "street", limit=25)
        segment_docs = (
            await CoverageJournalEntry.find(
                {**_entry_query(rollup, "segment"), "data.trip_count": {"$gt": 0}}
            )
            .sort([("data.trip_count", -1), ("data.length_miles", -1)])
            .limit(25)
            .to_list()
        )
        return streets, [row.data for row in segment_docs], {}
    visits = await CoverageJournalEntry.find(
        {**_entry_query(rollup, "visit"), "occurred_at": {"$gte": start}}
    ).to_list()
    if not visits:
        return [], [], {}
    segment_trips = defaultdict(set)
    name_trips = defaultdict(set)
    for visit in visits:
        for sid in visit.data["segment_ids"]:
            segment_trips[sid].add(visit.data["trip_id"])
        for key in visit.data["street_keys"]:
            if key:
                name_trips[key].add(visit.data["trip_id"])
    street_docs = await CoverageJournalEntry.find(
        {**_entry_query(rollup, "street"), "key": {"$in": list(name_trips)}}
    ).to_list()
    segment_docs = await CoverageJournalEntry.find(
        {**_entry_query(rollup, "segment"), "key": {"$in": list(segment_trips)}}
    ).to_list()

    def ranked(docs, counts):
        rows = [
            {
                **row.data,
                "all_time_trip_count": row.data["trip_count"],
                "period_trip_count": len(counts[row.key]),
                "trip_count": len(counts[row.key]),
            }
            for row in docs
        ]
        return sorted(rows, key=lambda row: (-row["trip_count"], -row["length_miles"]))[
            :25
        ]

    return (
        ranked(street_docs, name_trips),
        ranked(segment_docs, segment_trips),
        {sid: len(ids) for sid, ids in segment_trips.items()},
    )


async def get_journal_payload(area_id, *, range_key="all", timezone="UTC"):
    rollup = await ensure_journal_rollup(area_id)
    area = await CoverageArea.get(area_id)
    timezone = normalize_timezone(timezone)
    range_key = normalize_journal_range(range_key)
    now = datetime.now(UTC)
    start = _range_start(range_key, now, timezone)
    query = _entry_query(rollup, "contribution")
    if start:
        query["occurred_at"] = {"$gte": start}
    contributions = [
        row.data
        for row in await CoverageJournalEntry.find(query).sort("occurred_at").to_list()
    ]
    streets, segments, _ = await _period_rankings(rollup, start)
    for row in [*streets, *segments]:
        row.setdefault("all_time_trip_count", row["trip_count"])
        row.setdefault("period_trip_count", row["trip_count"])
    records = rollup.data.get("records", {})
    pauses = [
        (
            normalize_to_utc_datetime(b["occurred_at"])
            - normalize_to_utc_datetime(a["occurred_at"])
        ).total_seconds()
        / 86400
        for a, b in pairwise(contributions)
    ]
    return {
        "success": True,
        "area": rollup.data["area"],
        "summary": {
            **rollup.data["area"],
            **records,
            "active_coverage_days": len(
                _bucket_contributions(contributions, timezone=timezone)
            ),
        },
        "milestones": rollup.data.get("milestones", []),
        "series": _bucket_contributions(contributions, timezone=timezone),
        "records": {
            **records,
            "last_period_addition": contributions[-1] if contributions else None,
            "longest_pause_days": max(pauses, default=0),
            "biggest_push": max(
                contributions, key=lambda row: row["new_miles"], default=None
            ),
        },
        "recent_contributions": list(reversed(contributions[-12:])),
        "street_rankings": streets,
        "segment_rankings": segments,
        "road_classes": rollup.data.get("road_classes", []),
        "frontier": await _rows(rollup, "frontier", limit=20),
        "methodology": rollup.data.get("methodology"),
        "range": range_key,
        "timezone": timezone,
        "revision": rollup.revision,
        "pending": area.journal_revision != rollup.revision,
        "built_at": _iso(rollup.built_at),
        "as_of": _iso(now),
    }


async def get_journal_contributions(
    area_id, *, range_key, source, cursor, limit, timezone="UTC"
):
    rollup = await ensure_journal_rollup(area_id)
    query = _entry_query(rollup, "contribution")
    query["kind"] = {"$in": ["contribution", "note"]}
    start = _range_start(
        normalize_journal_range(range_key), datetime.now(UTC), timezone
    )
    if start:
        query["occurred_at"] = {"$gte": start}
    source = normalize_journal_source(source)
    if source != "all":
        query["data.source"] = source
    # Cursor is a stable chronological key within this immutable revision.
    if cursor:
        import json
        import base64

        try:
            revision, when, key, kind = json.loads(
                base64.urlsafe_b64decode(cursor.encode())
            )
            if revision != rollup.revision:
                raise ValueError("Coverage changed; refresh the journal")
            stamp = normalize_to_utc_datetime(when)
            query["$or"] = [
                {"occurred_at": {"$lt": stamp}},
                {"occurred_at": stamp, "key": {"$lt": key}},
                {"occurred_at": stamp, "key": key, "kind": {"$lt": kind}},
            ]
        except (ValueError, TypeError) as exc:
            raise ValueError(
                "The journal cursor is no longer valid; refresh the journal"
            ) from exc
    rows = (
        await CoverageJournalEntry.find(query)
        .sort([("occurred_at", -1), ("key", -1), ("kind", -1)])
        .limit(limit + 1)
        .to_list()
    )
    next_cursor = None
    if len(rows) > limit:
        import json
        import base64

        last = rows[limit - 1]
        next_cursor = base64.urlsafe_b64encode(
            json.dumps(
                [rollup.revision, _iso(last.occurred_at), last.key, last.kind]
            ).encode()
        ).decode()
    return {
        "success": True,
        "contributions": [row.data for row in rows[:limit]],
        "next_cursor": next_cursor,
        "revision": rollup.revision,
    }


async def get_journal_segments(
    area_id,
    *,
    range_key,
    bounds=None,
    segment_ids=None,
    street_name=None,
    timezone="UTC",
):
    rollup = await ensure_journal_rollup(area_id)
    query = {"area_id": area_id, "area_version": rollup.area_version}
    if bounds:
        a, b, c, d = bounds
        query["geometry"] = {
            "$geoIntersects": {
                "$geometry": {
                    "type": "Polygon",
                    "coordinates": [[[a, b], [c, b], [c, d], [a, d], [a, b]]],
                }
            }
        }
    if street_name:
        query["street_key"] = normalize_street_key(street_name)
    if segment_ids:
        query["segment_id"] = {"$in": segment_ids}
    streets = await Street.find(query).limit(2001).to_list()
    truncated = len(streets) > 2000
    streets = streets[:2000]
    ids = [street.segment_id for street in streets]
    metrics = {
        row.key: row.data
        for row in await CoverageJournalEntry.find(
            {**_entry_query(rollup, "segment"), "key": {"$in": ids}}
        ).to_list()
    }
    start = _range_start(
        normalize_journal_range(range_key), datetime.now(UTC), timezone
    )
    counts = {}
    if start:
        visits = await CoverageJournalEntry.find(
            {
                **_entry_query(rollup, "visit"),
                "occurred_at": {"$gte": start},
                "data.segment_ids": {"$in": ids},
            }
        ).to_list()
        sets = defaultdict(set)
        for visit in visits:
            for sid in visit.data["segment_ids"]:
                if sid in metrics:
                    sets[sid].add(visit.data["trip_id"])
        counts = {sid: len(trips) for sid, trips in sets.items()}
    features = [
        {
            "type": "Feature",
            "id": street.segment_id,
            "geometry": street.geometry,
            "properties": {
                **metrics.get(street.segment_id, {}),
                "segment_id": street.segment_id,
                "street_name": street.street_name,
                "length_miles": street.length_miles,
                "highway_type": street.highway_type,
                "period_trip_count": counts.get(street.segment_id, 0)
                if start
                else metrics.get(street.segment_id, {}).get("trip_count", 0),
            },
        }
        for street in streets
    ]
    from street_coverage.rendering import feature_parts

    features = await asyncio.to_thread(
        lambda: [part for feature in features for part in feature_parts(feature)]
    )
    return (
        {
            "type": "FeatureCollection",
            "features": features,
            "truncated": truncated,
            "revision": rollup.revision,
            "area_version": rollup.area_version,
        },
        rollup.revision,
        rollup.area_version,
    )
