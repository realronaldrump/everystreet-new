from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from beanie import PydanticObjectId
from coverage_helpers import area_with_streets, coverage_database, drive
from core.coverage import (
    backfill_coverage_for_area,
    update_coverage_for_trip,
    _build_backfill_trip_query,
)
from db.models import CoverageArea, CoverageDriveEvent, CoverageState, Job, Street, Trip
from street_coverage import ingestion as coverage_ingestion
from street_coverage.projection import set_manual_status
from street_coverage.stats import update_area_stats


@pytest.fixture
async def coverage_db(monkeypatch):
    database = await coverage_database()
    from beanie import init_beanie
    from db.models import ALL_DOCUMENT_MODELS

    await init_beanie(database=database, document_models=ALL_DOCUMENT_MODELS)
    # Geometry itself is exercised by the real matcher. Mongo's spatial query
    # is covered in the replica-set suite, because mongomock has no geo index.
    monkeypatch.setattr(
        "core.coverage._build_backfill_trip_query",
        lambda *a, **kw: {
            "source": "bouncie",
            "invalid": {"$ne": True},
            "inactive": {"$ne": True},
        },
    )
    return database


async def test_historical_first_last_and_latest_trip_are_monotonic(coverage_db):
    area, ids = await area_with_streets([1])
    newer = await drive(area, {ids[0]: [[0, 1]]}, datetime(2025, 1, 2, tzinfo=UTC))
    await drive(area, {ids[0]: [[0, 1]]}, datetime(2025, 1, 1, tzinfo=UTC))
    state = await CoverageState.find_one({"segment_id": ids[0]})
    assert state.first_driven_at == datetime(2025, 1, 1, tzinfo=UTC)
    assert state.last_driven_at == datetime(2025, 1, 2, tzinfo=UTC)
    assert state.driven_by_trip_id == newer.id
    latest = await drive(area, {ids[0]: [[0, 1]]}, datetime(2025, 1, 3, tzinfo=UTC))
    state = await CoverageState.find_one({"segment_id": ids[0]})
    assert state.driven_by_trip_id == latest.id
    assert state.first_driven_at == datetime(2025, 1, 1, tzinfo=UTC)
    assert (await CoverageArea.get(area.id)).driven_segments == 1


async def test_unknown_manual_segments_are_rejected_instead_of_reported_saved(
    coverage_db,
):
    area, ids = await area_with_streets([1])
    with pytest.raises(ValueError, match="changed"):
        await set_manual_status(area.id, [ids[0], "missing"], "driven")
    assert await CoverageState.find_all().count() == 0


async def test_concurrent_first_drives_only_credit_one_street(coverage_db):
    area, ids = await area_with_streets([1])
    await asyncio.gather(*(drive(area, {ids[0]: [[0, 1]]}) for _ in range(6)))
    current = await CoverageArea.get(area.id)
    assert current.driven_segments == 1
    assert current.driven_length_miles == 1
    assert await CoverageDriveEvent.find_all().count() == 6


async def test_missing_area_is_an_explicit_error(coverage_db):
    with pytest.raises(ValueError, match="not found"):
        await set_manual_status(PydanticObjectId(), ["unknown"], "driven")


@pytest.mark.parametrize("trip_id", [None, "not-an-object-id", str(PydanticObjectId())])
async def test_update_coverage_for_trip_rejects_unpersisted_trip(coverage_db, trip_id):
    with pytest.raises(ValueError, match="persisted Bouncie"):
        await update_coverage_for_trip({"source": "bouncie"}, trip_id=trip_id)
    assert await CoverageState.find_all().count() == 0


