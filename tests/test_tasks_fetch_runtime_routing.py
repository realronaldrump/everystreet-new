from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from tasks import fetch as fetch_tasks


class _SettingsStub:
    def __init__(self, map_match_on_fetch: bool = False) -> None:
        self._map_match_on_fetch = map_match_on_fetch

    def model_dump(self) -> dict[str, Any]:
        return {"mapMatchTripsOnFetch": self._map_match_on_fetch}


@pytest.mark.asyncio
async def test_manual_fetch_range_routes_to_shared_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mocked = AsyncMock(return_value={"processed_transaction_ids": ["tx-1"]})
    monkeypatch.setattr(fetch_tasks, "run_ingest_for_range", mocked)

    result = await fetch_tasks._manual_fetch_trips_range_logic(
        "2026-03-01T00:00:00Z",
        "2026-03-02T00:00:00Z",
        map_match=True,
        manual_run=True,
    )

    assert result["status"] == "success"
    mocked.assert_awaited_once()
    kwargs = mocked.await_args.kwargs
    assert kwargs["mode"] == "upsert_bouncie"
    assert kwargs["do_map_match"] is True


@pytest.mark.asyncio
async def test_fetch_by_transaction_id_routes_to_shared_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fetch_tasks.AdminService,
        "get_persisted_app_settings",
        AsyncMock(return_value=_SettingsStub(map_match_on_fetch=True)),
    )
    mocked = AsyncMock(return_value={"processed_transaction_ids": ["tx-1"]})
    monkeypatch.setattr(fetch_tasks, "run_ingest_for_transaction_id", mocked)

    result = await fetch_tasks._fetch_trip_by_transaction_id_logic("tx-1")

    assert result["status"] == "success"
    mocked.assert_awaited_once()
    kwargs = mocked.await_args.kwargs
    assert kwargs["mode"] == "upsert_bouncie"
    assert kwargs["transaction_id"] == "tx-1"


@pytest.mark.asyncio
async def test_periodic_fetch_routes_to_shared_runtime(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    monkeypatch.setattr(
        fetch_tasks,
        "get_bouncie_config",
        AsyncMock(return_value={"authorized_devices": ["imei-1"]}),
    )
    monkeypatch.setattr(
        fetch_tasks.AdminService,
        "get_persisted_app_settings",
        AsyncMock(return_value=_SettingsStub(map_match_on_fetch=False)),
    )

    mocked = AsyncMock(return_value={"processed_transaction_ids": ["tx-1"]})
    monkeypatch.setattr(fetch_tasks, "run_ingest_for_range", mocked)

    result = await fetch_tasks._periodic_fetch_trips_logic(
        start_time_iso="2026-03-01T00:00:00Z",
        end_time_iso="2026-03-02T00:00:00Z",
        trigger_source="manual",
    )

    assert result["status"] == "success"
    mocked.assert_awaited_once()
    kwargs = mocked.await_args.kwargs
    assert kwargs["mode"] == "upsert_bouncie"


@pytest.mark.asyncio
async def test_history_retry_skips_while_trip_sync_is_active(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = AsyncMock()
    redis.exists.return_value = True
    retry_due = AsyncMock()
    monkeypatch.setattr(fetch_tasks, "get_arq_pool", AsyncMock(return_value=redis))
    monkeypatch.setattr(
        fetch_tasks.BouncieHistoryRetryService,
        "run_due_retries",
        retry_due,
    )

    result = await fetch_tasks.retry_bouncie_history_windows({"job_id": "job-1"})

    assert result == {"status": "skipped", "reason": "trip_sync_active"}
    redis.set.assert_not_awaited()
    retry_due.assert_not_awaited()


@pytest.mark.asyncio
async def test_history_retry_releases_its_lock_after_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = AsyncMock()
    redis.exists.side_effect = [False, False]
    redis.set.return_value = True
    expected = {"status": "success", "retried": 2}
    retry_due = AsyncMock(return_value=expected)
    monkeypatch.setattr(fetch_tasks, "get_arq_pool", AsyncMock(return_value=redis))
    monkeypatch.setattr(
        fetch_tasks.BouncieHistoryRetryService,
        "run_due_retries",
        retry_due,
    )

    result = await fetch_tasks.retry_bouncie_history_windows({"job_id": "job-1"})

    assert result == expected
    retry_due.assert_awaited_once_with()
    redis.eval.assert_awaited_once()
