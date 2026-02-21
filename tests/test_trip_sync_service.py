from datetime import UTC, datetime, timedelta

import pytest
from beanie import PydanticObjectId, init_beanie
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

from db.models import BouncieCredentials, Job, TaskConfig, TaskHistory, Trip, Vehicle
from trips.models import TripSyncRequest
from trips.services import trip_sync_service
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


@pytest.fixture
async def beanie_db_with_history_import():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,  # type: ignore[arg-type]
        document_models=[
            Trip,
            TaskConfig,
            TaskHistory,
            BouncieCredentials,
            Job,
            Vehicle,
        ],
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
async def test_sync_status_requires_credentials(beanie_db_with_tasks) -> None:
    status = await TripSyncService.get_sync_status()
    assert status["state"] == "paused"
    assert status["pause_reason"] == "credentials_missing"


@pytest.mark.asyncio
async def test_sync_status_requires_auth(beanie_db_with_tasks) -> None:
    creds = BouncieCredentials(
        client_id="client",
        client_secret="secret",
        redirect_uri="https://example.com/callback",
        authorization_code=None,
        authorized_devices=["device-123"],
    )
    await creds.insert()
    status = await TripSyncService.get_sync_status()
    assert status["state"] == "paused"
    assert status["pause_reason"] == "auth_required"


@pytest.mark.asyncio
async def test_sync_status_requires_devices(beanie_db_with_tasks) -> None:
    creds = BouncieCredentials(
        client_id="client",
        client_secret="secret",
        redirect_uri="https://example.com/callback",
        authorization_code="auth-code",
        authorized_devices=[],
    )
    await creds.insert()
    status = await TripSyncService.get_sync_status()
    assert status["state"] == "paused"
    assert status["pause_reason"] == "devices_required"


@pytest.mark.asyncio
async def test_sync_status_trip_count_only_counts_bouncie_owned_trips(
    beanie_db_with_tasks,
) -> None:
    await seed_credentials()
    await Trip(
        transactionId="tx-count-bouncie",
        source="bouncie",
        startTime=datetime(2025, 1, 1, 10, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 10, 10, tzinfo=UTC),
    ).insert()
    await Trip(
        transactionId="tx-count-webhook",
        source="webhook",
        startTime=datetime(2025, 1, 1, 11, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 11, 10, tzinfo=UTC),
    ).insert()

    status = await TripSyncService.get_sync_status()
    assert status["trip_count"] == 1


@pytest.mark.asyncio
async def test_sync_status_running(beanie_db_with_tasks) -> None:
    await seed_credentials()
    now = datetime.now(UTC)
    running = TaskHistory(
        task_id="periodic_fetch_trips",
        status="RUNNING",
        timestamp=now,
        start_time=now,
    )
    running.id = "job-running"
    await running.insert()
    status = await TripSyncService.get_sync_status()
    assert status["state"] == "syncing"
    assert status["current_job_id"] == "job-running"


@pytest.mark.asyncio
async def test_sync_status_error_when_failure_is_newer(beanie_db_with_tasks) -> None:
    await seed_credentials()
    success_time = datetime.now(UTC) - timedelta(hours=4)
    failure_time = datetime.now(UTC) - timedelta(minutes=15)

    success = TaskHistory(
        task_id="periodic_fetch_trips",
        status="COMPLETED",
        timestamp=success_time,
        end_time=success_time,
    )
    success.id = "job-success"
    await success.insert()

    failure = TaskHistory(
        task_id="periodic_fetch_trips",
        status="FAILED",
        timestamp=failure_time,
        error="Trip sync failed",
    )
    failure.id = "job-failed"
    await failure.insert()

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


