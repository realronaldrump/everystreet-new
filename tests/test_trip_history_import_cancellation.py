from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from trips.services import trip_history_import_service_progress as progress_runtime
from trips.services.trip_history_import_service_progress import ImportProgressContext


@pytest.mark.asyncio
async def test_import_uses_task_history_as_durable_cancellation_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        progress_runtime,
        "_load_progress_job",
        AsyncMock(
            return_value=SimpleNamespace(
                status="running",
                operation_id="arq-job-1",
            ),
        ),
    )
    monkeypatch.setattr(
        progress_runtime.TaskHistory,
        "get",
        AsyncMock(return_value=SimpleNamespace(status="CANCELLED")),
    )
    context = ImportProgressContext(
        start_dt=datetime(2025, 1, 1, tzinfo=UTC),
        end_dt=datetime(2025, 1, 2, tzinfo=UTC),
        progress_job_id="65b1b5b6b5b6b5b6b5b6b5b6",
        handle=None,
        devices=[],
        windows_total=0,
        counters={},
        per_device={},
    )

    assert await context.is_cancelled(force=True) is True


@pytest.mark.asyncio
async def test_running_progress_cannot_overwrite_cancelled_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        progress_runtime,
        "_load_progress_job",
        AsyncMock(return_value=SimpleNamespace(status="cancelled")),
    )
    handle = SimpleNamespace(
        job=SimpleNamespace(status="running", error=None, completed_at=None),
        update=AsyncMock(),
    )
    context = ImportProgressContext(
        start_dt=datetime(2025, 1, 1, tzinfo=UTC),
        end_dt=datetime(2025, 1, 2, tzinfo=UTC),
        progress_job_id="65b1b5b6b5b6b5b6b5b6b5b6",
        handle=handle,
        devices=[],
        windows_total=1,
        counters={},
        per_device={},
    )

    await context.write_progress(
        status="running",
        stage="processing",
        message="Processing vehicle windows",
        progress=50.0,
    )

    handle.update.assert_not_awaited()
