from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from coverage_helpers import area_with_streets, coverage_database, drive
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from street_coverage.api.streets import router as streets_router
from street_coverage.journal import get_journal_segments, rebuild_journal_rollup


@pytest.fixture
async def map_db():
    return await coverage_database()


def _client():
    app = FastAPI()
    app.include_router(streets_router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_area_map_draws_driven_and_undriven_portions_with_slim_properties(
    map_db,
):
    area, ids = await area_with_streets([1, 1])
    await drive(area, {ids[0]: [[0, 0.5]]}, datetime(2026, 3, 1, tzinfo=UTC))
    path = f"/api/coverage/areas/{area.id}/streets/map"
    async with _client() as client:
        first = await client.get(path)
        with patch(
            "street_coverage.api.streets._features", new_callable=AsyncMock
        ) as builder:
            second = await client.get(
                path, headers={"If-None-Match": first.headers["etag"]}
            )
    assert first.status_code == 200
    features = first.json()["features"]
    partial = [row for row in features if row["properties"]["segment_id"] == ids[0]]
    assert sorted(row["properties"]["status"] for row in partial) == [
        "driven",
        "undriven",
    ]
    assert all(row["properties"]["segment_status"] == "undriven" for row in partial)
    untouched = next(
        row for row in features if row["properties"]["segment_id"] == ids[1]
    )
    assert set(untouched["properties"]) == {"segment_id", "street_name", "status"}
    for row in features:
        for lon, lat in row["geometry"]["coordinates"]:
            assert round(lon, 6) == lon and round(lat, 6) == lat
    assert second.status_code == 304
    builder.assert_not_awaited()


async def test_whole_area_journal_map_is_not_truncated_and_keeps_dates(map_db):
    area, ids = await area_with_streets([1, 1, 1])
    when = datetime(2026, 4, 2, tzinfo=UTC)
    await drive(area, {ids[0]: [[0, 1]], ids[1]: [[0.25, 1]]}, when)
    await rebuild_journal_rollup(area.id)
    payload, _, _ = await get_journal_segments(area.id, range_key="all")
    assert not payload["truncated"]
    rows = payload["features"]
    assert {row["properties"]["segment_id"] for row in rows} == set(ids)
    driven = [row for row in rows if row["properties"]["status"] == "driven"]
    assert {row["properties"]["first_driven_at"] for row in driven} == {
        when.isoformat()
    }
    assert all(
        set(row["properties"])
        <= {"segment_id", "status", "first_driven_at", "period_trip_count"}
        for row in rows
    )
