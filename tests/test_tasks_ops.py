from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from tasks import ops


class _FakeTripSyncRedis:
    def __init__(self, initial_holder: str | None = None) -> None:
        self.value = initial_holder

    async def set(self, _key: str, value: str, *, ex: int, nx: bool) -> bool:
        assert ex > 0
        if nx and self.value is not None:
            return False
        self.value = value
        return True

    async def get(self, _key: str) -> str | None:
        return self.value

    async def eval(self, _script: str, _key_count: int, _key: str, token: str) -> int:
        if self.value == token:
            self.value = None
            return 1
        return 0


def _fake_task_history(status: str, task_id: str = "periodic_fetch_trips"):
    class FakeTaskHistory:
        @staticmethod
        async def get(_job_id: str):
            return type("History", (), {"status": status, "task_id": task_id})()

    return FakeTaskHistory


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


@pytest.mark.asyncio
async def test_acquire_trip_sync_lock_recovers_terminal_holder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stale_holder = "periodic_fetch_trips:cron:cron_periodic_fetch_trips:123:old-token"
    redis = _FakeTripSyncRedis(stale_holder)
    monkeypatch.setattr(ops, "get_arq_pool", AsyncMock(return_value=redis))
    monkeypatch.setattr(ops, "TaskHistory", _fake_task_history("CANCELLED"))

    lock_handle, holder = await ops._acquire_trip_sync_lock(
        task_id="periodic_fetch_trips",
        job_id="new-job",
    )

    assert holder is None
    assert lock_handle is not None
    assert lock_handle[0] == "locks:trip_sync_ingest"
    assert lock_handle[1].startswith("periodic_fetch_trips:new-job:")
    assert redis.value == lock_handle[1]


@pytest.mark.asyncio
async def test_acquire_trip_sync_lock_keeps_active_holder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    active_holder = "periodic_fetch_trips:active-job:active-token"
    redis = _FakeTripSyncRedis(active_holder)
    monkeypatch.setattr(ops, "get_arq_pool", AsyncMock(return_value=redis))
    monkeypatch.setattr(ops, "TaskHistory", _fake_task_history("RUNNING"))

    lock_handle, holder = await ops._acquire_trip_sync_lock(
        task_id="periodic_fetch_trips",
        job_id="new-job",
    )

    assert lock_handle is None
    assert holder == active_holder
    assert redis.value == active_holder
