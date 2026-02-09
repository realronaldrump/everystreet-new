from unittest.mock import AsyncMock, patch

from datetime import UTC, datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from trips.api.sync import router as sync_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(sync_router)
    return app


def test_trip_sync_status_endpoint() -> None:
    app = _create_app()

    with patch(
        "trips.api.sync.TripSyncService.get_sync_status",
        new=AsyncMock(return_value={"state": "idle", "trip_count": 3}),
    ):
        client = TestClient(app)
        response = client.get("/api/actions/trips/sync/status")

    assert response.status_code == 200
    assert response.json()["state"] == "idle"


def test_trip_sync_start_endpoint() -> None:
    app = _create_app()

    with patch(
        "trips.api.sync.TripSyncService.start_sync",
        new=AsyncMock(return_value={"status": "success", "job_id": "job-1"}),
    ):
        client = TestClient(app)
        response = client.post("/api/actions/trips/sync", json={"mode": "recent"})

    assert response.status_code == 200
    assert response.json()["job_id"] == "job-1"


def test_trip_sync_start_endpoint_history_returns_progress_job_id() -> None:
    app = _create_app()

    with patch(
        "trips.api.sync.TripSyncService.start_sync",
        new=AsyncMock(
            return_value={
                "status": "success",
                "job_id": "job-1",
                "progress_job_id": "65b1b5b6b5b6b5b6b5b6b5b6",
                "progress_url": "/api/actions/trips/sync/history_import/65b1b5b6b5b6b5b6b5b6b5b6",
                "progress_sse_url": "/api/actions/trips/sync/history_import/65b1b5b6b5b6b5b6b5b6b5b6/sse",
            }
        ),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/actions/trips/sync",
            json={"mode": "history", "start_date": "2024-01-01T00:00:00Z"},
        )

    assert response.status_code == 200
    assert response.json()["progress_job_id"] == "65b1b5b6b5b6b5b6b5b6b5b6"


