"""Fetch and chunking helpers for trip history import."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any

from core.bouncie_normalization import normalize_rest_trip_payload
from core.clients.bouncie import BouncieClient
from core.date_utils import ensure_utc, parse_timestamp
from trips.services.trip_history_import_service_config import (
    DEVICE_FETCH_TIMEOUT_SECONDS,
    MIN_WINDOW_HOURS,
    REQUEST_PAUSE_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
    SPLIT_CHUNK_HOURS,
)
from trips.services.trip_ingest_issue_service import TripIngestIssueService

logger = logging.getLogger(__name__)


def _dedupe_trips_by_transaction_id(
    trips: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Deduplicate trips in-memory, preserving the first occurrence."""
    by_id: dict[str, dict[str, Any]] = {}
    for trip in trips:
        if not isinstance(trip, dict):
            continue
        tx = trip.get("transactionId")
        if isinstance(tx, str) and tx and tx not in by_id:
            by_id[tx] = trip
    return list(by_id.values())


async def _fetch_trips_for_window(
    client: BouncieClient,
    *,
    token: str,
    imei: str,
    window_start: datetime,
    window_end: datetime,
    _min_window_hours: float = MIN_WINDOW_HOURS,
    _split_chunk_hours: int = SPLIT_CHUNK_HOURS,
    add_event: Callable[[str, str, dict[str, Any] | None], None] | None = None,
    chunk_semaphore: asyncio.Semaphore | None = None,
) -> list[dict[str, Any]]:
    """
    Fetch trips for a window using BouncieClient (geojson, with retry).

    If a window fails after client-level retry, split it into smaller chunks
    (bounded by ``_split_chunk_hours``) and retry sub-windows down to
    ``_min_window_hours``. This avoids very long stalls on bad partitions.
    """
    # Clamp to strictly under 7 days for Bouncie's documented limit.
    max_span = timedelta(days=7) - timedelta(seconds=2)
    query_start = (ensure_utc(window_start) or window_start) - timedelta(seconds=1)
    query_end = ensure_utc(window_end) or window_end
    if query_end - query_start > max_span:
        query_end = query_start + max_span

    if chunk_semaphore is None:
        chunk_semaphore = asyncio.Semaphore(15)

    try:
        async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
            async with chunk_semaphore:
                raw_trips = await client.fetch_trips_for_device_resilient(
                    token,
                    imei,
                    query_start,
                    query_end,
                )
        return [
            normalize_rest_trip_payload(t) for t in raw_trips if isinstance(t, dict)
        ]
    except Exception as exc:
        if isinstance(exc, TimeoutError):
            logger.warning(
                "Timed out fetching window for imei=%s after %ss (%s - %s)",
                imei,
                REQUEST_TIMEOUT_SECONDS,
                window_start.isoformat(),
                window_end.isoformat(),
            )
        span = window_end - window_start
        if span <= timedelta(hours=_min_window_hours):
            raise  # Cannot split further — propagate to caller

        split_size = min(
            timedelta(hours=max(_min_window_hours, _split_chunk_hours)),
            span / 2,
        )
        if split_size <= timedelta(0):
            raise

        sub_windows: list[tuple[datetime, datetime]] = []
        cursor = window_start
        while cursor < window_end:
            sub_end = min(cursor + split_size, window_end)
            if sub_end <= cursor:
                break
            sub_windows.append((cursor, sub_end))
            cursor = sub_end

        if len(sub_windows) < 2:
            midpoint = window_start + span / 2
            sub_windows = [
                (window_start, midpoint),
                (midpoint, window_end),
            ]

        msg = f"Window failed after retries (imei={imei}), splitting {window_start.isoformat()} - {window_end.isoformat()} into {len(sub_windows)} chunks"
        logger.warning(msg)
        if add_event:
            add_event(
                "warning",
                f"Splitting failing window for {imei} into {len(sub_windows)} chunks",
                {"imei": imei, "chunks": len(sub_windows)},
            )

        async def fetch_sub(
            sub_start: datetime, sub_end: datetime
        ) -> list[dict[str, Any]]:
            try:
                chunk = await _fetch_trips_for_window(
                    client,
                    token=token,
                    imei=imei,
                    window_start=sub_start,
                    window_end=sub_end,
                    _min_window_hours=_min_window_hours,
                    _split_chunk_hours=_split_chunk_hours,
                    add_event=add_event,
                    chunk_semaphore=chunk_semaphore,
                )
                if add_event and chunk:
                    add_event(
                        "info",
                        f"Fetched {len(chunk)} trips from sub-chunk",
                        {
                            "imei": imei,
                            "start": sub_start.isoformat(),
                            "end": sub_end.isoformat(),
                        },
                    )
                return chunk
            except Exception:
                logger.exception(
                    "Sub-window fetch failed (imei=%s, %s - %s)",
                    imei,
                    sub_start.isoformat(),
                    sub_end.isoformat(),
                )
                if add_event:
                    add_event(
                        "error",
                        f"Sub-window fetch failed for {imei}",
                        {"start": sub_start.isoformat(), "end": sub_end.isoformat()},
                    )
                return []

        tasks = [fetch_sub(sub_start, sub_end) for sub_start, sub_end in sub_windows]
        results_lists = await asyncio.gather(*tasks)

        results: list[dict[str, Any]] = []
        for chunk in results_lists:
            results.extend(chunk)

        return results


