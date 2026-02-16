from __future__ import annotations

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from db.models import CoverageArea
from street_coverage.stats import apply_area_stats_delta


@pytest.fixture
async def coverage_stats_db():
    client = AsyncMongoMockClient()
    db = client["test_db"]
    await init_beanie(
        database=db,
        document_models=[CoverageArea],
    )
    return db


@pytest.mark.asyncio
async def test_apply_area_stats_delta_respects_driveable_denominator(
    coverage_stats_db,
) -> None:
    _ = coverage_stats_db

    area = CoverageArea(
        display_name="Stats Area",
        status="ready",
        health="healthy",
        total_length_miles=3.0,
        driveable_length_miles=3.0,
        driven_length_miles=1.0,
        driven_segments=1,
        undriveable_segments=0,
        undriveable_length_miles=0.0,
        total_segments=3,
    )
    await area.insert()
    assert area.id is not None

    refreshed = await apply_area_stats_delta(
        area.id,
        undriveable_segments_delta=1,
        undriveable_length_miles_delta=1.0,
        update_last_synced=False,
    )

    assert refreshed is not None
    assert refreshed.total_length_miles == 3.0
    assert refreshed.driven_length_miles == 1.0
    assert refreshed.undriveable_length_miles == 1.0
    assert refreshed.driveable_length_miles == 2.0
    assert refreshed.coverage_percentage == 50.0
