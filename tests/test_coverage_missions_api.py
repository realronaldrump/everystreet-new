from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from db.models import CoverageArea, CoverageMission, CoverageState, Street
from street_coverage.api import router as coverage_router


@pytest.fixture
async def coverage_missions_api_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,
        document_models=[CoverageArea, CoverageState, CoverageMission, Street],
    )
    return database


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(coverage_router)
    return app


async def _insert_ready_area(name: str = "Mission API Area") -> CoverageArea:
    area = CoverageArea(
        display_name=name,
        status="ready",
        health="healthy",
        total_length_miles=8.0,
        driveable_length_miles=8.0,
        driven_length_miles=1.0,
        coverage_percentage=12.5,
        total_segments=4,
        area_version=1,
    )
    await area.insert()
    return area


async def _insert_street(area: CoverageArea, segment_id: str, miles: float) -> None:
    await Street(
        segment_id=segment_id,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
        street_name=f"Street {segment_id}",
        highway_type="residential",
        length_miles=miles,
    ).insert()


@pytest.mark.asyncio
async def test_mission_lifecycle_endpoints(coverage_missions_api_db) -> None:
    area = await _insert_ready_area()
    client = TestClient(_build_app())

    create_resp = client.post(
        "/api/coverage/missions",
        json={
            "area_id": str(area.id),
            "resume_if_active": True,
            "route_snapshot": {"source": "test"},
            "baseline": {"coverage_percentage": 12.5},
            "note": "start",
        },
    )
    assert create_resp.status_code == 200
    create_payload = create_resp.json()
    assert create_payload["status"] == "success"
    assert create_payload["created"] is True
    mission_id = create_payload["mission"]["id"]
    assert mission_id
    assert create_payload["mission"]["status"] == "active"

    active_resp = client.get(f"/api/coverage/missions/active?area_id={area.id}")
    assert active_resp.status_code == 200
    assert active_resp.json()["mission"]["id"] == mission_id

    heartbeat_resp = client.post(
        f"/api/coverage/missions/{mission_id}/heartbeat",
        json={"note": "pulse", "metadata": {"source": "test"}},
    )
    assert heartbeat_resp.status_code == 200
    assert heartbeat_resp.json()["mission"]["status"] == "active"

    pause_resp = client.post(
        f"/api/coverage/missions/{mission_id}/pause",
        json={"note": "pause"},
    )
    assert pause_resp.status_code == 200
    assert pause_resp.json()["mission"]["status"] == "paused"

    heartbeat_while_paused = client.post(f"/api/coverage/missions/{mission_id}/heartbeat")
    assert heartbeat_while_paused.status_code == 409

    resume_resp = client.post(
        f"/api/coverage/missions/{mission_id}/resume",
        json={"note": "resume"},
    )
    assert resume_resp.status_code == 200
    assert resume_resp.json()["mission"]["status"] == "active"

    complete_resp = client.post(
        f"/api/coverage/missions/{mission_id}/complete",
        json={"note": "done"},
    )
    assert complete_resp.status_code == 200
    assert complete_resp.json()["mission"]["status"] == "completed"

    invalid_transition = client.post(f"/api/coverage/missions/{mission_id}/resume")
    assert invalid_transition.status_code == 409


@pytest.mark.asyncio
async def test_mission_cancel_endpoint_transitions_to_cancelled(
    coverage_missions_api_db,
) -> None:
    area = await _insert_ready_area("Mission API Cancel Area")
    client = TestClient(_build_app())

    create_resp = client.post("/api/coverage/missions", json={"area_id": str(area.id)})
    assert create_resp.status_code == 200
    mission_id = create_resp.json()["mission"]["id"]

    cancel_resp = client.post(
        f"/api/coverage/missions/{mission_id}/cancel",
        json={"note": "user stopped"},
    )
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["mission"]["status"] == "cancelled"

    invalid_after_cancel = client.post(f"/api/coverage/missions/{mission_id}/resume")
    assert invalid_after_cancel.status_code == 409


@pytest.mark.asyncio
async def test_mission_create_resume_or_conflict(coverage_missions_api_db) -> None:
    area = await _insert_ready_area("Mission API Area 2")
    client = TestClient(_build_app())

    first = client.post("/api/coverage/missions", json={"area_id": str(area.id)})
    assert first.status_code == 200
    first_mission_id = first.json()["mission"]["id"]

    resumed = client.post(
        "/api/coverage/missions",
        json={"area_id": str(area.id), "resume_if_active": True},
    )
    assert resumed.status_code == 200
    assert resumed.json()["created"] is False
    assert resumed.json()["mission"]["id"] == first_mission_id

    conflict = client.post(
        "/api/coverage/missions",
        json={"area_id": str(area.id), "resume_if_active": False},
    )
    assert conflict.status_code == 409


