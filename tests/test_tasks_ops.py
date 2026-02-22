from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from tasks import ops


@pytest.mark.asyncio
async def test_run_task_with_history_marks_cancelled(monkeypatch) -> None:
    update_history = AsyncMock()
    monkeypatch.setattr(ops, "update_task_history_entry", update_history)
    monkeypatch.setattr(ops, "update_task_failure", AsyncMock())
    monkeypatch.setattr(ops, "update_task_success", AsyncMock())

    async def cancelled_logic() -> dict[str, str]:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await ops.run_task_with_history(
            ctx={"job_id": "job-cancelled"},
            task_id="fetch_all_missing_trips",
            func=cancelled_logic,
            manual_run=True,
        )

    assert update_history.await_count == 2
    assert update_history.await_args_list[0].kwargs["status"] == "RUNNING"
    assert update_history.await_args_list[1].kwargs["status"] == "CANCELLED"


@pytest.mark.asyncio
async def test_run_task_with_history_skips_when_trip_sync_lock_is_held(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    update_history = AsyncMock()
    update_success = AsyncMock()
    update_failure = AsyncMock()
    logic = AsyncMock(return_value={"status": "success"})

    monkeypatch.setattr(
        ops,
        "_acquire_trip_sync_lock",
        AsyncMock(return_value=(None, "periodic_fetch_trips:other-job")),
    )
    monkeypatch.setattr(ops, "update_task_history_entry", update_history)
    monkeypatch.setattr(ops, "update_task_success", update_success)
    monkeypatch.setattr(ops, "update_task_failure", update_failure)

    result = await ops.run_task_with_history(
        ctx={"job_id": "job-skip"},
        task_id="periodic_fetch_trips",
        func=logic,
        manual_run=False,
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "trip_sync_locked"
    assert update_history.await_count == 1
    assert update_history.await_args.kwargs["status"] == "COMPLETED"
    update_success.assert_not_awaited()
    update_failure.assert_not_awaited()
    logic.assert_not_awaited()


@pytest.mark.asyncio
async def test_run_task_with_history_releases_trip_sync_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    update_history = AsyncMock()
    update_success = AsyncMock()
    release_lock = AsyncMock()

    monkeypatch.setattr(
        ops,
        "_acquire_trip_sync_lock",
        AsyncMock(return_value=(("locks:trip_sync_ingest", "token"), None)),
    )
    monkeypatch.setattr(ops, "_release_trip_sync_lock", release_lock)
    monkeypatch.setattr(ops, "update_task_history_entry", update_history)
    monkeypatch.setattr(ops, "update_task_success", update_success)
    monkeypatch.setattr(ops, "update_task_failure", AsyncMock())

    async def logic() -> dict[str, str]:
        return {"status": "success"}

    result = await ops.run_task_with_history(
        ctx={"job_id": "job-run"},
        task_id="periodic_fetch_trips",
        func=logic,
        manual_run=False,
    )

    assert result["status"] == "success"
    assert update_history.await_count == 2
    assert update_history.await_args_list[0].kwargs["status"] == "RUNNING"
    assert update_history.await_args_list[1].kwargs["status"] == "COMPLETED"
    release_lock.assert_awaited_once_with(("locks:trip_sync_ingest", "token"))
    update_success.assert_awaited_once()
