"""Build valid interval coverage fixtures through the production credit boundary."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from db_helpers import init_mock_beanie
from db.models import CoverageArea, CoverageJournalRollup, Street, Trip
from street_coverage.matching import MATCHING_VERSION
from street_coverage.trip_credit import credit_trip_area


async def coverage_database():
    return await init_mock_beanie(CoverageArea, CoverageJournalRollup, Trip)


async def area_with_streets(lengths, names=None):
    area = CoverageArea(
        display_name=uuid4().hex,
        status="ready",
        coverage_matching_version=MATCHING_VERSION,
        total_segments=len(lengths),
        remaining_segments=len(lengths),
        total_length_miles=sum(lengths),
        driveable_length_miles=sum(lengths),
        remaining_length_miles=sum(lengths),
        bounding_box=[-107.1, 38.9, -106.8, 39.5],
    )
    await area.insert()
    ids = []
    for index, length in enumerate(lengths):
        sid = f"{area.id}-1-{index}"
        name = names[index] if names else f"Street {index}"
        await Street(
            area_id=area.id,
            area_version=1,
            segment_id=sid,
            length_miles=length,
            street_name=name,
            street_key=name.casefold(),
            geometry={
                "type": "LineString",
                "coordinates": [
                    [-107 + index * 0.001, 39],
                    [-107 + index * 0.001, 39.001],
                ],
            },
        ).insert()
        ids.append(sid)
    return area, ids


async def drive(area, intervals, when=None, trip=None):
    when = when or datetime(2026, 1, 1, tzinfo=UTC)
    if trip is None:
        trip = Trip(
            transactionId=uuid4().hex,
            source="bouncie",
            startTime=when - timedelta(minutes=10),
            endTime=when,
        )
        await trip.insert()
    await credit_trip_area(
        trip.model_dump(),
        trip.id,
        area.id,
        {
            sid: {"intervals": ranges, "max_offset_meters": 0}
            for sid, ranges in intervals.items()
        },
        "matched",
        area_version=area.area_version,
        geometry_source="matchedGps",
    )
    return trip