@pytest.mark.asyncio
async def test_mark_driven_backcompat_and_mission_delta_via_api(
    coverage_missions_api_db,
) -> None:
    area = await _insert_ready_area("Mission API Area 3")
    seg_1 = f"{area.id}-{area.area_version}-1"
    seg_2 = f"{area.id}-{area.area_version}-2"
    await _insert_street(area, seg_1, 0.5)
    await _insert_street(area, seg_2, 0.75)

    client = TestClient(_build_app())
    no_mission = client.post(
        f"/api/coverage/areas/{area.id}/streets/mark-driven",
        json={"segment_ids": [seg_1]},
    )
    assert no_mission.status_code == 200
    assert no_mission.json()["mission_delta"] is None

    mission_create = client.post("/api/coverage/missions", json={"area_id": str(area.id)})
    mission_id = mission_create.json()["mission"]["id"]

    with_mission = client.post(
        f"/api/coverage/areas/{area.id}/streets/mark-driven",
        json={"segment_ids": [seg_2], "mission_id": mission_id},
    )
    assert with_mission.status_code == 200
    payload = with_mission.json()
    assert payload["mission_delta"] is not None
    assert payload["mission_delta"]["mission_id"] == mission_id
    assert payload["mission_delta"]["added_segments"] == 1
    assert payload["mission_delta"]["added_miles"] == pytest.approx(0.75)


@pytest.mark.asyncio
async def test_mark_driven_with_mission_from_other_area_returns_conflict(
    coverage_missions_api_db,
) -> None:
    area_a = await _insert_ready_area("Mission API Area A")
    area_b = await _insert_ready_area("Mission API Area B")
    seg = f"{area_a.id}-{area_a.area_version}-1"
    await _insert_street(area_a, seg, 0.25)

    client = TestClient(_build_app())
    mission_create = client.post("/api/coverage/missions", json={"area_id": str(area_b.id)})
    mission_id = mission_create.json()["mission"]["id"]

    response = client.post(
        f"/api/coverage/areas/{area_a.id}/streets/mark-driven",
        json={"segment_ids": [seg], "mission_id": mission_id},
    )
    assert response.status_code == 409
    assert "Mission does not belong to this area" in response.json()["detail"]
    state = await CoverageState.find_one({"area_id": area_a.id, "segment_id": seg})
    assert state is None


@pytest.mark.asyncio
async def test_mark_driven_with_paused_mission_returns_conflict_without_mutation(
    coverage_missions_api_db,
) -> None:
    area = await _insert_ready_area("Mission API Paused Mission Area")
    seg = f"{area.id}-{area.area_version}-1"
    await _insert_street(area, seg, 0.4)
    client = TestClient(_build_app())

    mission_create = client.post("/api/coverage/missions", json={"area_id": str(area.id)})
    mission_id = mission_create.json()["mission"]["id"]
    pause = client.post(f"/api/coverage/missions/{mission_id}/pause")
    assert pause.status_code == 200

    response = client.post(
        f"/api/coverage/areas/{area.id}/streets/mark-driven",
        json={"segment_ids": [seg], "mission_id": mission_id},
    )
    assert response.status_code == 409
    assert "Mission is not active" in response.json()["detail"]
    state = await CoverageState.find_one({"area_id": area.id, "segment_id": seg})
    assert state is None


@pytest.mark.asyncio
async def test_heartbeat_preserves_segment_counters_via_api(
    coverage_missions_api_db,
) -> None:
    area = await _insert_ready_area("Mission API Heartbeat Area")
    seg = f"{area.id}-{area.area_version}-1"
    await _insert_street(area, seg, 0.33)
    client = TestClient(_build_app())

    mission_create = client.post("/api/coverage/missions", json={"area_id": str(area.id)})
    mission_id = mission_create.json()["mission"]["id"]

    driven = client.post(
        f"/api/coverage/areas/{area.id}/streets/mark-driven",
        json={"segment_ids": [seg], "mission_id": mission_id},
    )
    assert driven.status_code == 200
    assert driven.json()["mission_delta"]["total_segments"] == 1
    assert driven.json()["mission_delta"]["total_miles"] == pytest.approx(0.33)

    heartbeat = client.post(
        f"/api/coverage/missions/{mission_id}/heartbeat",
        json={"note": "pulse"},
    )
    assert heartbeat.status_code == 200
    hb_mission = heartbeat.json()["mission"]
    assert hb_mission["session_segments_completed"] == 1
    assert hb_mission["session_gain_miles"] == pytest.approx(0.33)


