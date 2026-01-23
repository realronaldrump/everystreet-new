from unittest.mock import AsyncMock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from trips.routes.sync import router as sync_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(sync_router)
    return app


def debug_trip_sync_start_endpoint() -> None:
    app = _create_app()

    with patch(
        "trips.routes.sync.TripSyncService.start_sync",
        new=AsyncMock(return_value={"status": "success", "job_id": "job-1"}),
    ):
        client = TestClient(app)
        response = client.post("/api/actions/trips/sync", json={"mode": "recent"})

    print(f"Status Code: {response.status_code}")
    if response.status_code == 422:
        print(f"Response Body: {response.json()}")


if __name__ == "__main__":
    debug_trip_sync_start_endpoint()
