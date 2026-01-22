from datetime import UTC, datetime, timedelta

from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from db.models import BouncieCredentials, TaskConfig, TaskHistory, Trip
from trips.models import TripSyncRequest
import trips.services.trip_sync_service as trip_sync_service
from trips.services.trip_sync_service import TripSyncService


@pytest.fixture
async def beanie_db_with_tasks():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,  # type: ignore[arg-type]
        document_models=[Trip, TaskConfig, TaskHistory, BouncieCredentials],
    )
    return database


async def seed_credentials() -> None:
    creds = BouncieCredentials(
        client_id="client",
        client_secret="secret",
        redirect_uri="https://example.com/callback",
        authorization_code="auth-code",
        authorized_devices=["device-123"],
    )
    await creds.insert()


@pytest.mark.asyncio
async def test_sync_status_requires_auth(beanie_db_with_tasks) -> None:
    status = await TripSyncService.get_sync_status()
    assert status["state"] == "paused"
    assert status["pause_reason"] == "auth_required"


@pytest.mark.asyncio
async def test_sync_status_running(beanie_db_with_tasks) -> None:
    await seed_credentials()
    now = datetime.now(UTC)
    await TaskHistory(
        _id="job-running",
        task_id="periodic_fetch_trips",
        status="RUNNING",
        timestamp=now,
        start_time=now,
    ).insert()
    status = await TripSyncService.get_sync_status()
    assert status["state"] == "syncing"
    assert status["current_job_id"] == "job-running"


@pytest.mark.asyncio
async def test_sync_status_error_when_failure_is_newer(beanie_db_with_tasks) -> None:
    await seed_credentials()
    success_time = datetime.now(UTC) - timedelta(hours=4)
    failure_time = datetime.now(UTC) - timedelta(minutes=15)

    await TaskHistory(
        _id="job-success",
        task_id="periodic_fetch_trips",
        status="COMPLETED",
        timestamp=success_time,
        end_time=success_time,
    ).insert()
    await TaskHistory(
        _id="job-failed",
        task_id="periodic_fetch_trips",
        status="FAILED",
        timestamp=failure_time,
        error="Trip sync failed",
    ).insert()

    status = await TripSyncService.get_sync_status()
    assert status["state"] == "error"
    assert status["error"]["code"] == "sync_failed"


@pytest.mark.asyncio
async def test_start_sync_enqueues_recent(beanie_db_with_tasks, monkeypatch) -> None:
    await seed_credentials()

    async def fake_enqueue(task_id, *args, **kwargs):
        return {"job_id": "job-123"}

    monkeypatch.setattr(trip_sync_service, "enqueue_task", fake_enqueue)

    result = await TripSyncService.start_sync(TripSyncRequest(mode="recent"))
    assert result["status"] == "success"
    assert result["job_id"] == "job-123"
