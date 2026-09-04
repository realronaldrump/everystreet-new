from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from arq import Retry

from db.models import Trip
from trips.services import completed_trip_sync


@pytest.fixture
def completion_dependencies(monkeypatch):
    from admin.services.admin_service import AdminService
    from tasks import config
    from trips.services import bouncie_ingest_runtime

    monkeypatch.setattr(config, "get_global_disable", AsyncMock(return_value=False))
    monkeypatch.setattr(
        config,
        "get_task_config_entry",
        AsyncMock(return_value=SimpleNamespace(enabled=True)),
    )
    monkeypatch.setattr(
        AdminService,
        "get_persisted_app_settings",
        AsyncMock(return_value=SimpleNamespace(mapMatchTripsOnFetch=False)),
    )
    ingest = AsyncMock(return_value={"processed_transaction_ids": [], "counters": {}})
    status = AsyncMock()
    monkeypatch.setattr(bouncie_ingest_runtime, "run_ingest_for_transaction_id", ingest)
    monkeypatch.setattr(completed_trip_sync, "_set_status", status)
    return ingest, status


@pytest.mark.asyncio
async def test_provider_delay_retries_then_uses_authoritative_history(
    beanie_db, completion_dependencies
):
    ingest, status = completion_dependencies
    with pytest.raises(Retry):
        await completed_trip_sync.sync_completed_trip({"job_try": 1}, "delayed-trip")
    assert status.await_args.args[1] == "retrying"
    await Trip(transactionId="delayed-trip", source="bouncie").insert()
    result = await completed_trip_sync.sync_completed_trip(
        {"job_try": 2}, "delayed-trip"
    )
    assert result["status"] == "complete"
    assert ingest.await_args.kwargs == {
        "transaction_id": "delayed-trip",
        "mode": "upsert_bouncie",
        "do_map_match": False,
        "do_coverage": True,
        "sync_mobility": True,
    }


@pytest.mark.asyncio
async def test_provider_retry_is_bounded_and_failure_stays_visible(
    beanie_db, completion_dependencies
):
    ingest, status = completion_dependencies
    result = await completed_trip_sync.sync_completed_trip(
        {"job_try": completed_trip_sync.MAX_ATTEMPTS}, "missing-trip"
    )
    assert result["status"] == "failed"
    assert status.await_args.args[1] == "failed"
    ingest.assert_awaited_once()


@pytest.mark.asyncio
async def test_disabled_auto_sync_does_not_fetch(
    beanie_db, completion_dependencies, monkeypatch
):
    from tasks import config

    ingest, status = completion_dependencies
    monkeypatch.setattr(config, "get_global_disable", AsyncMock(return_value=True))
    assert (await completed_trip_sync.sync_completed_trip({}, "paused-trip"))[
        "status"
    ] == "paused"
    ingest.assert_not_awaited()
    assert status.await_args.args[1] == "paused"


@pytest.mark.asyncio
async def test_duplicate_completions_use_one_deferred_identifier_only_job(monkeypatch):
    redis = SimpleNamespace(enqueue_job=AsyncMock(side_effect=[object(), None]))
    monkeypatch.setattr(
        completed_trip_sync, "get_arq_pool", AsyncMock(return_value=redis)
    )
    status = AsyncMock()
    monkeypatch.setattr(completed_trip_sync, "_set_status", status)
    assert await completed_trip_sync.enqueue_completed_trip_sync("trip-1")
    assert not await completed_trip_sync.enqueue_completed_trip_sync("trip-1")
    calls = redis.enqueue_job.await_args_list
    assert calls[0].args == ("sync_completed_trip", "trip-1")
    assert calls[0].kwargs["_job_id"] == calls[1].kwargs["_job_id"]
    assert calls[0].kwargs["_defer_by"].total_seconds() == 15
    status.assert_awaited_once()