async def test_manual_transitions_preserve_exact_counters_and_override(coverage_db):
    area, ids = await area_with_streets([1, 1])
    await set_manual_status(area.id, [ids[0]], "driven")
    assert (await CoverageArea.get(area.id)).coverage_percentage == 50
    await set_manual_status(area.id, [ids[0]], "undriveable")
    current = await CoverageArea.get(area.id)
    assert current.driven_length_miles == 0 and current.driveable_length_miles == 1
    await set_manual_status(area.id, [ids[0]], "undriven")
    current = await CoverageArea.get(area.id)
    assert current.driveable_length_miles == 2 and current.driven_segments == 0
    state = await CoverageState.find_one({"segment_id": ids[0]})
    assert state.manually_marked and state.status == "undriven"


async def _trace_trip(geometry, when, *, matched=None):
    trip = Trip(
        transactionId=str(PydanticObjectId()),
        source="bouncie",
        startTime=when,
        endTime=when,
        gps=geometry,
        matchedGps=matched,
        matchStatus="matched:linestring" if matched else None,
    )
    await trip.insert()
    return trip


async def test_backfill_sets_first_last_and_latest_trip(coverage_db):
    area, ids = await area_with_streets([1])
    geometry = (await Street.find_one({"segment_id": ids[0]})).geometry
    first = await _trace_trip(geometry, datetime(2025, 1, 1, tzinfo=UTC))
    last = await _trace_trip(geometry, datetime(2025, 1, 2, tzinfo=UTC))
    progress = []

    async def update(payload):
        progress.append(payload)

    await backfill_coverage_for_area(
        area.id, trip_mode="regular", progress_callback=update, progress_interval=1
    )
    state = await CoverageState.find_one({"segment_id": ids[0]})
    assert state.first_driven_at == first.endTime
    assert state.last_driven_at == last.endTime
    assert state.driven_by_trip_id == last.id
    assert progress[-1]["processed_trips"] == 2
    assert progress[-1]["matched_trips"] == 2
    assert (await CoverageArea.get(area.id)).driven_length_miles == pytest.approx(1)


async def test_interrupted_backfill_preserves_published_state_until_success(
    coverage_db,
):
    area, ids = await area_with_streets([1])
    geometry = (await Street.find_one({"segment_id": ids[0]})).geometry
    await _trace_trip(geometry, datetime(2025, 1, 1, tzinfo=UTC))
    await backfill_coverage_for_area(area.id, trip_mode="regular")
    before = (await CoverageArea.get(area.id)).driven_length_miles
    events = await CoverageDriveEvent.find_all().count()

    async def interrupted(_):
        raise RuntimeError("interrupted")

    with pytest.raises(RuntimeError, match="interrupted"):
        await backfill_coverage_for_area(
            area.id,
            trip_mode="regular",
            full=True,
            progress_callback=interrupted,
            progress_interval=1,
        )
    assert (await CoverageArea.get(area.id)).driven_length_miles == before
    assert await CoverageDriveEvent.find_all().count() == events
    assert await CoverageState.find_all().count() == 1
    await backfill_coverage_for_area(area.id, trip_mode="regular", full=True)
    assert (await CoverageArea.get(area.id)).driven_length_miles == before


async def test_full_backfill_retracts_deleted_trip_evidence(coverage_db):
    area, ids = await area_with_streets([1])
    geometry = (await Street.find_one({"segment_id": ids[0]})).geometry
    trip = await _trace_trip(geometry, datetime(2025, 1, 1, tzinfo=UTC))
    await backfill_coverage_for_area(area.id, trip_mode="regular")
    await trip.delete()
    await backfill_coverage_for_area(area.id, trip_mode="regular")
    assert await CoverageDriveEvent.find_all().count() == 0
    assert await CoverageState.find_all().count() == 0
    assert (await CoverageArea.get(area.id)).driven_length_miles == 0


