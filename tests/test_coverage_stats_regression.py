from __future__ import annotations

import asyncio

import pytest
from db_helpers import init_mock_beanie

from db.models import CoverageArea
from street_coverage.stats import apply_area_stats_delta


@pytest.fixture
async def coverage_stats_db():
    return await init_mock_beanie(CoverageArea)


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


@pytest.mark.asyncio
async def test_concurrent_apply_area_stats_delta_does_not_lose_increments(
    coverage_stats_db,
) -> None:
    """
    Regression test for the lost-update race in apply_area_stats_delta.

    Concurrent invocations must use atomic ``$inc`` so that every delta
    counts. Before the fix this test would intermittently fail with the
    sum being less than the expected number of concurrent calls.
    """
    _ = coverage_stats_db

    area = CoverageArea(
        display_name="Concurrent Stats Area",
        status="ready",
        health="healthy",
        total_length_miles=100.0,
        driveable_length_miles=100.0,
        total_segments=100,
    )
    await area.insert()
    assert area.id is not None

    n = 25
    await asyncio.gather(
        *(
            apply_area_stats_delta(
                area.id,
                driven_segments_delta=1,
                driven_length_miles_delta=0.5,
                update_last_synced=False,
            )
            for _ in range(n)
        )
    )

    refreshed = await CoverageArea.get(area.id)
    assert refreshed is not None
    assert refreshed.driven_segments == n
    assert refreshed.driven_length_miles == pytest.approx(n * 0.5)
    assert refreshed.driveable_length_miles == pytest.approx(100.0)
    assert refreshed.coverage_percentage == pytest.approx(12.5)
