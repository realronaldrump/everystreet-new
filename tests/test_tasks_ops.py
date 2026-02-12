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