@pytest.mark.asyncio
async def test_start_sync_enqueues_history_with_progress_job(
    beanie_db_with_history_import,
    monkeypatch,
) -> None:
    await seed_credentials()
    await Vehicle(imei="device-123", custom_name="Test Car").insert()
    enqueue_kwargs: dict[str, object] = {}

    async def fake_enqueue(task_id, *args, **kwargs):
        del task_id, args
        enqueue_kwargs.update(kwargs)
        return {"job_id": "arq-job-123"}

    async def fake_plan(*, start_dt, end_dt, selected_imeis=None):
        del start_dt, end_dt, selected_imeis
        return {
            "status": "success",
            "start_iso": "2024-01-01T00:00:00+00:00",
            "end_iso": "2024-01-10T00:00:00+00:00",
            "window_days": 7,
            "overlap_hours": 24,
            "step_hours": 144,
            "windows_total": 2,
            "estimated_requests": 2,
            "fetch_concurrency": 12,
            "devices": [{"imei": "device-123", "name": "Test Car"}],
        }

    monkeypatch.setattr(trip_sync_service, "enqueue_task", fake_enqueue)
    monkeypatch.setattr(trip_sync_service, "build_import_plan", fake_plan)

    result = await TripSyncService.start_sync(
        TripSyncRequest(mode="history", start_date=datetime(2024, 1, 1, tzinfo=UTC)),
    )

    assert result["status"] == "success"
    assert result["job_id"] == "arq-job-123"
    assert result["progress_job_id"]
    assert result["progress_url"].endswith(result["progress_job_id"])
    assert result["progress_sse_url"].endswith(f"{result['progress_job_id']}/sse")

    job = await Job.get(PydanticObjectId(result["progress_job_id"]))
    assert job is not None
    assert job.job_type == "trip_history_import"
    assert job.task_id == "fetch_all_missing_trips"
    assert job.operation_id == "arq-job-123"
    assert job.metadata.get("window_days") == 7
    assert job.metadata.get("overlap_hours") == 24
    assert job.metadata.get("devices") == [{"imei": "device-123", "name": "Test Car"}]
    assert job.metadata.get("selected_imeis") == ["device-123"]
    assert enqueue_kwargs.get("selected_imeis") == ["device-123"]


@pytest.mark.asyncio
async def test_start_sync_history_scopes_selected_imeis(
    beanie_db_with_history_import,
    monkeypatch,
) -> None:
    await seed_credentials()

    plan_selected_imeis: list[str] | None = None
    enqueue_kwargs: dict[str, object] = {}

    async def fake_enqueue(task_id, *args, **kwargs):
        del task_id, args
        enqueue_kwargs.update(kwargs)
        return {"job_id": "arq-job-123"}

    async def fake_plan(*, start_dt, end_dt, selected_imeis=None):
        del start_dt, end_dt
        nonlocal plan_selected_imeis
        plan_selected_imeis = selected_imeis
        return {
            "status": "success",
            "start_iso": "2024-01-01T00:00:00+00:00",
            "end_iso": "2024-01-10T00:00:00+00:00",
            "window_days": 7,
            "overlap_hours": 24,
            "step_hours": 144,
            "windows_total": 2,
            "estimated_requests": 2,
            "fetch_concurrency": 12,
            "devices": [{"imei": "device-123", "name": "Test Car"}],
        }

    monkeypatch.setattr(trip_sync_service, "enqueue_task", fake_enqueue)
    monkeypatch.setattr(trip_sync_service, "build_import_plan", fake_plan)

    await TripSyncService.start_sync(
        TripSyncRequest(
            mode="history",
            start_date=datetime(2024, 1, 1, tzinfo=UTC),
            selected_imeis=["device-123", "unknown-imei"],
        ),
    )

    assert plan_selected_imeis == ["device-123", "unknown-imei"]
    assert enqueue_kwargs.get("selected_imeis") == ["device-123"]


@pytest.mark.asyncio
async def test_start_sync_history_requires_at_least_one_selected_vehicle(
    beanie_db_with_history_import,
    monkeypatch,
) -> None:
    await seed_credentials()

    async def fake_plan(*, start_dt, end_dt, selected_imeis=None):
        del start_dt, end_dt, selected_imeis
        return {
            "status": "success",
            "start_iso": "2024-01-01T00:00:00+00:00",
            "end_iso": "2024-01-10T00:00:00+00:00",
            "window_days": 7,
            "overlap_hours": 24,
            "step_hours": 144,
            "windows_total": 2,
            "estimated_requests": 0,
            "fetch_concurrency": 12,
            "devices": [],
        }

    monkeypatch.setattr(trip_sync_service, "build_import_plan", fake_plan)

    with pytest.raises(HTTPException) as exc_info:
        await TripSyncService.start_sync(
            TripSyncRequest(
                mode="history",
                start_date=datetime(2024, 1, 1, tzinfo=UTC),
                selected_imeis=[],
            ),
        )

    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_sync_status_clears_stale_running_lock(beanie_db_with_tasks) -> None:
    await seed_credentials()
    old = datetime.now(UTC) - timedelta(days=90)
    running = TaskHistory(
        task_id="periodic_fetch_trips",
        status="RUNNING",
        timestamp=old,
        start_time=old,
    )
    running.id = "job-stale-running"
    await running.insert()

    status = await TripSyncService.get_sync_status()
    assert status["state"] == "error"
    assert status["current_job_id"] is None

    history = await TaskHistory.get("job-stale-running")
    assert history is not None
    assert history.status == "FAILED"
    assert history.end_time is not None
    assert history.error


