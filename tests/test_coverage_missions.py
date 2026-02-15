from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from beanie import PydanticObjectId, init_beanie
from mongomock_motor import AsyncMongoMockClient
from pymongo.errors import DuplicateKeyError

from db.models import CoverageArea, CoverageMission, CoverageState, Street
from street_coverage.api.streets import MarkDrivenSegmentsRequest, mark_segments_driven
from street_coverage.services.missions import (
    CHECKPOINT_LIMIT,
    MISSION_ACTIVE,
    MISSION_COMPLETED,
    CoverageMissionService,
    serialize_mission,
)


@pytest.fixture
async def coverage_mission_db():
    client = AsyncMongoMockClient()
    db = client["test_db"]
    await init_beanie(
        database=db,
        document_models=[CoverageArea, CoverageState, CoverageMission, Street],
    )
    return db


async def _insert_ready_area(name: str = "Mission Area") -> CoverageArea:
    area = CoverageArea(
        display_name=name,
        status="ready",
        health="healthy",
        area_version=1,
        total_length_miles=12.0,
        driveable_length_miles=10.0,
        driven_length_miles=2.5,
        coverage_percentage=25.0,
        total_segments=5,
    )
    await area.insert()
    return area


async def _insert_street(
    *,
    area_id: PydanticObjectId,
    area_version: int,
    segment_id: str,
    length_miles: float,
) -> Street:
    street = Street(
        area_id=area_id,
        area_version=area_version,
        segment_id=segment_id,
        street_name=f"Street {segment_id}",
        highway_type="residential",
        length_miles=length_miles,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
    )
    await street.insert()
    return street


@pytest.mark.asyncio
async def test_create_mission_requires_ready_area_and_enforces_single_active(
    coverage_mission_db,
) -> None:
    area = await _insert_ready_area()
    mission, created = await CoverageMissionService.create_mission(area_id=area.id)
    assert created is True
    assert mission.status == "active"
    assert mission.area_id == area.id
    assert mission.baseline["coverage_percentage"] == 25.0

    resumed, created_again = await CoverageMissionService.create_mission(
        area_id=area.id,
        resume_if_active=True,
    )
    assert created_again is False
    assert resumed.id == mission.id

    with pytest.raises(RuntimeError):
        await CoverageMissionService.create_mission(
            area_id=area.id,
            resume_if_active=False,
        )

    unready = CoverageArea(
        display_name="Not Ready",
        status="processing",
        health="degraded",
        total_length_miles=1.0,
        driveable_length_miles=1.0,
    )
    await unready.insert()
    with pytest.raises(ValueError):
        await CoverageMissionService.create_mission(area_id=unready.id)


@pytest.mark.asyncio
async def test_heartbeat_and_status_transitions_guard_state(coverage_mission_db) -> None:
    area = await _insert_ready_area()
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    original_segments = mission.session_segments_completed
    original_miles = mission.session_gain_miles

    heartbeated = await CoverageMissionService.heartbeat(mission.id, note="keepalive")
    assert heartbeated.status == MISSION_ACTIVE
    assert heartbeated.session_segments_completed == original_segments
    assert heartbeated.session_gain_miles == original_miles
    assert heartbeated.last_heartbeat_at is not None
    assert heartbeated.checkpoints[-1].event == "heartbeat"

    paused = await CoverageMissionService.transition_status(mission.id, new_status="paused")
    assert paused.status == "paused"
    with pytest.raises(ValueError):
        await CoverageMissionService.heartbeat(mission.id)

    resumed = await CoverageMissionService.transition_status(mission.id, new_status="active")
    assert resumed.status == "active"

    completed = await CoverageMissionService.transition_status(
        mission.id,
        new_status=MISSION_COMPLETED,
    )
    assert completed.status == MISSION_COMPLETED
    assert completed.ended_at is not None

    with pytest.raises(ValueError):
        await CoverageMissionService.transition_status(mission.id, new_status="active")


@pytest.mark.asyncio
async def test_cancel_transition_is_terminal(coverage_mission_db) -> None:
    area = await _insert_ready_area("Cancel Transition Area")
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)

    paused = await CoverageMissionService.transition_status(mission.id, new_status="paused")
    assert paused.status == "paused"

    cancelled = await CoverageMissionService.transition_status(
        mission.id,
        new_status="cancelled",
    )
    assert cancelled.status == "cancelled"
    assert cancelled.ended_at is not None

    with pytest.raises(ValueError):
        await CoverageMissionService.transition_status(mission.id, new_status="active")


