from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from beanie import PydanticObjectId
from db_helpers import init_mock_beanie

from db.models import CoverageArea, CoverageState, Job, Trip
from tasks.street_coverage import (
    run_area_backfill_job,
    run_area_ingestion_job,
    run_area_recalculate_batch_job,
)
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
async def test_refresh_marks_pending_before_checking_for_an_active_job(
    coverage_db,
    stub_backfill,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A job finishing during the active-job check cannot miss the request."""
    del coverage_db
    area = await _make_area()
    marker_states: list[bool] = []

    async def _finish_during_lookup(_query):
        refreshed = await CoverageArea.get(area.id)
        assert refreshed is not None
        marker_states.append(refreshed.coverage_refresh_pending)

    monkeypatch.setattr(
        Job,
        "find_one",
        AsyncMock(side_effect=_finish_during_lookup),
    )

    result = await InactiveTripService.queue_coverage_reprocessing_for_trips(
        [await _make_trip()],
    )

    assert marker_states == [True]
    assert result["queued"] == 1
    stub_backfill.assert_awaited_once()


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
async def test_two_consumers_claim_one_pending_refresh(
    coverage_db,
    stub_backfill,
) -> None:
    del coverage_db
    area = await _make_area()
    await area.set({"coverage_refresh_pending": True})

    first, second = await asyncio.gather(
        InactiveTripService.consume_pending_coverage_refresh(area.id),
        InactiveTripService.consume_pending_coverage_refresh(area.id),
    )

    assert sorted([first["queued"], second["queued"]]) == [False, True]
    stub_backfill.assert_awaited_once()


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
async def test_refresh_preserves_published_state_until_replacement_commits(
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
    assert {state.segment_id for state in remaining} == {"seg-derived", "seg-manual"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("runner", "pipeline_name"),
    [
        (run_area_ingestion_job, "_run_ingestion_pipeline"),
        (run_area_backfill_job, "_run_backfill_pipeline"),
    ],
)
async def test_standalone_coverage_jobs_consume_pending_refreshes(
    coverage_db,
    monkeypatch: pytest.MonkeyPatch,
    runner,
    pipeline_name: str,
) -> None:
    del coverage_db
    area = await _make_area()
    job = Job(job_type="area_rebuild", area_id=area.id, status="queued")
    await job.insert()
    pipeline = AsyncMock()
    consume = AsyncMock(return_value={"queued": False, "job_id": None})
    monkeypatch.setattr(f"tasks.street_coverage.{pipeline_name}", pipeline)
    monkeypatch.setattr(
        InactiveTripService,
        "consume_pending_coverage_refresh",
        consume,
    )

    await runner({}, str(area.id), str(job.id))

    pipeline.assert_awaited_once()
    consume.assert_awaited_once_with(area.id)


@pytest.mark.asyncio
async def test_batch_coverage_jobs_consume_each_pending_refresh(
    coverage_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del coverage_db
    area = await _make_area()
    child = Job(job_type="area_backfill", area_id=area.id, status="queued")
    batch = Job(job_type="area_recalculate_batch", status="queued")
    await child.insert()
    await batch.insert()

    async def _complete_pipeline(_area_id, child_job_id, **_kwargs):
        persisted = await Job.get(child_job_id)
        assert persisted is not None
        await persisted.set({"status": "completed"})

    consume = AsyncMock(return_value={"queued": False, "job_id": None})
    monkeypatch.setattr(
        "tasks.street_coverage._run_backfill_pipeline",
        AsyncMock(side_effect=_complete_pipeline),
    )
    monkeypatch.setattr(
        InactiveTripService,
        "consume_pending_coverage_refresh",
        consume,
    )

    await run_area_recalculate_batch_job(
        {},
        str(batch.id),
        [{"area_id": str(area.id), "job_id": str(child.id)}],
    )

    consume.assert_awaited_once_with(area.id)