@pytest.mark.asyncio
async def test_start_sync_ignores_stale_running_lock(
    beanie_db_with_tasks,
    monkeypatch,
) -> None:
    await seed_credentials()
    old = datetime.now(UTC) - timedelta(days=90)
    running = TaskHistory(
        task_id="periodic_fetch_trips",
        status="RUNNING",
        timestamp=old,
        start_time=old,
    )
    running.id = "job-stale-running"
    await running.insert()

    async def fake_enqueue(task_id, *args, **kwargs):
        return {"job_id": "job-new"}

    monkeypatch.setattr(trip_sync_service, "enqueue_task", fake_enqueue)

    result = await TripSyncService.start_sync(TripSyncRequest(mode="recent"))
    assert result["status"] == "success"
    assert result["job_id"] == "job-new"


@pytest.mark.asyncio
async def test_sync_status_reports_active_history_import_job_without_task_history(
    beanie_db_with_history_import,
) -> None:
    await seed_credentials()
    now = datetime.now(UTC)
    job = Job(
        job_type="trip_history_import",
        task_id="fetch_all_missing_trips",
        status="running",
        stage="scanning",
        progress=10.0,
        message="Scanning",
        created_at=now,
        updated_at=now,
        started_at=now,
        operation_id="arq-job-1",
        metadata={},
    )
    await job.insert()

    status = await TripSyncService.get_sync_status()
    assert status["state"] == "syncing"
    assert status["history_import_progress_job_id"] == str(job.id)
    assert status["current_job_id"] == "arq-job-1"
    assert status["active_task_id"] == "fetch_all_missing_trips"


@pytest.mark.asyncio
async def test_start_sync_history_when_import_running_returns_progress_payload(
    beanie_db_with_history_import,
) -> None:
    await seed_credentials()
    now = datetime.now(UTC)
    job = Job(
        job_type="trip_history_import",
        task_id="fetch_all_missing_trips",
        status="running",
        stage="scanning",
        progress=10.0,
        message="Scanning",
        created_at=now,
        updated_at=now,
        started_at=now,
        operation_id="arq-job-1",
        metadata={},
    )
    await job.insert()

    result = await TripSyncService.start_sync(
        TripSyncRequest(mode="history", start_date=datetime(2020, 3, 1, tzinfo=UTC)),
    )
    assert result["status"] == "running"
    assert result["progress_job_id"] == str(job.id)


@pytest.mark.asyncio
async def test_cancel_sync_cancels_history_import_job_and_task_history(
    beanie_db_with_history_import,
    monkeypatch,
) -> None:
    await seed_credentials()
    now = datetime.now(UTC)

    history = TaskHistory(
        task_id="fetch_all_missing_trips",
        status="RUNNING",
        timestamp=now,
        start_time=now,
        manual_run=True,
    )
    history.id = "arq-job-1"
    await history.insert()

    job = Job(
        job_type="trip_history_import",
        task_id="fetch_all_missing_trips",
        status="running",
        stage="scanning",
        progress=10.0,
        message="Scanning",
        created_at=now,
        updated_at=now,
        started_at=now,
        operation_id="arq-job-1",
        metadata={},
    )
    await job.insert()

    async def fake_abort(job_id: str) -> bool:
        return True

    monkeypatch.setattr(trip_sync_service, "abort_job", fake_abort)

    result = await TripSyncService.cancel_sync("arq-job-1")
    assert result["status"] == "success"

    updated_history = await TaskHistory.get("arq-job-1")
    assert updated_history is not None
    assert updated_history.status == "CANCELLED"

    updated_job = await Job.get(PydanticObjectId(str(job.id)))
    assert updated_job is not None
    assert updated_job.status == "cancelled"
