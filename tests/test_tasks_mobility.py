from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from tasks import mobility


@pytest.mark.asyncio
async def test_sync_mobility_profiles_logic_drains_multiple_batches(monkeypatch) -> None:
    sync_mock = AsyncMock(
        side_effect=[
            (4, 6),
            (3, 1),
            (1, 0),
        ],
    )
    monkeypatch.setattr(
        mobility.MobilityInsightsService,
        "sync_unsynced_trips_for_query",
        sync_mock,
    )
    monkeypatch.setattr(mobility, "MOBILITY_SYNC_BATCH_SIZE", 123)
    monkeypatch.setattr(mobility, "MOBILITY_SYNC_BATCHES_PER_RUN", 5)

    result = await mobility._sync_mobility_profiles_logic()

    assert result["status"] == "success"
    assert result["synced_trips"] == 8
    assert result["pending_trip_sync_count"] == 0
    assert result["batches_processed"] == 3
    assert sync_mock.await_count == 3
    for call in sync_mock.await_args_list:
        assert call.args == ({},)
        assert call.kwargs == {"limit": 123}


@pytest.mark.asyncio
async def test_sync_mobility_profiles_task_uses_history_wrapper(monkeypatch) -> None:
    run_mock = AsyncMock(return_value={"status": "success"})
    monkeypatch.setattr(mobility, "run_task_with_history", run_mock)

    result = await mobility.sync_mobility_profiles(
        {"job_id": "job-1"},
        manual_run=True,
    )

    assert result == {"status": "success"}
    assert run_mock.await_count == 1
    call = run_mock.await_args
    assert call.args[1] == "sync_mobility_profiles"
    assert callable(call.args[2])
    assert call.kwargs["manual_run"] is True