@pytest.mark.asyncio
async def test_apply_segment_progress_dedupes_ids_and_miles(coverage_mission_db) -> None:
    area = await _insert_ready_area()
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    seg_a = f"{area.id}-{area.area_version}-a"
    seg_b = f"{area.id}-{area.area_version}-b"
    await _insert_street(
        area_id=area.id,
        area_version=area.area_version,
        segment_id=seg_a,
        length_miles=1.25,
    )
    await _insert_street(
        area_id=area.id,
        area_version=area.area_version,
        segment_id=seg_b,
        length_miles=0.75,
    )

    delta = await CoverageMissionService.apply_segment_progress(
        mission_id=mission.id,
        area_id=area.id,
        segment_ids=[seg_a, seg_a, seg_b],
    )
    assert delta["added_segments"] == 2
    assert delta["added_miles"] == pytest.approx(2.0)
    assert delta["total_segments"] == 2

    deduped = await CoverageMissionService.apply_segment_progress(
        mission_id=mission.id,
        area_id=area.id,
        segment_ids=[seg_b, seg_a, seg_b],
    )
    assert deduped["added_segments"] == 0
    assert deduped["added_miles"] == 0.0
    assert deduped["total_segments"] == 2
    assert deduped["total_miles"] == pytest.approx(2.0)


@pytest.mark.asyncio
async def test_apply_segment_progress_concurrent_updates_preserve_all_segments(
    coverage_mission_db,
) -> None:
    area = await _insert_ready_area("Concurrent Mission Area")
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    seg_a = f"{area.id}-{area.area_version}-concurrent-a"
    seg_b = f"{area.id}-{area.area_version}-concurrent-b"
    await _insert_street(
        area_id=area.id,
        area_version=area.area_version,
        segment_id=seg_a,
        length_miles=0.3,
    )
    await _insert_street(
        area_id=area.id,
        area_version=area.area_version,
        segment_id=seg_b,
        length_miles=0.7,
    )

    await asyncio.gather(
        CoverageMissionService.apply_segment_progress(
            mission_id=mission.id,
            area_id=area.id,
            segment_ids=[seg_a],
        ),
        CoverageMissionService.apply_segment_progress(
            mission_id=mission.id,
            area_id=area.id,
            segment_ids=[seg_b],
        ),
    )

    refreshed = await CoverageMissionService.get_mission(mission.id)
    assert refreshed is not None
    assert set(refreshed.completed_segment_ids or []) == {seg_a, seg_b}
    assert refreshed.session_segments_completed == 2
    assert refreshed.session_gain_miles == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_apply_segment_progress_ignores_unknown_segment_ids(coverage_mission_db) -> None:
    area = await _insert_ready_area("Unknown Segment Mission Area")
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    unknown_segment_id = f"{area.id}-{area.area_version}-missing"

    delta = await CoverageMissionService.apply_segment_progress(
        mission_id=mission.id,
        area_id=area.id,
        segment_ids=[unknown_segment_id],
    )
    assert delta["added_segments"] == 0
    assert delta["added_miles"] == 0.0
    assert delta["total_segments"] == 0
    assert delta["total_miles"] == 0.0

    refreshed = await CoverageMissionService.get_mission(mission.id)
    assert refreshed is not None
    assert refreshed.completed_segment_ids == []
    assert refreshed.session_segments_completed == 0


@pytest.mark.asyncio
async def test_apply_segment_progress_rejects_stale_mission_area_version(
    coverage_mission_db,
) -> None:
    area = await _insert_ready_area("Stale Area Version Mission Area")
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    area.area_version += 1
    await area.save()

    with pytest.raises(ValueError, match="Mission area version is stale"):
        await CoverageMissionService.apply_segment_progress(
            mission_id=mission.id,
            area_id=area.id,
            segment_ids=["segment-1"],
        )

    refreshed = await CoverageMissionService.get_mission(mission.id)
    assert refreshed is not None
    assert refreshed.status == "cancelled"


@pytest.mark.asyncio
async def test_apply_segment_progress_rejects_non_ready_area_status(
    coverage_mission_db,
) -> None:
    area = await _insert_ready_area("Non-ready Area Mission Area")
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    area.status = "rebuilding"
    await area.save()

    with pytest.raises(ValueError, match="Coverage area is not ready"):
        await CoverageMissionService.apply_segment_progress(
            mission_id=mission.id,
            area_id=area.id,
            segment_ids=["segment-1"],
        )


