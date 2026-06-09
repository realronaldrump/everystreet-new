"""Regression tests for the recent driving activity endpoint."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from db_helpers import init_mock_beanie
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from db.models import CoverageArea, CoverageState, Street
from street_coverage.api.streets import router as streets_router


@pytest.fixture
async def activity_db():
    return await init_mock_beanie(CoverageArea, Street, CoverageState)


@pytest.fixture
def activity_app() -> FastAPI:
    app = FastAPI()
    app.include_router(streets_router)
    return app


@pytest.mark.asyncio
async def test_activity_returns_recent_driven_segments(
    activity_db, activity_app
) -> None:
    _ = activity_db

    area = CoverageArea(
        display_name="Activity Area",
        status="ready",
        health="healthy",
        total_length_miles=2.0,
        driveable_length_miles=2.0,
        total_segments=2,
    )
    await area.insert()
    assert area.id is not None

    seg_old = f"{area.id}-{area.area_version}-0"
    seg_new = f"{area.id}-{area.area_version}-1"
    await Street(
        segment_id=seg_old,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.001, 31.0]],
        },
        street_name="Old St",
        length_miles=0.5,
    ).insert()
    await Street(
        segment_id=seg_new,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.001], [-97.001, 31.001]],
        },
        street_name="New Ave",
        length_miles=0.7,
    ).insert()

    older = datetime(2025, 1, 1, 12, 0, tzinfo=UTC)
    newer = datetime(2025, 6, 1, 12, 0, tzinfo=UTC)

    await CoverageState(
        area_id=area.id,
        segment_id=seg_old,
        status="driven",
        first_driven_at=older,
        last_driven_at=older,
        manually_marked=False,
    ).insert()
    await CoverageState(
        area_id=area.id,
        segment_id=seg_new,
        status="driven",
        first_driven_at=newer,
        last_driven_at=newer,
        manually_marked=True,
    ).insert()

    transport = ASGITransport(app=activity_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(f"/api/coverage/areas/{area.id}/activity")

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert len(data["activity"]) == 2

    # Newest first.
    first = data["activity"][0]
    assert first["street_name"] == "New Ave"
    assert first["manually_marked"] is True
    assert first["newly_driven"] is True
    assert first["length_miles"] == pytest.approx(0.7)

    second = data["activity"][1]
    assert second["street_name"] == "Old St"
    assert second["manually_marked"] is False
    assert second["newly_driven"] is True


@pytest.mark.asyncio
async def test_activity_returns_404_for_unknown_area(activity_app) -> None:
    await init_mock_beanie(CoverageArea, Street, CoverageState)

    transport = ASGITransport(app=activity_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            "/api/coverage/areas/000000000000000000000000/activity",
        )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_activity_empty_when_no_drives(activity_db, activity_app) -> None:
    _ = activity_db

    area = CoverageArea(
        display_name="No-Drive Area",
        status="ready",
        health="healthy",
        total_segments=0,
    )
    await area.insert()

    transport = ASGITransport(app=activity_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(f"/api/coverage/areas/{area.id}/activity")

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "area_id": str(area.id),
        "activity": [],
    }
