from datetime import UTC, datetime

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from db.models import CoverageArea, CoverageState, Street
from street_coverage.api.memory_city import get_memory_city


@pytest.fixture
async def memory_city_db():
    client = AsyncMongoMockClient()
    db = client["test_db"]
    await init_beanie(
        database=db,
        document_models=[CoverageArea, CoverageState, Street],
    )
    return db


@pytest.mark.asyncio
async def test_memory_city_repairs_stale_cached_stats_from_old_area_version(
    memory_city_db,
) -> None:
    area = CoverageArea(
        display_name="Waco, McLennan County, Texas, United States",
        status="ready",
        health="healthy",
        area_version=2,
        total_segments=1,
        total_length_miles=1.0,
        driveable_length_miles=1.0,
        driven_segments=1,
        driven_length_miles=1.0,
        coverage_percentage=100.0,
    )
    await area.insert()
    assert area.id is not None

    await Street(
        segment_id=f"{area.id}-2-0",
        area_id=area.id,
        area_version=2,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.10, 31.55], [-97.11, 31.56]],
        },
        length_miles=1.0,
    ).insert()

    stale_time = datetime(2025, 1, 2, tzinfo=UTC)
    await CoverageState(
        area_id=area.id,
        segment_id=f"{area.id}-1-0",
        status="driven",
        first_driven_at=stale_time,
        last_driven_at=stale_time,
    ).insert()

    payload = await get_memory_city(area.id)

    assert payload.area.driven_segments == 0
    assert payload.area.driven_length_miles == 0.0
    assert payload.area.coverage_percentage == 0.0
    assert payload.segments == []

    refreshed = await CoverageArea.get(area.id)
    assert refreshed is not None
    assert refreshed.driven_segments == 0
    assert refreshed.driven_length_miles == 0.0
    assert refreshed.coverage_percentage == 0.0


@pytest.mark.asyncio
async def test_memory_city_refreshes_area_stats_from_current_version_segments(
    memory_city_db,
) -> None:
    area = CoverageArea(
        display_name="Austin, Travis County, Texas, United States",
        status="ready",
        health="healthy",
        area_version=3,
        total_segments=1,
        total_length_miles=1.25,
        driveable_length_miles=1.25,
        driven_segments=0,
        driven_length_miles=0.0,
        coverage_percentage=0.0,
    )
    await area.insert()
    assert area.id is not None

    segment_id = f"{area.id}-3-0"
    await Street(
        segment_id=segment_id,
        area_id=area.id,
        area_version=3,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.70, 30.25], [-97.71, 30.26]],
        },
        street_name="Test Street",
        length_miles=1.25,
    ).insert()

    driven_at = datetime(2025, 2, 3, tzinfo=UTC)
    await CoverageState(
        area_id=area.id,
        segment_id=segment_id,
        status="driven",
        first_driven_at=driven_at,
        last_driven_at=driven_at,
    ).insert()

    payload = await get_memory_city(area.id)

    assert payload.area.driven_segments == 1
    assert payload.area.driven_length_miles == 1.25
    assert payload.area.coverage_percentage == 100.0
    assert len(payload.segments) == 1
    assert payload.segments[0].segment_id == segment_id
    assert payload.segments[0].path == [[-97.7, 30.25], [-97.71, 30.26]]

    refreshed = await CoverageArea.get(area.id)
    assert refreshed is not None
    assert refreshed.driven_segments == 1
    assert refreshed.driven_length_miles == 1.25
    assert refreshed.coverage_percentage == 100.0
