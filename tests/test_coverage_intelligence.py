from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from coverage_helpers import area_with_streets, coverage_database, drive
from db.models import ALL_DOCUMENT_MODELS, CoverageMission
from street_coverage.intelligence import CoverageIntelligenceService
from street_coverage.journal import rebuild_journal_rollup
from street_coverage.projection import set_manual_status

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def intelligence_db():
    database = await coverage_database()
    await init_beanie(database=database, document_models=ALL_DOCUMENT_MODELS)
    return database


async def test_forecast_uses_historical_gains_and_includes_idle_calendar_days(
    intelligence_db,
):
    area, ids = await area_with_streets([2, 2, 2, 2, 50, 42])
    now = datetime.now(UTC)
    for sid, days in zip(ids, [10, 20, 30, 40]):
        await drive(area, {sid: [[0, 1]]}, now - timedelta(days=days))
    await set_manual_status(area.id, [ids[4]], "driven")
    await rebuild_journal_rollup(area.id)
    payload = await CoverageIntelligenceService.get_intelligence(area.id)
    assert payload["forecast"]["available"]
    assert payload["forecast"]["active_days"] == 4
    assert payload["forecast"]["median_new_miles_per_active_day"] == 2
    assert payload["forecast"]["active_days_per_week"] == round(4 / 90 * 7, 2)
    assert payload["area"]["remaining_miles"] == 42


async def test_forecast_does_not_invent_eta_from_sparse_history(intelligence_db):
    area, ids = await area_with_streets([2, 98])
    await drive(area, {ids[0]: [[0, 1]]}, datetime.now(UTC) - timedelta(days=10))
    await rebuild_journal_rollup(area.id)
    payload = await CoverageIntelligenceService.get_intelligence(area.id)
    assert not payload["forecast"]["available"]
    assert payload["forecast"]["expected_completion_date"] is None
    assert payload["forecast"]["confidence"] == "insufficient"


async def test_goal_uses_exact_progress_and_reopens_after_correction(intelligence_db):
    area, ids = await area_with_streets([20, 80])
    await drive(area, {ids[0]: [[0, 1]]})
    goal = await CoverageIntelligenceService.save_goal(
        area.id, target_percentage=15, preferred_mission_minutes=75
    )
    assert goal["status"] == "completed"
    assert goal["preferred_mission_minutes"] == 75
    await set_manual_status(area.id, [ids[0]], "undriven")
    current = await CoverageIntelligenceService.get_goal(area.id)
    assert current.status == "active"
    assert current.completed_at is None


async def test_create_mission_revalidates_revision_and_queues_cluster_route(
    intelligence_db, monkeypatch
):
    area, ids = await area_with_streets([1.5, 98.5])
    enqueued = {}

    async def enqueue(task_id, **kwargs):
        enqueued.update({"task_id": task_id, **kwargs})
        return {"job_id": "mission-job", "status": "success"}

    monkeypatch.setattr("tasks.ops.enqueue_task", enqueue)
    mission = await CoverageIntelligenceService.create_mission(
        area.id,
        segment_ids=[ids[0]],
        expected_area_version=area.area_version,
        expected_journal_revision=area.journal_revision,
        requested_minutes=60,
    )
    assert mission["status"] == "route_generating"
    assert mission["route_job_id"] == enqueued["_job_id"]
    assert enqueued["task_id"] == "generate_optimal_route"
    assert enqueued["segment_ids"] == [ids[0]]
    with pytest.raises(ValueError, match="Coverage changed"):
        await CoverageIntelligenceService.create_mission(
            area.id,
            segment_ids=[ids[0]],
            expected_area_version=1,
            expected_journal_revision=99,
        )


async def test_only_persisted_historical_evidence_advances_a_mission(intelligence_db):
    area, ids = await area_with_streets([1, 1])
    now = datetime.now(UTC)
    mission = CoverageMission(
        area_id=area.id,
        area_version=1,
        journal_revision=0,
        status="active",
        target_segment_ids=ids,
        mapped_segment_ids=ids,
        target_miles=2,
        started_at=now - timedelta(hours=1),
    )
    await mission.insert()
    trip = await drive(area, {ids[0]: [[0, 1]]}, now)
    await CoverageIntelligenceService.reconcile_historical_trip(
        area_id=area.id, area_version=1, trip_id=trip.id, newly_driven_segment_ids=ids
    )
    current = await CoverageMission.get(mission.id)
    assert current.actual_new_miles == 1
    assert current.status == "active"
    await drive(area, {ids[1]: [[0, 1]]}, now)
    current = await CoverageMission.get(mission.id)
    assert current.actual_new_miles == 2
    assert current.status == "completed"


async def test_mission_completion_is_weighted_by_mileage_not_fragment_count(
    intelligence_db,
):
    area, ids = await area_with_streets([0.01] * 19 + [5])
    now = datetime.now(UTC)
    mission = CoverageMission(
        area_id=area.id,
        area_version=1,
        journal_revision=0,
        status="active",
        target_segment_ids=ids,
        mapped_segment_ids=ids,
        target_miles=5.19,
        started_at=now - timedelta(hours=1),
    )
    await mission.insert()
    await drive(area, {sid: [[0, 1]] for sid in ids[:19]}, now)
    current = await CoverageMission.get(mission.id)
    assert len(current.completed_segment_ids) == 19
    assert current.actual_new_miles == pytest.approx(0.19)
    assert current.status == "active"