@pytest.mark.asyncio
async def test_apply_segment_progress_handles_legacy_missing_completed_ids(
    coverage_mission_db,
) -> None:
    area = await _insert_ready_area("Legacy Mission Area")
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    segment_id = f"{area.id}-{area.area_version}-legacy"
    await _insert_street(
        area_id=area.id,
        area_version=area.area_version,
        segment_id=segment_id,
        length_miles=0.42,
    )

    await CoverageMission.get_pymongo_collection().update_one(
        {"_id": mission.id},
        {
            "$unset": {
                "completed_segment_ids": "",
                "session_segments_completed": "",
                "session_gain_miles": "",
            },
        },
    )

    delta = await CoverageMissionService.apply_segment_progress(
        mission_id=mission.id,
        area_id=area.id,
        segment_ids=[segment_id],
    )
    assert delta["added_segments"] == 1
    assert delta["added_miles"] == pytest.approx(0.42)
    assert delta["total_segments"] == 1
    assert delta["total_miles"] == pytest.approx(0.42)

    refreshed = await CoverageMissionService.get_mission(mission.id)
    assert refreshed is not None
    assert refreshed.completed_segment_ids == [segment_id]


@pytest.mark.asyncio
async def test_mark_driven_back_compat_and_mission_delta(coverage_mission_db) -> None:
    area = await _insert_ready_area()
    seg_1 = f"{area.id}-{area.area_version}-1"
    seg_2 = f"{area.id}-{area.area_version}-2"
    await _insert_street(
        area_id=area.id,
        area_version=area.area_version,
        segment_id=seg_1,
        length_miles=0.4,
    )
    await _insert_street(
        area_id=area.id,
        area_version=area.area_version,
        segment_id=seg_2,
        length_miles=0.6,
    )

    no_mission = await mark_segments_driven(
        area_id=area.id,
        request=MarkDrivenSegmentsRequest(segment_ids=[seg_1]),
    )
    assert no_mission["success"] is True
    assert no_mission["newly_driven"] == 1
    assert no_mission["mission_delta"] is None

    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    with_mission = await mark_segments_driven(
        area_id=area.id,
        request=MarkDrivenSegmentsRequest(
            segment_ids=[seg_2],
            mission_id=str(mission.id),
        ),
    )
    assert with_mission["success"] is True
    assert with_mission["newly_driven"] == 1
    assert with_mission["mission_delta"] is not None
    assert with_mission["mission_delta"]["added_segments"] == 1
    assert with_mission["mission_delta"]["added_miles"] == pytest.approx(0.6)


@pytest.mark.asyncio
async def test_get_active_mission_retires_stale_active_record(coverage_mission_db) -> None:
    area = await _insert_ready_area("Retire Stale Mission Area")
    stale, _ = await CoverageMissionService.create_mission(area_id=area.id)
    previous_area_version = area.area_version
    area.area_version += 1
    await area.save()

    active = await CoverageMissionService.get_active_mission(area.id)
    assert active is None

    refreshed_stale = await CoverageMissionService.get_mission(stale.id)
    assert refreshed_stale is not None
    assert refreshed_stale.status == "cancelled"
    assert refreshed_stale.ended_at is not None
    assert refreshed_stale.checkpoints[-1].event == "cancelled"
    assert (
        refreshed_stale.checkpoints[-1].metadata["previous_area_version"]
        == previous_area_version
    )
    assert refreshed_stale.checkpoints[-1].metadata["current_area_version"] == area.area_version

    replacement, created = await CoverageMissionService.create_mission(area_id=area.id)
    assert created is True
    assert replacement.id != stale.id
    assert replacement.area_version == area.area_version


@pytest.mark.asyncio
async def test_list_missions_filters_pagination_and_sorting(coverage_mission_db) -> None:
    area = await _insert_ready_area()
    now = datetime.now(UTC)
    mission_new = CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status=MISSION_ACTIVE,
        started_at=now,
        updated_at=now,
        last_heartbeat_at=now,
    )
    mission_mid = CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status="paused",
        started_at=now - timedelta(minutes=1),
        updated_at=now - timedelta(minutes=1),
        last_heartbeat_at=now - timedelta(minutes=1),
    )
    mission_old = CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status=MISSION_COMPLETED,
        started_at=now - timedelta(minutes=2),
        updated_at=now - timedelta(minutes=2),
        last_heartbeat_at=now - timedelta(minutes=2),
        ended_at=now - timedelta(minutes=1),
    )
    await mission_new.insert()
    await mission_mid.insert()
    await mission_old.insert()

    filtered, total_filtered = await CoverageMissionService.list_missions(
        area_id=str(area.id),
        status=MISSION_COMPLETED,
        limit=10,
        offset=0,
    )
    assert total_filtered == 1
    assert [mission.status for mission in filtered] == [MISSION_COMPLETED]

    page, total = await CoverageMissionService.list_missions(
        area_id=str(area.id),
        limit=2,
        offset=1,
    )
    assert total == 3
    assert len(page) == 2
    assert page[0].started_at > page[1].started_at
    assert page[0].status == "paused"
    assert page[1].status == MISSION_COMPLETED


