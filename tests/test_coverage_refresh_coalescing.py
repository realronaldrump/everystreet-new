from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from beanie import PydanticObjectId
from db_helpers import init_mock_beanie

from db.models import CoverageArea, CoverageState, Job, Trip
from trips.services.inactive_trip_service import InactiveTripService


@pytest.fixture
async def coverage_db():
    return await init_mock_beanie(
        CoverageArea,
        CoverageState,
        Job,
        Trip,
        database_name="test_coverage_refresh_db",
    )


@pytest.fixture
def stub_backfill(monkeypatch: pytest.MonkeyPatch):
    """Stand in for the enqueue so no ARQ/Redis is needed."""

    async def _backfill(area_id):
        job = Job(job_type="area_backfill", area_id=area_id, status="queued")
        await job.insert()
        return job

    backfill = AsyncMock(side_effect=_backfill)
    monkeypatch.setattr(
        "trips.services.inactive_trip_service.backfill_area",
        backfill,
    )
    return backfill


async def _make_area(name: str = "Test City") -> CoverageArea:
    area = CoverageArea(display_name=name)
    await area.insert()
    return area


async def _make_trip() -> Trip:
    now = datetime.now(UTC)
    trip = Trip(
        transactionId="tx-coverage-1",
        source="bouncie",
        startTime=now,
        endTime=now,
    )
    await trip.insert()
    return trip


@pytest.mark.asyncio
async def test_refresh_is_deferred_while_a_coverage_job_is_active(
    coverage_db,
    stub_backfill,
) -> None:
    del coverage_db
    area = await _make_area()
    await Job(
        job_type="area_backfill",
        area_id=area.id,
        status="running",
    ).insert()

    result = await InactiveTripService.queue_coverage_reprocessing_for_trips(
        [await _make_trip()],
    )

    assert result["queued"] == 0
    assert result["deferred"] == 1
    stub_backfill.assert_not_awaited()

    refreshed = await CoverageArea.get(area.id)
    assert refreshed is not None
    assert refreshed.coverage_refresh_pending is True


@pytest.mark.asyncio
async def test_pending_refresh_runs_when_the_job_finishes(
    coverage_db,
    stub_backfill,
) -> None:
    del coverage_db
    area = await _make_area()
    await area.set({"coverage_refresh_pending": True})

    result = await InactiveTripService.consume_pending_coverage_refresh(area.id)

    assert result["queued"] is True
    stub_backfill.assert_awaited_once()

    refreshed = await CoverageArea.get(area.id)
    assert refreshed is not None
    assert refreshed.coverage_refresh_pending is False
    assert refreshed.last_backfill_trip_endtime is None


@pytest.mark.asyncio
async def test_no_pending_refresh_is_a_no_op(coverage_db, stub_backfill) -> None:
    del coverage_db
    area = await _make_area()

    result = await InactiveTripService.consume_pending_coverage_refresh(area.id)

    assert result["queued"] is False
    stub_backfill.assert_not_awaited()


@pytest.mark.asyncio
async def test_consume_on_a_missing_area_is_a_no_op(
    coverage_db,
    stub_backfill,
) -> None:
    del coverage_db
    result = await InactiveTripService.consume_pending_coverage_refresh(
        PydanticObjectId(),
    )

    assert result["queued"] is False
    stub_backfill.assert_not_awaited()


@pytest.mark.asyncio
async def test_refresh_clears_derived_driven_state_but_keeps_manual_marks(
    coverage_db,
    stub_backfill,
) -> None:
    del coverage_db
    area = await _make_area()
    await CoverageState(
        area_id=area.id,
        segment_id="seg-derived",
        status="driven",
    ).insert()
    await CoverageState(
        area_id=area.id,
        segment_id="seg-manual",
        status="driven",
        manually_marked=True,
    ).insert()
    await area.set({"coverage_refresh_pending": True})

    await InactiveTripService.consume_pending_coverage_refresh(area.id)

    remaining = await CoverageState.find({"area_id": area.id}).to_list()
    assert [state.segment_id for state in remaining] == ["seg-manual"]