@pytest.mark.asyncio
async def test_mission_list_filters_and_pagination(coverage_missions_api_db) -> None:
    area = await _insert_ready_area("Mission API Area 4")
    now = datetime.now(UTC)

    await CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status="completed",
        started_at=now - timedelta(minutes=3),
        updated_at=now - timedelta(minutes=3),
        last_heartbeat_at=now - timedelta(minutes=3),
        ended_at=now - timedelta(minutes=2),
    ).insert()
    await CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status="paused",
        started_at=now - timedelta(minutes=2),
        updated_at=now - timedelta(minutes=2),
        last_heartbeat_at=now - timedelta(minutes=2),
    ).insert()
    await CoverageMission(
        area_id=area.id,
        area_version=area.area_version,
        area_display_name=area.display_name,
        status="active",
        started_at=now - timedelta(minutes=1),
        updated_at=now - timedelta(minutes=1),
        last_heartbeat_at=now - timedelta(minutes=1),
    ).insert()

    client = TestClient(_build_app())

    filtered = client.get(
        f"/api/coverage/missions?area_id={area.id}&status=completed&limit=10&offset=0"
    )
    assert filtered.status_code == 200
    filtered_payload = filtered.json()
    assert filtered_payload["count"] == 1
    assert filtered_payload["limit"] == 10
    assert filtered_payload["offset"] == 0
    assert filtered_payload["has_more"] is False
    assert len(filtered_payload["missions"]) == 1
    assert filtered_payload["missions"][0]["status"] == "completed"
    assert filtered_payload["missions"][0]["completed_segment_ids"] == []
    assert filtered_payload["missions"][0]["checkpoints"] == []

    first_page = client.get(
        f"/api/coverage/missions?area_id={area.id}&limit=2&offset=0"
    )
    assert first_page.status_code == 200
    first_page_payload = first_page.json()
    assert first_page_payload["count"] == 3
    assert first_page_payload["has_more"] is True
    assert len(first_page_payload["missions"]) == 2

    paged = client.get(
        f"/api/coverage/missions?area_id={area.id}&limit=2&offset=1"
    )
    assert paged.status_code == 200
    paged_payload = paged.json()
    assert paged_payload["count"] == 3
    assert paged_payload["limit"] == 2
    assert paged_payload["offset"] == 1
    assert paged_payload["has_more"] is False
    assert len(paged_payload["missions"]) == 2
    assert paged_payload["missions"][0]["status"] == "paused"
    assert paged_payload["missions"][1]["status"] == "completed"


@pytest.mark.asyncio
async def test_mission_list_invalid_area_id_returns_400(coverage_missions_api_db) -> None:
    client = TestClient(_build_app())
    response = client.get("/api/coverage/missions?area_id=not-an-object-id")
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_mission_list_invalid_status_returns_400(coverage_missions_api_db) -> None:
    client = TestClient(_build_app())
    response = client.get("/api/coverage/missions?status=unknown")
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_get_all_streets_missing_area_returns_404(coverage_missions_api_db) -> None:
    client = TestClient(_build_app())
    response = client.get("/api/coverage/areas/65f9f9f9f9f9f9f9f9f9f9f9/streets/all")
    assert response.status_code == 404
    assert response.json()["detail"] == "Coverage area not found"


@pytest.mark.asyncio
async def test_get_all_streets_status_query_alias_and_validation(
    coverage_missions_api_db,
) -> None:
    area = await _insert_ready_area("Mission API Streets Status Area")
    client = TestClient(_build_app())

    valid = client.get(f"/api/coverage/areas/{area.id}/streets/all?status=undriven")
    assert valid.status_code == 200
    assert valid.json()["type"] == "FeatureCollection"

    invalid = client.get(f"/api/coverage/areas/{area.id}/streets/all?status=bad")
    assert invalid.status_code == 400
    assert invalid.json()["detail"] == "Invalid status filter"


@pytest.mark.asyncio
async def test_mission_detail_invalid_id_returns_400(coverage_missions_api_db) -> None:
    client = TestClient(_build_app())
    response = client.get("/api/coverage/missions/not-an-object-id")
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid mission_id"


@pytest.mark.asyncio
async def test_mission_heartbeat_invalid_id_returns_400(coverage_missions_api_db) -> None:
    client = TestClient(_build_app())
    response = client.post("/api/coverage/missions/not-an-object-id/heartbeat")
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid mission_id"


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["pause", "resume", "complete", "cancel"])
async def test_mission_transition_invalid_id_returns_400(
    coverage_missions_api_db,
    action: str,
) -> None:
    client = TestClient(_build_app())
    response = client.post(f"/api/coverage/missions/not-an-object-id/{action}")
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid mission_id"


@pytest.mark.asyncio
async def test_mark_driven_invalid_mission_id_returns_400(coverage_missions_api_db) -> None:
    area = await _insert_ready_area("Mission API Invalid Mission ID Area")
    seg = f"{area.id}-{area.area_version}-1"
    await _insert_street(area, seg, 0.22)
    client = TestClient(_build_app())

    response = client.post(
        f"/api/coverage/areas/{area.id}/streets/mark-driven",
        json={"segment_ids": [seg], "mission_id": "not-an-object-id"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid mission_id"
    state = await CoverageState.find_one({"area_id": area.id, "segment_id": seg})
    assert state is None
