from __future__ import annotations

from datetime import UTC, datetime

import pytest
from beanie import PydanticObjectId
from db_helpers import init_mock_beanie
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from db.models import (
    CoverageArea,
    CoverageDriveEvent,
    CoverageJournalRollup,
    CoverageState,
    CoverageStatusEvent,
    Street,
)
from street_coverage.api.journal import router as journal_router
from street_coverage.journal import (
    append_status_event,
    get_journal_payload,
    mark_journal_pending,
    rebuild_journal_rollup,
    upsert_drive_event,
)


@pytest.fixture
async def journal_db():
    return await init_mock_beanie(
        CoverageArea,
        CoverageState,
        CoverageDriveEvent,
        CoverageStatusEvent,
        CoverageJournalRollup,
        Street,
    )


async def _build_area() -> tuple[CoverageArea, list[str]]:
    area = CoverageArea(
        display_name="Journal Test Area",
        status="ready",
        health="healthy",
        total_length_miles=4.0,
        driveable_length_miles=4.0,
        driven_length_miles=3.0,
        coverage_percentage=75.0,
        total_segments=4,
        driven_segments=3,
    )
    await area.insert()
    assert area.id is not None
    segment_ids = [f"{area.id}-{area.area_version}-{index}" for index in range(4)]
    names = ["Main Street", "Main Street", "Oak Avenue", "Frontier Road"]
    for index, segment_id in enumerate(segment_ids):
        await Street(
            segment_id=segment_id,
            area_id=area.id,
            area_version=area.area_version,
            geometry={
                "type": "LineString",
                "coordinates": [
                    [-97.0, 31.0 + index / 100],
                    [-97.01, 31.0 + index / 100],
                ],
            },
            street_name=names[index],
            highway_type="residential",
            length_miles=1.0,
        ).insert()
    return area, segment_ids


@pytest.mark.asyncio
async def test_rollup_reconstructs_monotonic_history_and_distinct_trip_rankings(
    journal_db,
) -> None:
    _ = journal_db
    area, segment_ids = await _build_area()
    first = datetime(2024, 1, 1, 12, tzinfo=UTC)
    second = datetime(2024, 2, 1, 12, tzinfo=UTC)
    for segment_id, driven_at in zip(
        segment_ids[:3],
        [first, first, second],
        strict=True,
    ):
        await CoverageState(
            area_id=area.id,
            segment_id=segment_id,
            status="driven",
            first_driven_at=driven_at,
            last_driven_at=driven_at,
        ).insert()

    first_trip = PydanticObjectId()
    second_trip = PydanticObjectId()
    await upsert_drive_event(
        area_id=area.id,
        area_version=area.area_version,
        trip_id=first_trip,
        driven_at=first,
        segment_ids=segment_ids[:2],
        timezone="America/Chicago",
        geometry_source="gps",
        matching_mode="both",
        invalidate=False,
    )
    await upsert_drive_event(
        area_id=area.id,
        area_version=area.area_version,
        trip_id=second_trip,
        driven_at=second,
        segment_ids=[segment_ids[0], segment_ids[2]],
        timezone="America/Chicago",
        geometry_source="matchedGps",
        matching_mode="both",
        invalidate=False,
    )
    await mark_journal_pending(area.id)
    await rebuild_journal_rollup(area.id)

    payload = await get_journal_payload(
        area.id,
        range_key="all",
        timezone="America/Chicago",
    )
    assert payload["summary"]["coverage_percentage"] == pytest.approx(75.0)
    assert payload["summary"]["historical_trip_count"] == 2
    percentages = [point["coverage_percentage"] for point in payload["series"]]
    assert percentages == sorted(percentages)
    assert percentages[-1] == pytest.approx(75.0)

    main = next(
        row for row in payload["street_rankings"] if row["street_name"] == "Main Street"
    )
    assert main["trip_count"] == 2
    assert main["all_time_trip_count"] == 2
    assert set(main["segment_ids"]) == set(segment_ids[:2])

    frontier = payload["frontier"]
    assert frontier[0]["street_name"] == "Frontier Road"
    assert frontier[0]["length_miles"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_manual_events_never_increment_historical_trip_frequency(
    journal_db,
) -> None:
    _ = journal_db
    area, segment_ids = await _build_area()
    manual_time = datetime(2025, 3, 1, 12, tzinfo=UTC)
    await CoverageState(
        area_id=area.id,
        segment_id=segment_ids[0],
        status="driven",
        first_driven_at=manual_time,
        last_driven_at=manual_time,
        manually_marked=True,
        marked_at=manual_time,
    ).insert()
    area.driven_segments = 1
    area.driven_length_miles = 1.0
    area.coverage_percentage = 25.0
    await area.save()
    await append_status_event(
        area_id=area.id,
        area_version=area.area_version,
        action="mark_driven",
        segment_ids=[segment_ids[0]],
        occurred_at=manual_time,
        coverage_before=0.0,
        coverage_after=25.0,
    )
    await rebuild_journal_rollup(area.id)

    payload = await get_journal_payload(area.id)
    assert payload["summary"]["coverage_percentage"] == pytest.approx(25.0)
    assert payload["summary"]["historical_trip_count"] == 0
    assert payload["street_rankings"] == []
    assert payload["recent_contributions"][0]["source"] == "manual"


@pytest.mark.asyncio
async def test_drive_event_upsert_is_idempotent(journal_db) -> None:
    _ = journal_db
    area, segment_ids = await _build_area()
    driven_at = datetime(2025, 1, 1, tzinfo=UTC)
    trip_id = PydanticObjectId()
    payload = {
        "area_id": area.id,
        "area_version": area.area_version,
        "trip_id": trip_id,
        "driven_at": driven_at,
        "segment_ids": [segment_ids[0], segment_ids[0]],
        "timezone": "UTC",
        "geometry_source": "gps",
        "matching_mode": "regular",
        "invalidate": False,
    }
    await upsert_drive_event(**payload)
    await upsert_drive_event(**payload)

    assert await CoverageDriveEvent.find({"trip_id": trip_id}).count() == 1
    event = await CoverageDriveEvent.find_one({"trip_id": trip_id})
    assert event is not None
    assert event.segment_ids == [segment_ids[0]]


@pytest.mark.asyncio
async def test_segment_geojson_supports_etag_revalidation(journal_db) -> None:
    _ = journal_db
    area, _segment_ids = await _build_area()
    await mark_journal_pending(area.id)
    await rebuild_journal_rollup(area.id)
    app = FastAPI()
    app.include_router(journal_router)
    transport = ASGITransport(app=app)
    path = f"/api/coverage/areas/{area.id}/journal/segments?range=all"

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        first = await client.get(path)
        second = await client.get(
            path,
            headers={"If-None-Match": first.headers["etag"]},
        )

    assert first.status_code == 200
    assert first.headers["content-type"].startswith("application/geo+json")
    assert first.json()["type"] == "FeatureCollection"
    assert second.status_code == 304
