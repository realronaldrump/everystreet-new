"""Atomic historical street credit and replayable downstream projections."""

from __future__ import annotations

from typing import Any

from beanie import PydanticObjectId

from db.models import CoverageArea, CoverageDriveEvent, Street, Trip
from street_coverage.journal import (
    JOURNAL_MATCHING_VERSION,
    _increment_journal_rollup,
    ensure_journal_rollup,
    mark_journal_pending,
)


async def credit_trip_area(
    trip_data: dict[str, Any],
    trip_id: PydanticObjectId,
    area_id: PydanticObjectId,
    segment_ids: list[str],
    matching_mode: str,
) -> int:
    """Commit states, totals and evidence together; retry projections after commit."""
    from core.coverage import get_trip_driven_at, update_coverage_for_segments
    from street_coverage.intelligence import CoverageIntelligenceService

    driven_at = get_trip_driven_at(trip_data)
    if driven_at is None:
        raise ValueError("Historical trip has no usable drive timestamp")
    client = Trip.get_pymongo_collection().database.client

    async def commit(session):
        trip = await Trip.get(trip_id, session=session)
        if trip is None or trip.source != "bouncie":
            raise ValueError(
                "Coverage credit requires a persisted Bouncie Historical Trip"
            )
        if trip.inactive or trip.invalid:
            return None
        area = await CoverageArea.get(area_id, session=session)
        if area is None:
            return None
        if area.status != "ready":
            raise ValueError("Coverage area is being rebuilt; retry after it is ready")
        existing = await CoverageDriveEvent.find_one(
            {"area_id": area_id, "area_version": area.area_version, "trip_id": trip_id},
            session=session,
        )
        if existing is not None:
            return existing
        count = await Street.find(
            {
                "area_id": area_id,
                "area_version": area.area_version,
                "segment_id": {"$in": segment_ids},
            },
            session=session,
        ).count()
        if count != len(set(segment_ids)):
            raise ValueError("Coverage street inventory changed during matching; retry")
        result = await update_coverage_for_segments(
            area_id,
            segment_ids,
            trip_id=trip_id,
            driven_at=driven_at,
            session=session,
        )
        revision = await mark_journal_pending(area_id, session=session)
        event = CoverageDriveEvent(
            area_id=area_id,
            area_version=area.area_version,
            trip_id=trip_id,
            driven_at=driven_at,
            timezone=trip_data.get("endTimeZone") or trip_data.get("startTimeZone"),
            geometry_source="matchedGps"
            if matching_mode != "regular" and trip_data.get("matchedGps")
            else "gps",
            matching_mode=matching_mode,
            matching_version=JOURNAL_MATCHING_VERSION,
            segment_ids=sorted(set(segment_ids)),
            newly_driven_segment_ids=result.newly_driven_segment_ids,
            journal_revision=revision,
        )
        await event.insert(session=session)
        return event

    async with client.start_session() as session:
        event = await session.with_transaction(commit)
    if event is None:
        return 0
    # The event carries the original credit even if the worker stopped after commit.
    # Journal revisions make an already-applied incremental projection a no-op.
    if event.journal_revision is not None:
        await _increment_journal_rollup(
            area_id=area_id,
            area_version=event.area_version,
            trip_id=trip_id,
            driven_at=event.driven_at,
            segment_ids=event.segment_ids,
            newly_driven_segment_ids=event.newly_driven_segment_ids,
            previous_revision=event.journal_revision - 1,
            target_revision=event.journal_revision,
        )
    await ensure_journal_rollup(area_id)
    await CoverageIntelligenceService.reconcile_historical_trip(
        area_id=area_id,
        area_version=event.area_version,
        trip_id=trip_id,
        newly_driven_segment_ids=event.newly_driven_segment_ids,
    )
    return len(event.newly_driven_segment_ids)