async def test_stats_refresh_recovers_missing_projection_from_valid_evidence(
    coverage_db,
):
    area, ids = await area_with_streets([1, 1])
    first = await drive(
        area, {ids[0]: [[0, 1]], ids[1]: [[0, 1]]}, datetime(2025, 1, 1, tzinfo=UTC)
    )
    latest = await drive(area, {ids[1]: [[0, 1]]}, datetime(2025, 1, 2, tzinfo=UTC))
    await CoverageState.find_all().delete()
    await update_area_stats(area.id)
    states = {
        state.segment_id: state for state in await CoverageState.find_all().to_list()
    }
    assert states[ids[0]].driven_by_trip_id == first.id
    assert states[ids[1]].driven_by_trip_id == latest.id
    assert (await CoverageArea.get(area.id)).driven_length_miles == 2


@pytest.mark.parametrize("mode,expected", [("regular", 0), ("matched", 1), ("both", 1)])
async def test_backfill_uses_selected_trace_and_best_mode_never_unions_conflicts(
    coverage_db, mode, expected
):
    area, ids = await area_with_streets([1, 1])
    streets = await Street.find({"area_id": area.id}).sort("segment_id").to_list()
    await _trace_trip(
        streets[0].geometry,
        datetime(2025, 1, 1, tzinfo=UTC),
        matched=streets[1].geometry,
    )
    await backfill_coverage_for_area(area.id, trip_mode=mode)
    assert {state.segment_id for state in await CoverageState.find_all().to_list()} == {
        ids[expected]
    }


async def test_matching_policy_change_replaces_previous_credit(coverage_db):
    area, ids = await area_with_streets([1, 1])
    streets = await Street.find({"area_id": area.id}).sort("segment_id").to_list()
    await _trace_trip(
        streets[0].geometry,
        datetime(2025, 1, 1, tzinfo=UTC),
        matched=streets[1].geometry,
    )
    await backfill_coverage_for_area(area.id, trip_mode="regular")
    await backfill_coverage_for_area(area.id, trip_mode="matched")
    assert {state.segment_id for state in await CoverageState.find_all().to_list()} == {
        ids[1]
    }
    assert (await CoverageArea.get(area.id)).driven_length_miles == 1


async def test_bbox_query_has_unambiguous_geo_predicates(coverage_db):
    area, _ = await area_with_streets([1])
    query = _build_backfill_trip_query(area, trip_mode="both")
    assert query["source"] == "bouncie"
    for branch in query["$or"]:
        geometry = branch.get("gps") or branch.get("matchedGps")
        assert "$geoIntersects" in geometry and "$ne" not in geometry


@pytest.mark.asyncio
async def test_create_area_enqueues_ingestion_job(coverage_db) -> None:
    class _QueuedJob:
        def __init__(self, job_id: str) -> None:
            self.job_id = job_id

    class _Pool:
        def __init__(self) -> None:
            self.enqueue_job = AsyncMock(return_value=_QueuedJob("arq-ingestion-1"))

    pool = _Pool()
    boundary = {
        "type": "Polygon",
        "coordinates": [
            [
                [-97.2, 31.5],
                [-97.2, 31.6],
                [-97.1, 31.6],
                [-97.1, 31.5],
                [-97.2, 31.5],
            ],
        ],
    }

    with patch(
        "street_coverage.ingestion.get_arq_pool", new=AsyncMock(return_value=pool)
    ):
        area = await coverage_ingestion.create_area(
            display_name="Queued Ingestion Area",
            area_type="city",
            boundary=boundary,
            trip_mode="matched",
        )

    assert area.id is not None
    job = await Job.find_one({"area_id": area.id, "job_type": "area_ingestion"})
    assert job is not None
    assert job.operation_id == "arq-ingestion-1"
    assert job.task_id == "arq-ingestion-1"
    pool.enqueue_job.assert_awaited_once_with(
        "run_area_ingestion_job",
        str(area.id),
        str(job.id),
        "matched",
    )


