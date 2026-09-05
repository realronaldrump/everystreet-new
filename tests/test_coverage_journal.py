from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from coverage_helpers import area_with_streets, coverage_database, drive
from db.models import (
    CoverageArea,
    CoverageDriveEvent,
    CoverageJournalEntry,
    CoverageJournalRollup,
)
from street_coverage.api.journal import router as journal_router
from street_coverage.journal import (
    get_journal_payload,
    rebuild_journal_rollup,
    get_journal_contributions,
)
from street_coverage.projection import set_manual_status


@pytest.fixture
async def journal_db():
    return await coverage_database()


async def test_rollup_reconstructs_exact_partial_history_and_distinct_trips(journal_db):
    area, ids = await area_with_streets(
        [1, 1, 1, 1], ["Main Street", "Main Street", "Oak Avenue", "Frontier Road"]
    )
    await drive(
        area,
        {ids[0]: [[0, 0.5]], ids[1]: [[0, 1]]},
        datetime(2024, 1, 1, 12, tzinfo=UTC),
    )
    await drive(
        area,
        {ids[0]: [[0.5, 1]], ids[2]: [[0, 1]]},
        datetime(2024, 2, 1, 12, tzinfo=UTC),
    )
    await rebuild_journal_rollup(area.id)
    payload = await get_journal_payload(area.id, timezone="America/Chicago")
    assert payload["summary"]["coverage_percentage"] == 75
    assert payload["summary"]["historical_trip_count"] == 2
    assert [row["coverage_percentage"] for row in payload["series"]] == [37.5, 75]
    assert payload["records"]["last_period_addition"]["new_miles"] == 1.5
    assert payload["records"]["longest_pause_days"] == 31
    main = next(
        row for row in payload["street_rankings"] if row["street_name"] == "Main Street"
    )
    assert main["trip_count"] == main["all_time_trip_count"] == 2
    assert set(main["segment_ids"]) == set(ids[:2])
    assert payload["frontier"][0]["street_name"] == "Frontier Road"
    rollup = await CoverageJournalRollup.find_one({"area_id": area.id})
    assert "segment_metrics" not in rollup.data
    assert "contributions" not in rollup.data
    assert (
        await CoverageJournalEntry.find({"area_id": area.id, "kind": "segment"}).count()
        == 4
    )


async def test_manual_events_never_inflate_historical_trip_frequency(journal_db):
    area, ids = await area_with_streets([1, 1, 1, 1])
    await set_manual_status(area.id, [ids[0]], "driven")
    await rebuild_journal_rollup(area.id)
    payload = await get_journal_payload(area.id)
    assert payload["summary"]["coverage_percentage"] == 25
    assert payload["summary"]["historical_trip_count"] == 0
    assert payload["street_rankings"] == []
    assert payload["recent_contributions"][0]["source"] == "manual"


async def test_drive_event_replay_is_idempotent(journal_db):
    area, ids = await area_with_streets([1])
    trip = await drive(area, {ids[0]: [[0, 1]]})
    await drive(area, {ids[0]: [[0, 1]]}, trip=trip)
    assert await CoverageDriveEvent.find({"trip_id": trip.id}).count() == 1
    assert (await CoverageArea.get(area.id)).driven_length_miles == 1


async def test_journal_never_forces_history_to_a_corrupt_counter(journal_db):
    area, ids = await area_with_streets([1, 1])
    await drive(area, {ids[0]: [[0, 1]]})
    await area.set({"driven_length_miles": 2, "coverage_percentage": 100})
    with pytest.raises(ValueError, match="disagree"):
        await rebuild_journal_rollup(area.id)
    assert await CoverageJournalRollup.find_all().count() == 0


async def test_segment_geojson_conditional_request_skips_geometry_work(journal_db):
    area, _ = await area_with_streets([1])
    await rebuild_journal_rollup(area.id)
    app = FastAPI()
    app.include_router(journal_router)
    path = f"/api/coverage/areas/{area.id}/journal/segments?range=all"
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.get(path)
        with patch(
            "street_coverage.api.journal.get_journal_segments", new_callable=AsyncMock
        ) as builder:
            second = await client.get(
                path, headers={"If-None-Match": first.headers["etag"]}
            )
    assert first.status_code == 200
    assert first.json()["type"] == "FeatureCollection"
    assert second.status_code == 304
    builder.assert_not_awaited()


async def test_contribution_pagination_has_stable_order(journal_db):
    area, ids = await area_with_streets([1, 1, 1])
    for index, sid in enumerate(ids):
        await drive(area, {sid: [[0, 1]]}, datetime(2026, 1, index + 1, tzinfo=UTC))
    await rebuild_journal_rollup(area.id)
    first = await get_journal_contributions(
        area.id, range_key="all", source="all", cursor=None, limit=2
    )
    second = await get_journal_contributions(
        area.id, range_key="all", source="all", cursor=first["next_cursor"], limit=2
    )
    dates = [
        row["occurred_at"] for row in first["contributions"] + second["contributions"]
    ]
    assert len(dates) == len(set(dates)) == 3
    assert dates == sorted(dates, reverse=True)
