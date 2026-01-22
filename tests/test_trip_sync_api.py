from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from trips.routes.sync import router as sync_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(sync_router)
    return app


def test_trip_sync_status_endpoint() -> None:
    app = _create_app()

    with patch(
        "trips.routes.sync.TripSyncService.get_sync_status",
        new=AsyncMock(return_value={"state": "idle", "trip_count": 3}),
    ):
        client = TestClient(app)
        response = client.get("/api/actions/trips/sync/status")

    assert response.status_code == 200
    assert response.json()["state"] == "idle"


def test_trip_sync_start_endpoint() -> None:
    app = _create_app()

    with patch(
        "trips.routes.sync.TripSyncService.start_sync",
        new=AsyncMock(return_value={"status": "success", "job_id": "job-1"}),
    ):
        client = TestClient(app)
        response = client.post("/api/actions/trips/sync", json={"mode": "recent"})

    assert response.status_code == 200
    assert response.json()["job_id"] == "job-1"


def test_trip_sync_config_update_endpoint() -> None:
    app = _create_app()

    with patch(
        "trips.routes.sync.TripSyncService.update_sync_config",
        new=AsyncMock(return_value={"auto_sync_enabled": True, "interval_minutes": 15}),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/actions/trips/sync/config",
            json={"auto_sync_enabled": True, "interval_minutes": 15},
        )

    assert response.status_code == 200
    assert response.json()["interval_minutes"] == 15
