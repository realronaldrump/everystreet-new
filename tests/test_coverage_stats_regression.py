from __future__ import annotations

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from db.models import CoverageArea, CoverageState, Street
from street_coverage.stats import update_area_stats


@pytest.fixture
async def coverage_stats_db():
    client = AsyncMongoMockClient()
    db = client["test_db"]
    await init_beanie(
        database=db,
        document_models=[CoverageArea, CoverageState, Street],
    )
    return db


@pytest.mark.asyncio
async def test_update_area_stats_respects_driveable_denominator(coverage_stats_db) -> None:
    _ = coverage_stats_db

    area = CoverageArea(
        display_name="Stats Area",
        status="ready",
        health="healthy",
    )
    await area.insert()
    assert area.id is not None

    segment_ids = [f"{area.id}-{area.area_version}-{idx}" for idx in range(3)]
    for segment_id in segment_ids:
        await Street(
            segment_id=segment_id,
            area_id=area.id,
            area_version=area.area_version,
            geometry={
                "type": "LineString",
                "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
            },
            length_miles=1.0,
        ).insert()

    await CoverageState(
        area_id=area.id,
        segment_id=segment_ids[0],
        status="driven",
    ).insert()
    await CoverageState(
        area_id=area.id,
        segment_id=segment_ids[1],
        status="undriveable",
    ).insert()

    refreshed = await update_area_stats(area.id)
    assert refreshed is not None
    assert refreshed.total_segments == 3
    assert refreshed.driven_segments == 1
    assert refreshed.undriveable_segments == 1
    assert refreshed.total_length_miles == 3.0
    assert refreshed.driveable_length_miles == 2.0
    assert refreshed.driven_length_miles == 1.0
    assert refreshed.coverage_percentage == 50.0
