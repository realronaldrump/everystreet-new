import pytest
from coverage_helpers import area_with_streets, coverage_database, drive
from db.models import CoverageArea, CoverageState
from street_coverage.api.memory_city import get_memory_city


@pytest.fixture
async def memory_city_db():
    return await coverage_database()


async def test_memory_city_is_read_only_even_when_projection_is_inconsistent(
    memory_city_db,
):
    area, _ = await area_with_streets([1])
    await area.set(
        {"driven_length_miles": 1, "coverage_percentage": 100, "driven_segments": 1}
    )
    before = (await CoverageArea.get(area.id)).model_dump()
    payload = await get_memory_city(area.id)
    assert payload.segments == []
    assert (await CoverageArea.get(area.id)).model_dump() == before


async def test_memory_city_uses_current_states_and_distinct_trip_counts(memory_city_db):
    area, ids = await area_with_streets([1.25])
    await drive(area, {ids[0]: [[0, 1]]})
    before = (await CoverageArea.get(area.id)).model_dump()
    payload = await get_memory_city(area.id)
    assert payload.area.driven_segments == 1
    assert payload.area.driven_length_miles == 1.25
    assert payload.area.coverage_percentage == 100
    assert payload.segments[0].segment_id == ids[0]
    assert payload.segments[0].distinct_trip_count == 1
    assert (await CoverageArea.get(area.id)).model_dump() == before