@pytest.mark.asyncio
async def test_create_mission_handles_duplicate_key_race(coverage_mission_db) -> None:
    area = await _insert_ready_area("Race Area")
    existing, _ = await CoverageMissionService.create_mission(area_id=area.id)

    original_insert = CoverageMission.insert

    async def _raise_duplicate(*_args, **_kwargs):
        raise DuplicateKeyError("E11000 duplicate key error")

    CoverageMission.insert = _raise_duplicate
    try:
        resumed, created = await CoverageMissionService.create_mission(
            area_id=area.id,
            resume_if_active=True,
        )
        assert created is False
        assert resumed.id == existing.id
    finally:
        CoverageMission.insert = original_insert


@pytest.mark.asyncio
async def test_resume_transition_handles_duplicate_key_race(coverage_mission_db) -> None:
    area = await _insert_ready_area("Resume Race Area")
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)
    paused = await CoverageMissionService.transition_status(
        mission.id,
        new_status="paused",
    )
    assert paused.status == "paused"

    original_save = CoverageMission.save

    async def _raise_duplicate(*_args, **_kwargs):
        raise DuplicateKeyError("E11000 duplicate key error")

    CoverageMission.save = _raise_duplicate
    try:
        with pytest.raises(ValueError, match="Another active mission already exists"):
            await CoverageMissionService.transition_status(paused.id, new_status="active")
    finally:
        CoverageMission.save = original_save


@pytest.mark.asyncio
async def test_resume_is_blocked_when_another_active_exists(coverage_mission_db) -> None:
    area = await _insert_ready_area("Resume Conflict Area")
    active, _ = await CoverageMissionService.create_mission(area_id=area.id)

    paused = CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status="paused",
    )
    await paused.insert()

    with pytest.raises(ValueError):
        await CoverageMissionService.transition_status(paused.id, new_status="active")

    refreshed_active = await CoverageMissionService.get_mission(active.id)
    assert refreshed_active is not None
    assert refreshed_active.status == "active"


@pytest.mark.asyncio
async def test_checkpoints_are_capped_and_serialized(coverage_mission_db) -> None:
    area = await _insert_ready_area("Checkpoint Cap Area")
    mission, _ = await CoverageMissionService.create_mission(area_id=area.id)

    for idx in range(CHECKPOINT_LIMIT + 5):
        mission = await CoverageMissionService.heartbeat(mission.id, note=f"hb-{idx}")

    assert len(mission.checkpoints) == CHECKPOINT_LIMIT
    assert mission.checkpoints[-1].event == "heartbeat"

    payload = serialize_mission(mission)
    assert payload["completed_segment_count"] == len(payload["completed_segment_ids"])
    assert len(payload["checkpoints"]) == CHECKPOINT_LIMIT


@pytest.mark.asyncio
async def test_list_missions_tiebreaks_by_id_desc(coverage_mission_db) -> None:
    area = await _insert_ready_area("Tie Break Area")
    started = datetime.now(UTC)

    older = CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status="paused",
        started_at=started,
        updated_at=started,
    )
    newer = CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status="completed",
        started_at=started,
        updated_at=started,
        ended_at=started,
    )
    await older.insert()
    await newer.insert()

    missions, _ = await CoverageMissionService.list_missions(
        area_id=str(area.id),
        limit=10,
        offset=0,
    )
    assert len(missions) >= 2
    assert str(missions[0].id) > str(missions[1].id)


def test_coverage_mission_indexes_include_single_active_guard() -> None:
    index_docs = [idx.document for idx in CoverageMission.Settings.indexes]
    names = {doc.get("name") for doc in index_docs}
    assert "coverage_missions_one_active_per_area_idx" in names
    target = next(
        doc
        for doc in index_docs
        if doc.get("name") == "coverage_missions_one_active_per_area_idx"
    )
    assert target.get("unique") is True
    assert target.get("partialFilterExpression") == {"status": "active"}