@pytest.mark.asyncio
async def test_rebuild_area_enqueues_ingestion_job(coverage_db) -> None:
    class _QueuedJob:
        def __init__(self, job_id: str) -> None:
            self.job_id = job_id

    class _Pool:
        def __init__(self) -> None:
            self.enqueue_job = AsyncMock(return_value=_QueuedJob("arq-rebuild-1"))

    pool = _Pool()
    area = CoverageArea(
        display_name="Rebuild Queue Area",
        status="ready",
        health="healthy",
        last_backfill_trip_endtime=datetime(2025, 1, 3, tzinfo=UTC),
        boundary={
            "type": "Polygon",
            "coordinates": [
                [
                    [-97.2, 31.5],
                    [-97.2, 31.6],
                    [-97.1, 31.6],
                    [-97.1, 31.5],
                    [-97.2, 31.5],
                ],
            ],
        },
    )
    await area.insert()
    assert area.id is not None

    with patch(
        "street_coverage.ingestion.get_arq_pool", new=AsyncMock(return_value=pool)
    ):
        created_job = await coverage_ingestion.rebuild_area(
            area.id, trip_mode="regular"
        )

    assert created_job.id is not None
    refreshed_job = await Job.get(created_job.id)
    assert refreshed_job is not None
    assert refreshed_job.operation_id == "arq-rebuild-1"
    assert refreshed_job.task_id == "arq-rebuild-1"

    rebuilt_area = await CoverageArea.get(area.id)
    assert rebuilt_area is not None
    assert rebuilt_area.last_backfill_trip_endtime.replace(tzinfo=UTC) == datetime(
        2025, 1, 3, tzinfo=UTC
    )
    assert rebuilt_area.pending_area_version == rebuilt_area.area_version + 1

    pool.enqueue_job.assert_awaited_once_with(
        "run_area_ingestion_job",
        str(area.id),
        str(created_job.id),
        "regular",
    )


@pytest.mark.asyncio
async def test_backfill_area_enqueues_backfill_job(coverage_db) -> None:
    class _QueuedJob:
        def __init__(self, job_id: str) -> None:
            self.job_id = job_id

    class _Pool:
        def __init__(self) -> None:
            self.enqueue_job = AsyncMock(return_value=_QueuedJob("arq-backfill-1"))

    pool = _Pool()
    area = CoverageArea(
        display_name="Backfill Queue Area",
        status="ready",
        health="healthy",
    )
    await area.insert()
    assert area.id is not None

    with patch(
        "street_coverage.ingestion.get_arq_pool", new=AsyncMock(return_value=pool)
    ):
        created_job = await coverage_ingestion.backfill_area(area.id, trip_mode="both")

    assert created_job.id is not None
    refreshed_job = await Job.get(created_job.id)
    assert refreshed_job is not None
    assert refreshed_job.operation_id == "arq-backfill-1"
    assert refreshed_job.task_id == "arq-backfill-1"
    pool.enqueue_job.assert_awaited_once_with(
        "run_area_backfill_job",
        str(area.id),
        str(created_job.id),
        "both",
    )


@pytest.mark.asyncio
async def test_ingestion_pipeline_respects_cancelled_job(
    coverage_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    area = CoverageArea(
        display_name="Cancelled Ingestion Area",
        status="initializing",
        health="unavailable",
    )
    await area.insert()
    assert area.id is not None

    job = Job(
        job_type="area_ingestion",
        area_id=area.id,
        status="cancelled",
        stage="Cancelled by user",
        message="Cancelled",
    )
    await job.insert()
    assert job.id is not None

    # Ensure the pipeline exits early and doesn't overwrite the cancelled status.
    await coverage_ingestion._run_ingestion_pipeline(area.id, job.id)

    job_after = await Job.get(job.id)
    assert job_after is not None
    assert job_after.status == "cancelled"
    assert job_after.stage == "Cancelled by user"
    assert job_after.completed_at is not None

    area_after = await CoverageArea.get(area.id)
    assert area_after is not None
    assert area_after.status == "error"
    assert area_after.last_error == "Cancelled by user"