def _filter_trips_to_window(
    trips: list[dict[str, Any]],
    *,
    window_start: datetime,
    window_end: datetime,
) -> list[dict[str, Any]]:
    """
    Defensively enforce window bounds.

    If the upstream API returns trips outside the requested window (or
    ignores filters), ensure we only process trips whose
    [startTime,endTime] fit inside the window.
    """

    start = ensure_utc(window_start) or window_start
    end = ensure_utc(window_end) or window_end
    kept: list[dict[str, Any]] = []
    for trip in trips:
        if not isinstance(trip, dict):
            continue
        st = trip.get("startTime")
        et = trip.get("endTime")
        if not isinstance(st, datetime):
            st = parse_timestamp(st)
        if not isinstance(et, datetime):
            et = parse_timestamp(et)
        if not st or not et:
            continue
        st = ensure_utc(st) or st
        et = ensure_utc(et) or et
        if st < start:
            continue
        if et > end:
            continue
        kept.append(trip)
    return kept


async def _fetch_device_window(
    *,
    client: BouncieClient,
    token: str,
    imei: str,
    window_start: datetime,
    window_end: datetime,
    window_index: int,
    semaphore: asyncio.Semaphore,
    lock: asyncio.Lock,
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
    devices_done_ref: dict[str, int],
    total_devices: int,
    windows_total: int,
    current_window: dict[str, Any],
    windows_completed: int,
    add_event: Callable[[str, str, dict[str, Any] | None], None],
    write_progress: Callable[..., Awaitable[None]],
    record_failure_reason: Callable[[str | None], None],
) -> list[dict[str, Any]]:
    async with semaphore:
        devices_done = 0
        try:
            async with asyncio.timeout(DEVICE_FETCH_TIMEOUT_SECONDS):
                trips = await _fetch_trips_for_window(
                    client,
                    token=token,
                    imei=imei,
                    window_start=window_start,
                    window_end=window_end,
                    add_event=add_event,
                )
            trips = _dedupe_trips_by_transaction_id(trips)
            before_count = len(trips)
            trips = _filter_trips_to_window(
                trips,
                window_start=window_start,
                window_end=window_end,
            )
            after_count = len(trips)
            if after_count != before_count:
                logger.info(
                    "Filtered %s/%s trips outside window (imei=%s, window_index=%s)",
                    before_count - after_count,
                    before_count,
                    imei,
                    window_index,
                )
        except Exception as exc:
            error_text = str(exc) or exc.__class__.__name__
            if isinstance(exc, TimeoutError):
                error_text = (
                    f"Device window fetch exceeded {DEVICE_FETCH_TIMEOUT_SECONDS}s"
                )
            async with lock:
                counters["fetch_errors"] += 1
                if imei in per_device:
                    per_device[imei]["errors"] += 1
                    per_device[imei]["windows_completed"] += 1
                devices_done_ref["done"] += 1
                devices_done = devices_done_ref["done"]
            add_event(
                "error",
                f"Fetch failed for {imei}",
                {"error": error_text, "imei": imei, "window_index": window_index},
            )
            record_failure_reason(error_text)
            await TripIngestIssueService.record_issue(
                issue_type="fetch_error",
                message=error_text,
                source="bouncie",
                imei=imei,
                details={
                    "imei": imei,
                    "window_index": window_index,
                    "window_start": window_start.isoformat(),
                    "window_end": window_end.isoformat(),
                },
            )
            await _write_window_scan_progress(
                write_progress=write_progress,
                devices_done=devices_done,
                total_devices=total_devices,
                window_index=window_index,
                windows_total=windows_total,
                current_window=current_window,
                windows_completed=windows_completed,
            )
            return []

        async with lock:
            if imei in per_device:
                per_device[imei]["found_raw"] += len(trips)
                per_device[imei]["windows_completed"] += 1
            counters["found_raw"] += len(trips)
            devices_done_ref["done"] += 1
            devices_done = devices_done_ref["done"]
        add_event(
            "info",
            f"Fetched {len(trips)} trips for {imei}",
            {"window_index": window_index},
        )
        await _write_window_scan_progress(
            write_progress=write_progress,
            devices_done=devices_done,
            total_devices=total_devices,
            window_index=window_index,
            windows_total=windows_total,
            current_window=current_window,
            windows_completed=windows_completed,
        )
        if REQUEST_PAUSE_SECONDS > 0:
            await asyncio.sleep(REQUEST_PAUSE_SECONDS)
        return trips


async def _write_window_scan_progress(
    *,
    write_progress: Callable[..., Awaitable[None]],
    devices_done: int,
    total_devices: int,
    window_index: int,
    windows_total: int,
    current_window: dict[str, Any],
    windows_completed: int,
) -> None:
    if devices_done <= 0:
        return
    within = devices_done / max(1, total_devices)
    overall = ((window_index - 1) + (0.35 * within)) / max(1, windows_total)
    await write_progress(
        status="running",
        stage="scanning",
        message=(
            f"Fetched devices {devices_done}/{total_devices} "
            f"(window {window_index}/{windows_total})"
        ),
        progress=min(99.0, overall * 100.0),
        current_window=current_window,
        windows_completed=windows_completed,
    )


__all__ = [
    "_dedupe_trips_by_transaction_id",
    "_fetch_device_window",
    "_fetch_trips_for_window",
    "_filter_trips_to_window",
    "_write_window_scan_progress",
]
