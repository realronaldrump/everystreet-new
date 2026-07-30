from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from db_helpers import init_mock_beanie

from core.date_utils import ensure_utc
from db.models import TripIngestIssue
from trips.services import bouncie_history_retry_service as retry_runtime
from trips.services.bouncie_history_retry_service import (
    RETRY_MARKER,
    BouncieHistoryRetryService,
)
from trips.services.bouncie_ingest_runtime import (
    FailedFetchWindow,
    WindowFetchResult,
    build_ingest_counters,
)


@pytest.fixture
async def retry_beanie_db():
    return await init_mock_beanie(TripIngestIssue)


def _failed_window() -> FailedFetchWindow:
    start = datetime(2020, 3, 1, tzinfo=UTC)
    return FailedFetchWindow(
        imei="imei-1",
        window_start=start,
        window_end=start + timedelta(seconds=1),
        error="Bouncie 500",
    )


@pytest.mark.asyncio
async def test_failed_history_window_is_queued_for_durable_retry(
    retry_beanie_db,
) -> None:
    del retry_beanie_db
    failed = _failed_window()

    queued = await BouncieHistoryRetryService.queue_failed_windows(
        [failed],
        parent_window_start=failed.window_start,
        parent_window_end=failed.window_end,
        retry_delay_seconds=0,
    )

    assert queued == 1
    issue = await TripIngestIssue.find_one(TripIngestIssue.imei == "imei-1")
    assert issue is not None
    assert issue.resolved is False
    assert issue.details is not None
    assert issue.details["retry_kind"] == RETRY_MARKER
    assert ensure_utc(issue.details["slice_start"]) == failed.window_start
    assert ensure_utc(issue.details["slice_end"]) == failed.window_end


@pytest.mark.asyncio
async def test_durable_retry_resolves_window_after_bouncie_recovers(
    retry_beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del retry_beanie_db
    failed = _failed_window()
    await BouncieHistoryRetryService.queue_failed_windows(
        [failed],
        parent_window_start=failed.window_start,
        parent_window_end=failed.window_end,
        retry_delay_seconds=0,
    )

    counters = build_ingest_counters()
    counters["inserted"] = 1
    monkeypatch.setattr(retry_runtime, "get_bouncie_config", AsyncMock(return_value={}))
    monkeypatch.setattr(retry_runtime, "get_session", AsyncMock(return_value=object()))
    monkeypatch.setattr(
        retry_runtime.BouncieOAuth,
        "get_access_token",
        AsyncMock(return_value="token"),
    )
    monkeypatch.setattr(
        retry_runtime,
        "fetch_trips_for_window_report",
        AsyncMock(return_value=WindowFetchResult()),
    )
    monkeypatch.setattr(
        retry_runtime,
        "process_bouncie_trips",
        AsyncMock(
            return_value={"processed_transaction_ids": ["tx-1"], "counters": counters},
        ),
    )
    monkeypatch.setattr(retry_runtime, "bump_trip_map_revision", AsyncMock())

    result = await BouncieHistoryRetryService.run_due_retries(limit=10)

    assert result["retried"] == 1
    assert result["resolved"] == 1
    assert result["inserted"] == 1
    issue = await TripIngestIssue.find_one(TripIngestIssue.imei == "imei-1")
    assert issue is not None
    assert issue.resolved is True
    retry_runtime.bump_trip_map_revision.assert_awaited_once()


@pytest.mark.asyncio
async def test_durable_retry_keeps_same_failed_leaf_open(
    retry_beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del retry_beanie_db
    failed = _failed_window()
    await BouncieHistoryRetryService.queue_failed_windows(
        [failed],
        parent_window_start=failed.window_start,
        parent_window_end=failed.window_end,
        retry_delay_seconds=0,
    )

    monkeypatch.setattr(retry_runtime, "get_bouncie_config", AsyncMock(return_value={}))
    monkeypatch.setattr(retry_runtime, "get_session", AsyncMock(return_value=object()))
    monkeypatch.setattr(
        retry_runtime.BouncieOAuth,
        "get_access_token",
        AsyncMock(return_value="token"),
    )
    monkeypatch.setattr(
        retry_runtime,
        "fetch_trips_for_window_report",
        AsyncMock(return_value=WindowFetchResult(failed_windows=[failed])),
    )
    monkeypatch.setattr(
        retry_runtime,
        "process_bouncie_trips",
        AsyncMock(
            return_value={
                "processed_transaction_ids": [],
                "counters": build_ingest_counters(),
            },
        ),
    )

    result = await BouncieHistoryRetryService.run_due_retries(limit=10)

    assert result["retried"] == 1
    assert result["still_failing"] == 1
    issue = await TripIngestIssue.find_one(TripIngestIssue.imei == "imei-1")
    assert issue is not None
    assert issue.resolved is False
    assert issue.occurrences == 2
