"""Durable retry loop for Bouncie history slices affected by provider 500s."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from config import get_bouncie_config
from core.clients.bouncie import BouncieClient
from core.date_utils import ensure_utc, parse_timestamp
from core.http.session import get_session
from core.trip_map_cache import bump_trip_map_revision
from core.trip_source_policy import BOUNCIE_SOURCE
from db.models import TripIngestIssue
from setup.services.bouncie_oauth import BouncieOAuth
from trips.pipeline import TripPipeline
from trips.services.bouncie_ingest_runtime import (
    FailedFetchWindow,
    fetch_trips_for_window_report,
    filter_trips_to_window,
    ingest_counters_changed_trips,
    merge_ingest_counters,
    process_bouncie_trips,
)
from trips.services.trip_history_import_service_config import (
    PROCESS_CONCURRENCY,
    resolve_history_fetch_concurrency,
)
from trips.services.trip_ingest_issue_service import TripIngestIssueService

logger = logging.getLogger(__name__)

RETRY_MARKER = "bouncie_history_window"
RETRY_DELAY_SECONDS = 5
RETRY_BATCH_SIZE = 50


def _retry_message(failed: FailedFetchWindow) -> str:
    return (
        "Bouncie fetch failed for slice "
        f"{failed.window_start.isoformat()} -> {failed.window_end.isoformat()}"
    )


def _same_window(
    issue: TripIngestIssue,
    failed: FailedFetchWindow,
) -> bool:
    details = issue.details or {}
    start = parse_timestamp(details.get("slice_start"))
    end = parse_timestamp(details.get("slice_end"))
    return (
        ensure_utc(start) == ensure_utc(failed.window_start)
        and ensure_utc(end) == ensure_utc(failed.window_end)
        and str(issue.imei or "") == failed.imei
    )


class BouncieHistoryRetryService:
    """Persist and repeatedly retry unrecoverable Bouncie history leaves."""

    @staticmethod
    async def queue_failed_windows(
        failed_windows: list[FailedFetchWindow],
        *,
        parent_window_start: datetime,
        parent_window_end: datetime,
        retry_delay_seconds: int = RETRY_DELAY_SECONDS,
    ) -> int:
        queued = 0
        now = datetime.now(UTC)
        next_retry_at = now + timedelta(seconds=max(0, retry_delay_seconds))
        for failed in failed_windows:
            issue = await TripIngestIssueService.record_issue(
                issue_type="fetch_error",
                message=_retry_message(failed),
                source=BOUNCIE_SOURCE,
                transaction_id=None,
                imei=failed.imei,
                details={
                    "retry_kind": RETRY_MARKER,
                    "imei": failed.imei,
                    "slice_start": ensure_utc(failed.window_start),
                    "slice_end": ensure_utc(failed.window_end),
                    "parent_window_start": ensure_utc(parent_window_start),
                    "parent_window_end": ensure_utc(parent_window_end),
                    "last_error": failed.error,
                    "next_retry_at": next_retry_at,
                },
            )
            if issue is None:
                continue
            details = dict(issue.details or {})
            details["retry_attempts"] = max(0, int(issue.occurrences or 1) - 1)
            issue.details = details
            await issue.save()
            queued += 1
        return queued

    @staticmethod
    async def _load_due_issues(*, limit: int) -> list[TripIngestIssue]:
        now = datetime.now(UTC)
        return (
            await TripIngestIssue.find(
                {
                    "issue_type": "fetch_error",
                    "source": BOUNCIE_SOURCE,
                    "resolved": {"$ne": True},
                    "details.retry_kind": RETRY_MARKER,
                    "$or": [
                        {"details.next_retry_at": {"$lte": now}},
                        {"details.next_retry_at": {"$exists": False}},
                    ],
                },
            )
            .sort("last_seen_at")
            .limit(max(1, limit))
            .to_list()
        )

    @staticmethod
    async def _resolve_issue(issue: TripIngestIssue) -> None:
        issue.resolved = True
        issue.resolved_at = datetime.now(UTC)
        await issue.save()

    @classmethod
    async def run_due_retries(
        cls,
        *,
        limit: int = RETRY_BATCH_SIZE,
        fetch_concurrency: int | None = None,
        process_concurrency: int = PROCESS_CONCURRENCY,
    ) -> dict[str, Any]:
        issues = await cls._load_due_issues(limit=limit)
        stats: dict[str, Any] = {
            "status": "success",
            "due": len(issues),
            "retried": 0,
            "resolved": 0,
            "still_failing": 0,
            "inserted": 0,
            "skipped_existing": 0,
            "errors": 0,
        }
        if not issues:
            return stats

        credentials = await get_bouncie_config()
        if fetch_concurrency is None:
            fetch_concurrency = resolve_history_fetch_concurrency(credentials)
        session = await get_session()
        token = await BouncieOAuth.get_access_token(session, credentials)
        if not token:
            stats["status"] = "auth_failed"
            return stats

        client = BouncieClient(session, credentials=credentials)
        pipeline = TripPipeline()
        request_slots = asyncio.Semaphore(max(1, fetch_concurrency))
        process_slots = asyncio.Semaphore(max(1, process_concurrency))
        stats_lock = asyncio.Lock()
        aggregate_counters: dict[str, int] = {}

        async def retry_issue(issue: TripIngestIssue) -> None:
            details = issue.details or {}
            imei = str(issue.imei or details.get("imei") or "").strip()
            window_start = parse_timestamp(details.get("slice_start"))
            window_end = parse_timestamp(details.get("slice_end"))
            if not imei or not window_start or not window_end:
                logger.error("Invalid Bouncie history retry issue %s", issue.id)
                await cls._resolve_issue(issue)
                async with stats_lock:
                    stats["errors"] += 1
                return

            window_start = ensure_utc(window_start) or window_start
            window_end = ensure_utc(window_end) or window_end
            try:
                fetch_result = await fetch_trips_for_window_report(
                    client,
                    imei=imei,
                    window_start=window_start,
                    window_end=window_end,
                    chunk_semaphore=request_slots,
                )
                bounded = filter_trips_to_window(
                    fetch_result.trips,
                    window_start=window_start,
                    window_end=window_end,
                )
                async with process_slots:
                    processed = await process_bouncie_trips(
                        bounded,
                        pipeline=pipeline,
                        mode="insert_only",
                        do_map_match=False,
                        do_geocode=False,
                        do_coverage=False,
                        sync_mobility=False,
                        force_rematch_all=False,
                        bump_revision=False,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failed = FailedFetchWindow(
                    imei=imei,
                    window_start=window_start,
                    window_end=window_end,
                    error=str(exc).strip() or exc.__class__.__name__,
                )
                await cls.queue_failed_windows(
                    [failed],
                    parent_window_start=window_start,
                    parent_window_end=window_end,
                )
                async with stats_lock:
                    stats["retried"] += 1
                    stats["still_failing"] += 1
                    stats["errors"] += 1
                return

            counters = dict(processed.get("counters") or {})
            failed_windows = fetch_result.failed_windows
            if failed_windows:
                await cls.queue_failed_windows(
                    failed_windows,
                    parent_window_start=window_start,
                    parent_window_end=window_end,
                )
                if not (
                    len(failed_windows) == 1 and _same_window(issue, failed_windows[0])
                ):
                    await cls._resolve_issue(issue)
            else:
                await cls._resolve_issue(issue)

            async with stats_lock:
                stats["retried"] += 1
                if failed_windows:
                    stats["still_failing"] += len(failed_windows)
                else:
                    stats["resolved"] += 1
                stats["inserted"] += int(counters.get("inserted", 0) or 0)
                stats["skipped_existing"] += int(
                    counters.get("skipped_existing", 0) or 0,
                )
                merge_ingest_counters(aggregate_counters, counters)

        await asyncio.gather(*(retry_issue(issue) for issue in issues))
        if ingest_counters_changed_trips(aggregate_counters):
            await bump_trip_map_revision()
        return stats


__all__ = [
    "RETRY_BATCH_SIZE",
    "RETRY_DELAY_SECONDS",
    "RETRY_MARKER",
    "BouncieHistoryRetryService",
]
