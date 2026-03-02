from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from tasks import coverage


@pytest.mark.asyncio
async def test_sync_geo_coverage_logic_success(monkeypatch) -> None:
    run_mock = AsyncMock(
        return_value={
            "status": "success",
            "mode": "incremental",
            "job_id": "job-123",
            "message": "done",
            "result": {"processedTrips": 5},
        },
    )
    monkeypatch.setattr(coverage, "run_scheduled_recalculate", run_mock)

    result = await coverage._sync_geo_coverage_logic()

    assert result["status"] == "success"
    assert result["mode"] == "incremental"
    assert result["job_id"] == "job-123"
    assert result["result"]["processedTrips"] == 5
    run_mock.assert_awaited_once_with(mode="incremental")


@pytest.mark.asyncio
async def test_sync_geo_coverage_logic_skipped_when_running(monkeypatch) -> None:
    run_mock = AsyncMock(
        return_value={
            "status": "skipped",
            "reason": "already_running",
            "job_id": "job-running",
            "message": "already running",
        },
    )
    monkeypatch.setattr(coverage, "run_scheduled_recalculate", run_mock)

    result = await coverage._sync_geo_coverage_logic()

    assert result == {
        "status": "skipped",
        "reason": "already_running",
        "job_id": "job-running",
        "message": "already running",
    }
    run_mock.assert_awaited_once_with(mode="incremental")


@pytest.mark.asyncio
async def test_sync_geo_coverage_task_uses_history_wrapper(monkeypatch) -> None:
    run_history = AsyncMock(return_value={"status": "success"})
    monkeypatch.setattr(coverage, "run_task_with_history", run_history)

    result = await coverage.sync_geo_coverage({"job_id": "job-1"}, manual_run=True)

    assert result == {"status": "success"}
    assert run_history.await_count == 1
    call = run_history.await_args
    assert call.args[1] == "sync_geo_coverage"
    assert callable(call.args[2])
    assert call.kwargs["manual_run"] is True


@pytest.mark.asyncio
async def test_enqueue_geo_coverage_sync_on_trip_ingest_enqueues(monkeypatch) -> None:
    class _TaskConfig:
        enabled = True

    redis = AsyncMock()
    redis.set = AsyncMock(return_value=True)

    monkeypatch.setattr(coverage, "get_global_disable", AsyncMock(return_value=False))
    monkeypatch.setattr(
        coverage,
        "get_task_config_entry",
        AsyncMock(return_value=_TaskConfig()),
    )
    monkeypatch.setattr(coverage, "get_arq_pool", AsyncMock(return_value=redis))
    monkeypatch.setattr(
        coverage,
        "enqueue_task",
        AsyncMock(return_value={"job_id": "arq-job-1"}),
    )

    result = await coverage.enqueue_geo_coverage_sync_on_trip_ingest(
        source="bouncie",
        transaction_id="tx-1",
    )

    assert result["status"] == "success"
    assert result["job_id"] == "arq-job-1"
    assert redis.set.await_count == 1
    _, kwargs = redis.set.await_args
    assert kwargs["nx"] is True
    assert kwargs["ex"] == coverage._GEO_COVERAGE_TRIGGER_TTL_SECONDS


@pytest.mark.asyncio
async def test_enqueue_geo_coverage_sync_on_trip_ingest_throttled(monkeypatch) -> None:
    class _TaskConfig:
        enabled = True

    redis = AsyncMock()
    redis.set = AsyncMock(return_value=False)

    enqueue_mock = AsyncMock(return_value={"job_id": "arq-job-1"})

    monkeypatch.setattr(coverage, "get_global_disable", AsyncMock(return_value=False))
    monkeypatch.setattr(
        coverage,
        "get_task_config_entry",
        AsyncMock(return_value=_TaskConfig()),
    )
    monkeypatch.setattr(coverage, "get_arq_pool", AsyncMock(return_value=redis))
    monkeypatch.setattr(coverage, "enqueue_task", enqueue_mock)

    result = await coverage.enqueue_geo_coverage_sync_on_trip_ingest(
        source="bouncie",
        transaction_id="tx-2",
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "throttled"
    assert enqueue_mock.await_count == 0


@pytest.mark.asyncio
async def test_enqueue_geo_coverage_sync_on_trip_ingest_skips_non_bouncie(
    monkeypatch,
) -> None:
    get_global_disable_mock = AsyncMock(return_value=False)
    monkeypatch.setattr(coverage, "get_global_disable", get_global_disable_mock)

    result = await coverage.enqueue_geo_coverage_sync_on_trip_ingest(
        source="webhook",
        transaction_id="tx-3",
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "unsupported_source"
    assert get_global_disable_mock.await_count == 0
