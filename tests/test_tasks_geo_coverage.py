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