def test_trip_history_import_status_endpoint_returns_metadata() -> None:
    app = _create_app()

    class StubJob:
        def __init__(self) -> None:
            self.id = "65b1b5b6b5b6b5b6b5b6b5b6"
            self.job_type = "trip_history_import"
            self.task_id = "fetch_all_missing_trips"
            self.operation_id = "arq-1"
            self.status = "running"
            self.stage = "scanning"
            self.progress = 42.0
            self.message = "Scanning"
            self.error = None
            self.created_at = None
            self.started_at = None
            self.completed_at = None
            self.updated_at = None
            self.metadata = {
                "counters": {
                    "found_raw": 10,
                    "found_unique": 9,
                    "skipped_existing": 3,
                    "skipped_missing_end_time": 1,
                    "new_candidates": 6,
                    "inserted": 5,
                    "fetch_errors": 0,
                    "process_errors": 1,
                }
            }
            self.result = None

    with patch("trips.api.sync.Job.get", new=AsyncMock(return_value=StubJob())):
        client = TestClient(app)
        response = client.get(
            "/api/actions/trips/sync/history_import/65b1b5b6b5b6b5b6b5b6b5b6",
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["metadata"]["counters"]["found_raw"] == 10
    assert payload["metadata"]["counters"]["inserted"] == 5


def test_trip_history_import_cancel_endpoint_marks_job_cancelled_and_clears_task_history_lock() -> None:
    app = _create_app()

    class StubJob:
        def __init__(self) -> None:
            self.id = "65b1b5b6b5b6b5b6b5b6b5b6"
            self.job_type = "trip_history_import"
            self.task_id = "fetch_all_missing_trips"
            self.operation_id = "arq-job-1"
            self.status = "running"
            self.stage = "scanning"
            self.message = "Scanning"
            self.progress = 1.0
            self.error = None
            self.created_at = None
            self.started_at = None
            self.completed_at = None
            self.updated_at = None
            self.metadata = {}
            self.result = None

        async def save(self) -> None:
            return None

    stub = StubJob()
    with patch("trips.api.sync.Job.get", new=AsyncMock(return_value=stub)), patch(
        "trips.api.sync.abort_job",
        new=AsyncMock(return_value=True),
    ) as abort_mock, patch(
        "trips.api.sync.update_task_history_entry",
        new=AsyncMock(return_value=None),
    ) as history_mock:
        client = TestClient(app)
        response = client.delete(
            "/api/actions/trips/sync/history_import/65b1b5b6b5b6b5b6b5b6b5b6",
        )

    assert response.status_code == 200
    assert stub.status == "cancelled"
    abort_mock.assert_awaited()
    history_mock.assert_awaited()


def test_trip_history_import_cancel_endpoint_idempotent_does_not_overwrite_completed_task_history() -> None:
    app = _create_app()

    completed_at = datetime(2025, 1, 2, 3, 4, 5, tzinfo=UTC)

    class StubJob:
        def __init__(self) -> None:
            self.id = "65b1b5b6b5b6b5b6b5b6b5b6"
            self.job_type = "trip_history_import"
            self.task_id = "fetch_all_missing_trips"
            self.operation_id = "arq-job-1"
            self.status = "completed"
            self.stage = "done"
            self.message = "Done"
            self.progress = 100.0
            self.error = None
            self.created_at = None
            self.started_at = None
            self.completed_at = completed_at
            self.updated_at = completed_at
            self.metadata = {}
            self.result = None

    class StubHistory:
        def __init__(self) -> None:
            self.id = "arq-job-1"
            self.task_id = "fetch_all_missing_trips"
            self.status = "COMPLETED"
            self.timestamp = completed_at
            self.manual_run = True
            self.start_time = None
            self.end_time = completed_at
            self.error = None
            self.save = AsyncMock(return_value=None)

    history = StubHistory()

    with patch("trips.api.sync.Job.get", new=AsyncMock(return_value=StubJob())), patch(
        "trips.api.sync.TaskHistory.get",
        new=AsyncMock(return_value=history),
    ), patch(
        "trips.api.sync.update_task_history_entry",
        new=AsyncMock(return_value=None),
    ) as history_update_mock:
        client = TestClient(app)
        response = client.delete(
            "/api/actions/trips/sync/history_import/65b1b5b6b5b6b5b6b5b6b5b6",
        )

    assert response.status_code == 200
    assert response.json()["message"] == "Job is already finished."
    history_update_mock.assert_not_awaited()
    history.save.assert_not_awaited()
    assert history.end_time == completed_at
    assert history.error is None


def test_trip_history_import_cancel_endpoint_idempotent_clears_running_task_history_lock() -> None:
    app = _create_app()

    completed_at = datetime(2025, 2, 3, 4, 5, 6, tzinfo=UTC)

    class StubJob:
        def __init__(self) -> None:
            self.id = "65b1b5b6b5b6b5b6b5b6b5b6"
            self.job_type = "trip_history_import"
            self.task_id = "fetch_all_missing_trips"
            self.operation_id = "arq-job-1"
            self.status = "completed"
            self.stage = "done"
            self.message = "Done"
            self.progress = 100.0
            self.error = None
            self.created_at = None
            self.started_at = None
            self.completed_at = completed_at
            self.updated_at = completed_at
            self.metadata = {}
            self.result = None

    class StubHistory:
        def __init__(self) -> None:
            self.id = "arq-job-1"
            self.task_id = "fetch_all_missing_trips"
            self.status = "RUNNING"
            self.timestamp = datetime(2025, 2, 3, 4, 0, 0, tzinfo=UTC)
            self.manual_run = True
            self.start_time = None
            self.end_time = None
            self.error = None
            self.save = AsyncMock(return_value=None)

    history = StubHistory()

    with patch("trips.api.sync.Job.get", new=AsyncMock(return_value=StubJob())), patch(
        "trips.api.sync.TaskHistory.get",
        new=AsyncMock(return_value=history),
    ), patch(
        "trips.api.sync.update_task_history_entry",
        new=AsyncMock(return_value=None),
    ) as history_update_mock:
        client = TestClient(app)
        response = client.delete(
            "/api/actions/trips/sync/history_import/65b1b5b6b5b6b5b6b5b6b5b6",
        )

    assert response.status_code == 200
    history_update_mock.assert_not_awaited()
    history.save.assert_awaited()
    assert history.status == "COMPLETED"
    assert history.end_time == completed_at


def test_trip_sync_config_update_endpoint() -> None:
    app = _create_app()

    with patch(
        "trips.api.sync.TripSyncService.update_sync_config",
        new=AsyncMock(return_value={"auto_sync_enabled": True, "interval_minutes": 15}),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/actions/trips/sync/config",
            json={"auto_sync_enabled": True, "interval_minutes": 15},
        )

    assert response.status_code == 200
    assert response.json()["interval_minutes"] == 15
