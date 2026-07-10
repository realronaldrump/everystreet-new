from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from trips.api.sync import router as sync_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(sync_router)
    return app


def test_trip_sync_status_endpoint_is_read_only() -> None:
    app = _create_app()
    with patch(
        "trips.api.sync.TripSyncService.get_sync_status",
        new=AsyncMock(return_value={"state": "idle", "trip_count": 3}),
    ):
        client = TestClient(app)
        response = client.get("/api/actions/trips/sync/status")
        start_response = client.post(
            "/api/actions/trips/sync",
            json={"mode": "recent"},
        )

    assert response.status_code == 200
    assert response.json()["state"] == "idle"
    assert start_response.status_code == 404
