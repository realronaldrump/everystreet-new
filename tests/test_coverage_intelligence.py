from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from db.models import (
    CoverageArea,
    CoverageGoal,
    CoverageMission,
    CoverageState,
    Job,
    Street,
)
from street_coverage.intelligence import CoverageIntelligenceService

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def intelligence_db():
    from db_helpers import init_mock_beanie

    return await init_mock_beanie(
        CoverageArea,
        CoverageGoal,
        CoverageMission,
        CoverageState,
        Street,
        Job,
    )


async def _area() -> CoverageArea:
    area = CoverageArea(
        display_name="Mission Test City",
        status="ready",
        health="healthy",
        bounding_box=[-105.1, 39.6, -104.9, 39.8],
        driveable_length_miles=100,
        driven_length_miles=20,
        coverage_percentage=20,
        area_version=3,
        journal_revision=7,
    )
    await area.insert()
    return area


async def _street(area: CoverageArea, sequence: int, length: float = 2.0) -> Street:
    street = Street(
        area_id=area.id,
        area_version=area.area_version,
        segment_id=f"{area.id}-{area.area_version}-{sequence}",
        street_name=f"Street {sequence}",
        length_miles=length,
        geometry={
            "type": "LineString",
            "coordinates": [[-105 + sequence * 0.001, 39.7], [-105, 39.701]],
        },
    )
    await street.insert()
    return street


async def test_forecast_uses_trip_derived_active_days_and_excludes_manual(
    intelligence_db,
) -> None:
    area = await _area()
    now = datetime.now(UTC)
    for index, days_ago in enumerate([10, 20, 30, 40], start=1):
        street = await _street(area, index)
        await CoverageState(
            area_id=area.id,
            segment_id=street.segment_id,
            status="driven",
            first_driven_at=now - timedelta(days=days_ago),
            last_driven_at=now - timedelta(days=days_ago),
            driven_by_trip_id=area.id,
        ).insert()
    manual = await _street(area, 99, length=50)
    await CoverageState(
        area_id=area.id,
        segment_id=manual.segment_id,
        status="driven",
        first_driven_at=now - timedelta(days=5),
        last_driven_at=now - timedelta(days=5),
        driven_by_trip_id=area.id,
        manually_marked=True,
    ).insert()

    payload = await CoverageIntelligenceService.get_intelligence(area.id)

    assert payload["forecast"]["available"] is True
    assert payload["forecast"]["active_days"] == 4
    assert payload["forecast"]["median_new_miles_per_active_day"] == 2.0
    assert payload["area"]["remaining_miles"] == 80.0


async def test_forecast_does_not_invent_eta_from_sparse_history(
    intelligence_db,
) -> None:
    area = await _area()
    street = await _street(area, 1)
    await CoverageState(
        area_id=area.id,
        segment_id=street.segment_id,
        status="driven",
        first_driven_at=datetime.now(UTC) - timedelta(days=10),
        driven_by_trip_id=area.id,
    ).insert()

    payload = await CoverageIntelligenceService.get_intelligence(area.id)

    assert payload["forecast"]["available"] is False
    assert payload["forecast"]["expected_completion_date"] is None
    assert payload["forecast"]["confidence"] == "insufficient"


async def test_goal_completes_when_current_percentage_reaches_target(
    intelligence_db,
) -> None:
    area = await _area()

    goal = await CoverageIntelligenceService.save_goal(
        area.id,
        target_percentage=15,
        preferred_mission_minutes=75,
    )

    assert goal["status"] == "completed"
    assert goal["preferred_mission_minutes"] == 75
    assert goal["completed_at"] is not None


async def test_create_mission_revalidates_revision_and_queues_cluster_route(
    intelligence_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    area = await _area()
    street = await _street(area, 1, length=1.5)
    enqueued: dict[str, object] = {}

    async def fake_enqueue(task_id: str, **kwargs):
        enqueued.update({"task_id": task_id, **kwargs})
        return {"job_id": "mission-job", "status": "success"}

    monkeypatch.setattr("tasks.ops.enqueue_task", fake_enqueue)

    mission = await CoverageIntelligenceService.create_mission(
        area.id,
        segment_ids=[street.segment_id],
        expected_area_version=area.area_version,
        expected_journal_revision=area.journal_revision,
        requested_minutes=60,
    )

    assert mission["status"] == "route_generating"
    assert mission["route_job_id"] == enqueued["_job_id"]
    assert enqueued["task_id"] == "generate_optimal_route"
    assert enqueued["segment_ids"] == [street.segment_id]

    with pytest.raises(ValueError, match="Coverage changed"):
        await CoverageIntelligenceService.create_mission(
            area.id,
            segment_ids=[street.segment_id],
            expected_area_version=area.area_version,
            expected_journal_revision=area.journal_revision - 1,
        )


async def test_only_historical_reconciliation_advances_active_mission(
    intelligence_db,
) -> None:
    area = await _area()
    streets = [await _street(area, index, length=1.0) for index in range(1, 3)]
    mission = CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        journal_revision=area.journal_revision,
        status="active",
        target_segment_ids=[street.segment_id for street in streets],
        mapped_segment_ids=[street.segment_id for street in streets],
        target_miles=2,
    )
    await mission.insert()

    await CoverageIntelligenceService.reconcile_historical_trip(
        area_id=area.id,
        area_version=area.area_version,
        trip_id=area.id,
        newly_driven_segment_ids=[street.segment_id for street in streets],
    )

    updated = await CoverageMission.get(mission.id)
    assert updated is not None
    assert updated.status == "completed"
    assert updated.actual_trip_ids == [area.id]
    assert updated.actual_new_miles == 2
