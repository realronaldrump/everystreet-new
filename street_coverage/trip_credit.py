"""Transactional replacement of one Historical Trip's coverage evidence."""

from __future__ import annotations


from db.models import CoverageArea, CoverageDriveEvent, Street, Trip
from core.date_utils import normalize_to_utc_datetime
from street_coverage import transactions
from street_coverage.identity import trip_input_revision
from street_coverage.matching import MATCHING_VERSION
from street_coverage.projection import CoverageDeferred, claim_area, project_segments


async def credit_trip_area(
    trip_data,
    trip_id,
    area_id,
    evidence,
    matching_mode,
    *,
    area_version=None,
    geometry_source="gps",
):
    from core.coverage import get_trip_driven_at

    incoming_revision = trip_input_revision(trip_data)

    async def commit(session):
        trip = await Trip.get(trip_id, session=session)
        if trip is None or trip.source != "bouncie":
            raise ValueError(
                "Coverage credit requires a persisted Bouncie Historical Trip"
            )
        if trip_input_revision(trip.model_dump()) != incoming_revision:
            raise ValueError("Trip geometry changed during coverage matching; retry")
        area = await CoverageArea.get(area_id, session=session)
        if area is None:
            return None
        if area_version is not None and area.area_version != area_version:
            # Old inventories are never allowed to alter the current projection.
            return None
        if area.coverage_matching_version != MATCHING_VERSION:
            raise CoverageDeferred(
                "Coverage inventory needs its interval recalculation"
            )
        query = {
            "area_id": area_id,
            "area_version": area.area_version,
            "trip_id": trip_id,
        }
        existing = await CoverageDriveEvent.find_one(query, session=session)
        if (
            existing
            and existing.input_revision == incoming_revision
            and existing.matching_version == MATCHING_VERSION
            and existing.matching_mode == matching_mode
        ):
            return existing
        area = await claim_area(area_id, session, version=area.area_version)
        effective = {} if trip.inactive or trip.invalid else evidence
        current_ids = sorted(effective)
        count = await Street.find(
            {
                "area_id": area_id,
                "area_version": area.area_version,
                "segment_id": {"$in": current_ids},
            },
            session=session,
        ).count()
        if count != len(current_ids):
            raise ValueError("Street inventory changed during matching")
        affected = sorted(
            set(current_ids) | set(existing.segment_ids if existing else [])
        )
        driven_at = get_trip_driven_at(trip_data)
        if driven_at is None:
            raise ValueError("Historical trip has no usable timestamp")
        await CoverageDriveEvent.get_pymongo_collection().delete_one(
            query, session=session
        )
        event = CoverageDriveEvent(
            **query,
            driven_at=driven_at,
            timezone=trip.endTimeZone or trip.startTimeZone,
            geometry_source=geometry_source,
            matching_mode=matching_mode,
            input_revision=incoming_revision,
            segment_ids=current_ids,
            segment_intervals={sid: row["intervals"] for sid, row in effective.items()},
            segment_offsets={
                sid: row["max_offset_meters"] for sid, row in effective.items()
            },
            journal_revision=area.journal_revision,
        )
        if effective:
            await event.insert(session=session)
        result = await project_segments(area, affected, session)
        if effective:
            event.newly_driven_segment_ids = result["newly_driven_segment_ids"]
            await event.set(
                {"newly_driven_segment_ids": event.newly_driven_segment_ids},
                session=session,
            )
        await CoverageArea.get_pymongo_collection().update_one(
            {"_id": area_id},
            {
                "$set": {
                    "last_coverage_trip_at": max(
                        filter(
                            None,
                            [
                                normalize_to_utc_datetime(area.last_coverage_trip_at),
                                driven_at,
                            ],
                        )
                    )
                }
            },
            session=session,
        )
        return event

    event = await transactions.run_transaction(commit)
    if event is None:
        return 0
    from street_coverage.intelligence import CoverageIntelligenceService

    await CoverageIntelligenceService.reconcile_historical_trip(
        area_id=area_id,
        area_version=event.area_version,
        trip_id=trip_id,
        newly_driven_segment_ids=event.newly_driven_segment_ids,
    )
    # The journal worker coalesces updates; credit never waits for a full history scan.
    return len(event.newly_driven_segment_ids)
