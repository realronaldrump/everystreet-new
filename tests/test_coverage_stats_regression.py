import asyncio
import pytest
from coverage_helpers import area_with_streets, coverage_database, drive
from db.models import CoverageArea
from street_coverage.projection import set_manual_status


@pytest.fixture
async def coverage_stats_db():
    return await coverage_database()


async def test_exact_stats_respect_the_driveable_denominator(coverage_stats_db):
    area, ids = await area_with_streets([1, 1, 1])
    await drive(area, {ids[0]: [[0, 1]]})
    await set_manual_status(area.id, [ids[1]], "undriveable")
    current = await CoverageArea.get(area.id)
    assert current.total_length_miles == 3
    assert current.driven_length_miles == 1
    assert current.undriveable_length_miles == 1
    assert current.driveable_length_miles == 2
    assert current.coverage_percentage == 50


async def test_concurrent_credits_do_not_lose_length_or_double_count_replays(
    coverage_stats_db,
):
    area, ids = await area_with_streets([0.5] * 100)
    trips = await asyncio.gather(*(drive(area, {sid: [[0, 1]]}) for sid in ids[:25]))
    await asyncio.gather(
        *(drive(area, {sid: [[0, 1]]}, trip=trip) for sid, trip in zip(ids, trips))
    )
    current = await CoverageArea.get(area.id)
    assert current.driven_segments == 25
    assert current.driven_length_miles == 12.5
    assert current.coverage_percentage == 25


async def test_sub_thousandth_mile_precision_is_not_rounded_in_storage(
    coverage_stats_db,
):
    area, ids = await area_with_streets([0.0005] * 3)
    await drive(area, {ids[0]: [[0, 1]]})
    current = await CoverageArea.get(area.id)
    assert current.driven_length_miles == pytest.approx(0.0005)
    assert current.coverage_percentage == pytest.approx(100 / 3)
