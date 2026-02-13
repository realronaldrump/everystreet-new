"""
Trip history import (Bouncie backfill) utilities.

This module powers the Settings -> Trip Sync -> Import history wizard.

Key guarantees:
- Insert-only: existing trips are never modified.
- Transparent progress: progress is recorded into Job.metadata for live UI updates.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from beanie import PydanticObjectId
from beanie.operators import In

from admin.services.admin_service import AdminService
from config import get_bouncie_config
from core.bouncie_normalization import normalize_rest_trip_payload
from core.clients.bouncie import BouncieClient
from core.date_utils import ensure_utc, parse_timestamp
from core.http.session import get_session
from core.jobs import JobHandle
from db.models import Job, Trip, Vehicle
from setup.services.bouncie_oauth import BouncieOAuth
from trips.models import TripStatusProjection
from trips.pipeline import TripPipeline
from trips.services.trip_ingest_issue_service import TripIngestIssueService

logger = logging.getLogger(__name__)

WINDOW_DAYS = 7
OVERLAP_HOURS = 24
STEP_HOURS = (WINDOW_DAYS * 24) - OVERLAP_HOURS
try:
    _MIN_WINDOW_HOURS = int(os.getenv("TRIP_HISTORY_IMPORT_MIN_WINDOW_HOURS", "1"))
except ValueError:
    _MIN_WINDOW_HOURS = 1
MIN_WINDOW_HOURS = max(1, _MIN_WINDOW_HOURS)
try:
    _SPLIT_CHUNK_HOURS = int(os.getenv("TRIP_HISTORY_IMPORT_SPLIT_CHUNK_HOURS", "12"))
except ValueError:
    _SPLIT_CHUNK_HOURS = 12
SPLIT_CHUNK_HOURS = max(1, _SPLIT_CHUNK_HOURS)
try:
    _REQUEST_TIMEOUT_SECONDS = int(
        os.getenv("TRIP_HISTORY_IMPORT_REQUEST_TIMEOUT_SECONDS", "20"),
    )
except ValueError:
    _REQUEST_TIMEOUT_SECONDS = 20
REQUEST_TIMEOUT_SECONDS = max(5, _REQUEST_TIMEOUT_SECONDS)
try:
    _DEVICE_FETCH_TIMEOUT_SECONDS = int(
        os.getenv("TRIP_HISTORY_IMPORT_DEVICE_FETCH_TIMEOUT_SECONDS", "30"),
    )
except ValueError:
    _DEVICE_FETCH_TIMEOUT_SECONDS = 30
DEVICE_FETCH_TIMEOUT_SECONDS = max(10, _DEVICE_FETCH_TIMEOUT_SECONDS)
try:
    _REQUEST_PAUSE_SECONDS = float(
        os.getenv("TRIP_HISTORY_IMPORT_REQUEST_PAUSE_SECONDS", "0"),
    )
except ValueError:
    _REQUEST_PAUSE_SECONDS = 0.0
REQUEST_PAUSE_SECONDS = max(0.0, _REQUEST_PAUSE_SECONDS)

# History import is intended to be fast. Expensive downstream work should be
# deferred to dedicated jobs (e.g. geocoding/re-coverage runs), otherwise a
# multi-year backfill can take hours.
IMPORT_DO_GEOCODE = False
IMPORT_DO_COVERAGE = False


def resolve_import_start_dt(start_dt: datetime | None) -> datetime:
    """Resolve a start datetime for history import, defaulting to earliest DB trip."""
    if start_dt is not None:
        resolved = ensure_utc(start_dt)
        if resolved is not None:
            return resolved
    # Fallback: 2020-01-01
    return datetime(2020, 1, 1, tzinfo=UTC)


async def resolve_import_start_dt_from_db(
    start_dt: datetime | None,
) -> datetime:
    if start_dt is not None:
        resolved = ensure_utc(start_dt)
        if resolved is not None:
            return resolved

    earliest_trip = await Trip.find().sort("startTime").first_or_none()
    if earliest_trip and earliest_trip.startTime:
        resolved = ensure_utc(earliest_trip.startTime)
        if resolved is not None:
            return resolved

    return datetime(2020, 1, 1, tzinfo=UTC)


def build_import_windows(
    start_dt: datetime,
    end_dt: datetime,
    *,
    window_days: int = WINDOW_DAYS,
    overlap_hours: int = OVERLAP_HOURS,
) -> list[tuple[datetime, datetime]]:
    """Build Bouncie-compatible windows (<= 7 days) with a safety overlap."""
    start_dt = ensure_utc(start_dt) or start_dt
    end_dt = ensure_utc(end_dt) or end_dt

    if end_dt <= start_dt:
        return []

    step_hours = (window_days * 24) - overlap_hours
    if step_hours <= 0:
        msg = "overlap_hours must be smaller than window_days"
        raise ValueError(msg)

    window_size = timedelta(days=window_days)
    if end_dt - start_dt <= window_size:
        return [(start_dt, end_dt)]
    step = timedelta(hours=step_hours)

    windows: list[tuple[datetime, datetime]] = []
    cursor = start_dt
    while cursor < end_dt:
        window_end = min(cursor + window_size, end_dt)
        windows.append((cursor, window_end))
        if window_end >= end_dt:
            break
        cursor = cursor + step
    return windows


def _vehicle_label(vehicle: Vehicle | None, imei: str) -> str:
    if vehicle:
        name = (vehicle.custom_name or "").strip()
        if name:
            return name
        parts = [
            str(vehicle.year) if vehicle.year else None,
            vehicle.make,
            vehicle.model,
        ]
        make_model = " ".join([p for p in parts if p])
        if make_model.strip():
            return make_model.strip()
    suffix = imei[-6:] if imei else "unknown"
    return f"Device {suffix}"


async def build_import_plan(
    *,
    start_dt: datetime,
    end_dt: datetime,
) -> dict[str, Any]:
    credentials = await get_bouncie_config()
    imeis = list(credentials.get("authorized_devices") or [])
    fetch_concurrency = credentials.get("fetch_concurrency", 12)
    if not isinstance(fetch_concurrency, int) or fetch_concurrency < 1:
        fetch_concurrency = 12
    # History import tends to stress the upstream API; keep concurrency bounded.
    fetch_concurrency = min(fetch_concurrency, 4)

    vehicles = await Vehicle.find(In(Vehicle.imei, imeis)).to_list() if imeis else []
    vehicles_by_imei = {v.imei: v for v in vehicles if v and getattr(v, "imei", None)}

    windows = build_import_windows(start_dt, end_dt)
    devices = [
        {"imei": imei, "name": _vehicle_label(vehicles_by_imei.get(imei), imei)}
        for imei in imeis
    ]

    return {
        "status": "success",
        "start_iso": ensure_utc(start_dt).isoformat(),
        "end_iso": ensure_utc(end_dt).isoformat(),
        "window_days": WINDOW_DAYS,
        "overlap_hours": OVERLAP_HOURS,
        "step_hours": STEP_HOURS,
        "windows_total": len(windows),
        "estimated_requests": len(windows) * len(devices),
        "fetch_concurrency": fetch_concurrency,
        "devices": devices,
    }


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
    _min_window_hours: int = MIN_WINDOW_HOURS,
    _split_chunk_hours: int = SPLIT_CHUNK_HOURS,
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

    try:
        async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
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

        logger.warning(
            "Window failed after retries (imei=%s), splitting %s - %s into %s chunks",
            imei,
            window_start.isoformat(),
            window_end.isoformat(),
            len(sub_windows),
        )

        results: list[dict[str, Any]] = []
        for sub_start, sub_end in sub_windows:
            try:
                chunk = await _fetch_trips_for_window(
                    client,
                    token=token,
                    imei=imei,
                    window_start=sub_start,
                    window_end=sub_end,
                    _min_window_hours=_min_window_hours,
                    _split_chunk_hours=_split_chunk_hours,
                )
                results.extend(chunk)
            except Exception:
                logger.exception(
                    "Sub-window fetch failed (imei=%s, %s - %s)",
                    imei,
                    sub_start.isoformat(),
                    sub_end.isoformat(),
                )
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


def _trim_events(
    events: list[dict[str, Any]],
    *,
    limit: int = 60,
) -> list[dict[str, Any]]:
    if len(events) <= limit:
        return events
    return events[-limit:]


async def _load_progress_job(progress_job_id: str) -> Job | None:
    try:
        oid = PydanticObjectId(progress_job_id)
    except Exception:
        return None
    return await Job.get(oid)


def _record_failure_reason(
    failure_reasons: dict[str, int],
    reason: str | None,
) -> None:
    text = (reason or "").strip() or "Unknown error"
    # Keep keys stable + bounded so job metadata doesn't grow unbounded.
    text = text.replace("\n", " ").replace("\r", " ")
    if len(text) > 180:
        text = text[:177] + "..."

    if text in failure_reasons:
        failure_reasons[text] += 1
        return

    # Cap unique reasons to avoid runaway metadata growth.
    if len(failure_reasons) >= 25:
        other = "Other (see event log for details)"
        failure_reasons[other] = failure_reasons.get(other, 0) + 1
        return

    failure_reasons[text] = 1


def _add_progress_event(
    events: list[dict[str, Any]],
    level: str,
    message: str,
    data: dict[str, Any] | None = None,
) -> None:
    events.append(
        {
            "ts_iso": datetime.now(UTC).isoformat(),
            "level": level,
            "message": message,
            "data": data,
        },
    )
    if len(events) > 120:
        del events[:-120]


async def _write_cancelled_progress(
    *,
    add_event: Callable[[str, str, dict[str, Any] | None], None],
    write_progress: Callable[..., Awaitable[None]],
    windows_completed: int,
) -> dict[str, str]:
    add_event("warning", "Cancelled by user", None)
    await write_progress(
        status="cancelled",
        stage="cancelled",
        message="Cancelled",
        progress=100.0,
        current_window=None,
        windows_completed=windows_completed,
        completed_at=datetime.now(UTC),
        important=True,
    )
    return {"status": "cancelled", "message": "Cancelled"}


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
                    "Device window fetch exceeded "
                    f"{DEVICE_FETCH_TIMEOUT_SECONDS}s"
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


@dataclass
class ImportRuntime:
    client: BouncieClient
    token: str
    imeis: list[str]
    windows_total: int
    semaphore: asyncio.Semaphore
    lock: asyncio.Lock
    counters: dict[str, int]
    per_device: dict[str, dict[str, int]]
    pipeline: TripPipeline
    do_geocode: bool
    do_coverage: bool
    seen_transaction_ids: set[str]
    add_event: Callable[[str, str, dict[str, Any] | None], None]
    write_progress: Callable[..., Awaitable[None]]
    is_cancelled: Callable[..., Awaitable[bool]]
    record_failure_reason: Callable[[str | None], None]


def _collect_unique_window_trips(
    raw_trips: list[dict[str, Any]],
    *,
    seen_transaction_ids: set[str],
    counters: dict[str, int],
) -> list[dict[str, Any]]:
    unique_trips: list[dict[str, Any]] = []
    for trip in raw_trips:
        tx = trip.get("transactionId")
        if not isinstance(tx, str) or not tx:
            continue
        if tx in seen_transaction_ids:
            continue
        if not trip.get("endTime"):
            counters["skipped_missing_end_time"] += 1
            continue
        seen_transaction_ids.add(tx)
        unique_trips.append(trip)
    counters["found_unique"] += len(unique_trips)
    return unique_trips


def _record_per_device_unique_counts(
    unique_trips: list[dict[str, Any]],
    per_device: dict[str, dict[str, int]],
) -> None:
    for trip in unique_trips:
        imei = trip.get("imei")
        if isinstance(imei, str) and imei in per_device:
            per_device[imei]["found_unique"] += 1


async def _load_existing_transaction_ids(
    unique_trips: list[dict[str, Any]],
) -> set[str]:
    incoming_ids = [
        t.get("transactionId") for t in unique_trips if t.get("transactionId")
    ]
    existing_docs = (
        await Trip.find(In(Trip.transactionId, incoming_ids))
        .project(TripStatusProjection)
        .to_list()
    )
    return {
        doc.transactionId
        for doc in existing_docs
        if getattr(doc, "transactionId", None)
    }


def _collect_new_trips(
    *,
    unique_trips: list[dict[str, Any]],
    existing_ids: set[str],
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
) -> list[dict[str, Any]]:
    new_trips: list[dict[str, Any]] = []
    for trip in unique_trips:
        tx = trip.get("transactionId")
        if not isinstance(tx, str) or not tx:
            continue
        imei = trip.get("imei")
        if tx in existing_ids:
            counters["skipped_existing"] += 1
            if isinstance(imei, str) and imei in per_device:
                per_device[imei]["skipped_existing"] += 1
            continue
        counters["new_candidates"] += 1
        if isinstance(imei, str) and imei in per_device:
            per_device[imei]["new_candidates"] += 1
        new_trips.append(trip)
    return new_trips


async def _record_validation_failure(
    *,
    validation: dict[str, Any],
    tx: str,
    imei: str | None,
    window_index: int,
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
    add_event: Callable[[str, str, dict[str, Any] | None], None],
    record_failure_reason: Callable[[str | None], None],
) -> None:
    counters["validation_failed"] += 1
    if isinstance(imei, str) and imei in per_device:
        per_device[imei]["validation_failed"] += 1
    reason = (
        (validation.get("processing_status") or {}).get("errors", {}).get("validation")
    )
    add_event(
        "error",
        f"Trip failed validation ({tx})",
        {
            "transactionId": tx,
            "imei": imei,
            "reason": reason,
            "window_index": window_index,
        },
    )
    record_failure_reason(str(reason))
    await TripIngestIssueService.record_issue(
        issue_type="validation_failed",
        message=str(reason),
        source="bouncie",
        transaction_id=str(tx) if tx else None,
        imei=imei if isinstance(imei, str) else None,
        details={
            "transactionId": tx,
            "imei": imei,
            "window_index": window_index,
            "reason": reason,
        },
    )


async def _record_process_failure(
    *,
    exc: Exception,
    tx: str,
    imei: str | None,
    window_index: int,
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
    add_event: Callable[[str, str, dict[str, Any] | None], None],
    record_failure_reason: Callable[[str | None], None],
) -> None:
    counters["process_errors"] += 1
    if isinstance(imei, str) and imei in per_device:
        per_device[imei]["errors"] += 1
    add_event(
        "error",
        f"Failed processing trip {tx}",
        {
            "error": str(exc),
            "transactionId": tx,
            "imei": imei,
            "window_index": window_index,
        },
    )
    record_failure_reason(str(exc))
    await TripIngestIssueService.record_issue(
        issue_type="process_error",
        message=str(exc),
        source="bouncie",
        transaction_id=str(tx) if tx else None,
        imei=imei if isinstance(imei, str) else None,
        details={
            "transactionId": tx,
            "imei": imei,
            "window_index": window_index,
            "error": str(exc),
        },
    )


def _update_insert_result_counters(
    *,
    inserted: bool,
    imei: str | None,
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
) -> None:
    if inserted:
        counters["inserted"] += 1
        if isinstance(imei, str) and imei in per_device:
            per_device[imei]["inserted"] += 1
        return
    counters["skipped_existing"] += 1
    if isinstance(imei, str) and imei in per_device:
        per_device[imei]["skipped_existing"] += 1


async def _process_new_trips_batch(
    *,
    runtime: ImportRuntime,
    new_trips: list[dict[str, Any]],
    window_index: int,
    windows_completed: int,
    current_window: dict[str, Any],
) -> bool:
    processed_count = 0
    for trip in new_trips:
        if (
            processed_count
            and processed_count % 25 == 0
            and await runtime.is_cancelled()
        ):
            return True

        tx = str(trip.get("transactionId") or "unknown")
        imei = trip.get("imei")
        validation = await runtime.pipeline.validate_raw_trip_with_basic(trip)
        if not validation.get("success"):
            await _record_validation_failure(
                validation=validation,
                tx=tx,
                imei=imei if isinstance(imei, str) else None,
                window_index=window_index,
                counters=runtime.counters,
                per_device=runtime.per_device,
                add_event=runtime.add_event,
                record_failure_reason=runtime.record_failure_reason,
            )
            processed_count += 1
            await _write_window_insert_progress(
                runtime=runtime,
                processed_count=processed_count,
                total=len(new_trips),
                window_index=window_index,
                windows_completed=windows_completed,
                current_window=current_window,
            )
            continue

        try:
            inserted = await runtime.pipeline.process_raw_trip_insert_only(
                trip,
                source="bouncie",
                do_map_match=False,
                do_geocode=runtime.do_geocode,
                do_coverage=runtime.do_coverage,
                skip_existing_check=True,
            )
        except Exception as exc:
            await _record_process_failure(
                exc=exc,
                tx=tx,
                imei=imei if isinstance(imei, str) else None,
                window_index=window_index,
                counters=runtime.counters,
                per_device=runtime.per_device,
                add_event=runtime.add_event,
                record_failure_reason=runtime.record_failure_reason,
            )
        else:
            _update_insert_result_counters(
                inserted=bool(inserted),
                imei=imei if isinstance(imei, str) else None,
                counters=runtime.counters,
                per_device=runtime.per_device,
            )

        processed_count += 1
        await _write_window_insert_progress(
            runtime=runtime,
            processed_count=processed_count,
            total=len(new_trips),
            window_index=window_index,
            windows_completed=windows_completed,
            current_window=current_window,
        )

    return False


async def _write_window_insert_progress(
    *,
    runtime: ImportRuntime,
    processed_count: int,
    total: int,
    window_index: int,
    windows_completed: int,
    current_window: dict[str, Any],
) -> None:
    if processed_count % 5 != 0 and processed_count != total:
        return
    within = processed_count / max(1, total)
    overall = ((window_index - 1) + (0.4 + (0.6 * within))) / max(
        1,
        runtime.windows_total,
    )
    await runtime.write_progress(
        status="running",
        stage="processing",
        message=(
            f"Inserted {processed_count}/{total} trips "
            f"(window {window_index}/{runtime.windows_total})"
        ),
        progress=min(99.0, overall * 100.0),
        current_window=current_window,
        windows_completed=windows_completed,
    )


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


async def _process_import_window(
    *,
    runtime: ImportRuntime,
    idx: int,
    window_start: datetime,
    window_end: datetime,
    windows_completed: int,
) -> tuple[bool, int]:
    current_window = {
        "index": idx,
        "start_iso": window_start.isoformat(),
        "end_iso": window_end.isoformat(),
    }
    runtime.add_event(
        "info",
        f"Scanning window {idx}/{runtime.windows_total}",
        {"start": current_window["start_iso"], "end": current_window["end_iso"]},
    )
    await runtime.write_progress(
        status="running",
        stage="scanning",
        message=f"Scanning window {idx}/{runtime.windows_total}",
        progress=((idx - 1) / max(1, runtime.windows_total)) * 100.0,
        current_window=current_window,
        windows_completed=windows_completed,
    )

    devices_done_ref = {"done": 0}
    total_devices = len(runtime.imeis)
    fetch_tasks = [
        _fetch_device_window(
            client=runtime.client,
            token=runtime.token,
            imei=imei,
            window_start=window_start,
            window_end=window_end,
            window_index=idx,
            devices_done_ref=devices_done_ref,
            semaphore=runtime.semaphore,
            lock=runtime.lock,
            counters=runtime.counters,
            per_device=runtime.per_device,
            add_event=runtime.add_event,
            write_progress=runtime.write_progress,
            total_devices=total_devices,
            windows_total=runtime.windows_total,
            current_window=current_window,
            windows_completed=windows_completed,
            record_failure_reason=runtime.record_failure_reason,
        )
        for imei in runtime.imeis
    ]
    raw_lists = await asyncio.gather(*fetch_tasks)
    raw_trips = [
        trip for sub in raw_lists for trip in (sub or []) if isinstance(trip, dict)
    ]

    unique_trips = _collect_unique_window_trips(
        raw_trips,
        seen_transaction_ids=runtime.seen_transaction_ids,
        counters=runtime.counters,
    )
    _record_per_device_unique_counts(unique_trips, runtime.per_device)

    if not unique_trips:
        windows_completed += 1
        await runtime.write_progress(
            status="running",
            stage="scanning",
            message=f"No trips found (window {idx}/{runtime.windows_total})",
            progress=(windows_completed / max(1, runtime.windows_total)) * 100.0,
            current_window=current_window,
            windows_completed=windows_completed,
            important=True,
        )
        return False, windows_completed

    existing_ids = await _load_existing_transaction_ids(unique_trips)
    new_trips = _collect_new_trips(
        unique_trips=unique_trips,
        existing_ids=existing_ids,
        counters=runtime.counters,
        per_device=runtime.per_device,
    )

    if await runtime.is_cancelled(force=True):
        return True, windows_completed

    if not new_trips:
        runtime.add_event(
            "info",
            "No new trips to insert in this window",
            {"window_index": idx},
        )
        windows_completed += 1
        await runtime.write_progress(
            status="running",
            stage="processing",
            message=f"No new trips (window {idx}/{runtime.windows_total})",
            progress=(windows_completed / max(1, runtime.windows_total)) * 100.0,
            current_window=current_window,
            windows_completed=windows_completed,
            important=True,
        )
        return False, windows_completed

    runtime.add_event(
        "info",
        f"Processing {len(new_trips)} new trips",
        {"window_index": idx},
    )
    await runtime.write_progress(
        status="running",
        stage="processing",
        message=f"Inserting {len(new_trips)} new trips (window {idx}/{runtime.windows_total})",
        progress=((idx - 1) / max(1, runtime.windows_total)) * 100.0,
        current_window=current_window,
        windows_completed=windows_completed,
        important=True,
    )

    cancelled = await _process_new_trips_batch(
        runtime=runtime,
        new_trips=new_trips,
        window_index=idx,
        windows_completed=windows_completed,
        current_window=current_window,
    )
    if cancelled:
        return True, windows_completed

    windows_completed += 1
    await runtime.write_progress(
        status="running",
        stage="scanning",
        message=f"Completed window {idx}/{runtime.windows_total}",
        progress=min(99.0, (windows_completed / max(1, runtime.windows_total)) * 100.0),
        current_window=current_window,
        windows_completed=windows_completed,
        important=True,
    )
    return False, windows_completed


@dataclass
class ImportSetup:
    credentials: dict[str, Any]
    imeis: list[str]
    devices: list[dict[str, Any]]
    windows: list[tuple[datetime, datetime]]
    windows_total: int
    fetch_concurrency: int
    counters: dict[str, int]
    per_device: dict[str, dict[str, int]]


@dataclass
class ImportProgressContext:
    start_dt: datetime
    end_dt: datetime
    progress_job_id: str | None
    handle: JobHandle | None
    devices: list[dict[str, Any]]
    windows_total: int
    counters: dict[str, int]
    per_device: dict[str, dict[str, int]]
    events: list[dict[str, Any]] = field(default_factory=list)
    failure_reasons: dict[str, int] = field(default_factory=dict)
    cancel_state: dict[str, Any] = field(
        default_factory=lambda: {"checked_at": 0.0, "cancelled": False},
    )

    def record_failure_reason(self, reason: str | None) -> None:
        _record_failure_reason(self.failure_reasons, reason)

    def add_event(
        self,
        level: str,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        _add_progress_event(self.events, level, message, data)

    async def write_progress(
        self,
        *,
        status: str | None = None,
        stage: str | None = None,
        message: str | None = None,
        progress: float | None = None,
        current_window: dict[str, Any] | None = None,
        windows_completed: int | None = None,
        started_at: datetime | None = None,
        completed_at: datetime | None = None,
        error: str | None = None,
        important: bool = False,
    ) -> None:
        if not self.handle:
            return
        del important
        if windows_completed is None:
            windows_completed = 0

        meta_patch = {
            "start_iso": self.start_dt.isoformat(),
            "end_iso": self.end_dt.isoformat(),
            "window_days": WINDOW_DAYS,
            "overlap_hours": OVERLAP_HOURS,
            "step_hours": STEP_HOURS,
            "devices": self.devices,
            "windows_total": self.windows_total,
            "windows_completed": windows_completed,
            "current_window": current_window,
            "counters": dict(self.counters),
            "per_device": self.per_device,
            "events": _trim_events(list(self.events)),
            "failure_reasons": dict(self.failure_reasons),
        }
        await self.handle.update(
            status=status,
            stage=stage,
            message=message,
            progress=progress,
            metadata_patch=meta_patch,
            started_at=started_at,
            completed_at=completed_at,
            error=error,
        )

    async def is_cancelled(self, *, force: bool = False) -> bool:
        if not self.progress_job_id:
            return False
        now = time.monotonic()
        if not force and now - float(self.cancel_state.get("checked_at") or 0.0) < 1.0:
            return bool(self.cancel_state.get("cancelled"))
        self.cancel_state["checked_at"] = now
        current = await _load_progress_job(self.progress_job_id)
        cancelled = bool(current and current.status == "cancelled")
        self.cancel_state["cancelled"] = cancelled
        return cancelled


async def _build_import_setup(
    *,
    start_dt: datetime,
    end_dt: datetime,
) -> ImportSetup:
    credentials = await get_bouncie_config()
    imeis = list(credentials.get("authorized_devices") or [])
    fetch_concurrency = credentials.get("fetch_concurrency", 12)
    if not isinstance(fetch_concurrency, int) or fetch_concurrency < 1:
        fetch_concurrency = 12
    fetch_concurrency = min(fetch_concurrency, 4)

    vehicles = await Vehicle.find(In(Vehicle.imei, imeis)).to_list() if imeis else []
    vehicles_by_imei = {v.imei: v for v in vehicles if v and getattr(v, "imei", None)}
    devices = [
        {"imei": imei, "name": _vehicle_label(vehicles_by_imei.get(imei), imei)}
        for imei in imeis
    ]
    windows = build_import_windows(start_dt, end_dt)

    counters = {
        "found_raw": 0,
        "found_unique": 0,
        "skipped_existing": 0,
        "skipped_missing_end_time": 0,
        "validation_failed": 0,
        "new_candidates": 0,
        "inserted": 0,
        "fetch_errors": 0,
        "process_errors": 0,
    }
    per_device: dict[str, dict[str, int]] = {
        device["imei"]: {
            "windows_completed": 0,
            "found_raw": 0,
            "found_unique": 0,
            "skipped_existing": 0,
            "validation_failed": 0,
            "new_candidates": 0,
            "inserted": 0,
            "errors": 0,
        }
        for device in devices
    }
    return ImportSetup(
        credentials=credentials,
        imeis=imeis,
        devices=devices,
        windows=windows,
        windows_total=len(windows),
        fetch_concurrency=fetch_concurrency,
        counters=counters,
        per_device=per_device,
    )


async def _build_progress_context(
    *,
    progress_job_id: str | None,
    start_dt: datetime,
    end_dt: datetime,
    setup: ImportSetup,
) -> ImportProgressContext:
    handle: JobHandle | None = None
    if progress_job_id:
        job = await _load_progress_job(progress_job_id)
        if job:
            handle = JobHandle(job, throttle_ms=500)
    return ImportProgressContext(
        start_dt=start_dt,
        end_dt=end_dt,
        progress_job_id=progress_job_id,
        handle=handle,
        devices=setup.devices,
        windows_total=setup.windows_total,
        counters=setup.counters,
        per_device=setup.per_device,
    )


async def _authenticate_import(
    *,
    session: Any,
    credentials: dict[str, Any],
    progress_ctx: ImportProgressContext,
    windows_completed: int,
) -> str:
    token = await BouncieOAuth.get_access_token(session, credentials)
    if token:
        progress_ctx.add_event("info", "Authenticated with Bouncie")
        await progress_ctx.write_progress(
            status="running",
            stage="auth",
            message="Authenticated",
            progress=0.0,
            current_window=None,
            windows_completed=windows_completed,
            started_at=datetime.now(UTC),
            important=True,
        )
        return token

    err_msg = "Failed to obtain Bouncie access token"
    progress_ctx.add_event("error", err_msg)
    await progress_ctx.write_progress(
        status="failed",
        stage="error",
        message=err_msg,
        progress=0.0,
        current_window=None,
        windows_completed=windows_completed,
        completed_at=datetime.now(UTC),
        error=err_msg,
        important=True,
    )
    raise RuntimeError(err_msg)


async def _run_import_windows(
    *,
    runtime: ImportRuntime,
    windows: list[tuple[datetime, datetime]],
    progress_ctx: ImportProgressContext,
) -> tuple[bool, int]:
    windows_completed = 0
    for idx, (window_start, window_end) in enumerate(windows, start=1):
        if await progress_ctx.is_cancelled(force=True):
            return True, windows_completed
        cancelled, windows_completed = await _process_import_window(
            runtime=runtime,
            idx=idx,
            window_start=window_start,
            window_end=window_end,
            windows_completed=windows_completed,
        )
        if cancelled:
            return True, windows_completed
    return False, windows_completed


async def _finalize_import_success(
    *,
    progress_ctx: ImportProgressContext,
    windows_completed: int,
) -> None:
    progress_ctx.add_event("info", "Import finished")
    await progress_ctx.write_progress(
        status="completed",
        stage="completed",
        message="Import complete",
        progress=100.0,
        current_window=None,
        windows_completed=windows_completed,
        completed_at=datetime.now(UTC),
        important=True,
    )
    if progress_ctx.handle:
        await progress_ctx.handle.complete(
            message="Import complete",
            result={
                "status": "completed",
                "counters": dict(progress_ctx.counters),
                "start_iso": progress_ctx.start_dt.isoformat(),
                "end_iso": progress_ctx.end_dt.isoformat(),
                "failure_reasons": dict(progress_ctx.failure_reasons),
            },
        )


async def _finalize_import_failure(
    *,
    progress_ctx: ImportProgressContext,
    windows_completed: int,
    error: Exception,
) -> None:
    err_msg = str(error)
    logger.exception("Trip history import failed")
    progress_ctx.add_event("error", "Import failed", {"error": err_msg})
    await progress_ctx.write_progress(
        status="failed",
        stage="error",
        message=err_msg,
        progress=100.0,
        current_window=None,
        windows_completed=windows_completed,
        completed_at=datetime.now(UTC),
        error=err_msg,
        important=True,
    )


async def run_import(
    *,
    progress_job_id: str | None,
    start_dt: datetime,
    end_dt: datetime,
) -> dict[str, Any]:
    """
    Run the history import.

    This function is intended to be called from an ARQ worker.
    """
    start_dt = ensure_utc(start_dt) or start_dt
    end_dt = ensure_utc(end_dt) or end_dt
    setup = await _build_import_setup(start_dt=start_dt, end_dt=end_dt)
    progress_ctx = await _build_progress_context(
        progress_job_id=progress_job_id,
        start_dt=start_dt,
        end_dt=end_dt,
        setup=setup,
    )
    if progress_ctx.handle:
        progress_ctx.add_event(
            "info",
            "Import queued",
            {"windows_total": setup.windows_total},
        )
        await progress_ctx.write_progress(
            status="pending",
            stage="queued",
            message="Queued",
            progress=0.0,
            current_window=None,
            windows_completed=0,
            important=True,
        )

    windows_completed = 0
    session = await get_session()
    try:
        token = await _authenticate_import(
            session=session,
            credentials=setup.credentials,
            progress_ctx=progress_ctx,
            windows_completed=windows_completed,
        )
        pipeline = TripPipeline()
        client = BouncieClient(session)
        app_settings = await AdminService.get_persisted_app_settings()
        _geocode_enabled_in_settings = bool(
            getattr(app_settings, "geocodeTripsOnFetch", True),
        )
        del _geocode_enabled_in_settings

        runtime = ImportRuntime(
            client=client,
            token=token,
            imeis=setup.imeis,
            windows_total=setup.windows_total,
            semaphore=asyncio.Semaphore(setup.fetch_concurrency),
            lock=asyncio.Lock(),
            counters=setup.counters,
            per_device=setup.per_device,
            pipeline=pipeline,
            do_geocode=bool(IMPORT_DO_GEOCODE),
            do_coverage=bool(IMPORT_DO_COVERAGE),
            seen_transaction_ids=set(),
            add_event=progress_ctx.add_event,
            write_progress=progress_ctx.write_progress,
            is_cancelled=progress_ctx.is_cancelled,
            record_failure_reason=progress_ctx.record_failure_reason,
        )
        cancelled, windows_completed = await _run_import_windows(
            runtime=runtime,
            windows=setup.windows,
            progress_ctx=progress_ctx,
        )
        if cancelled:
            return await _write_cancelled_progress(
                add_event=progress_ctx.add_event,
                write_progress=progress_ctx.write_progress,
                windows_completed=windows_completed,
            )

        await _finalize_import_success(
            progress_ctx=progress_ctx,
            windows_completed=windows_completed,
        )
        return {
            "status": "success",
            "message": "Import complete",
            "counters": dict(progress_ctx.counters),
            "failure_reasons": dict(progress_ctx.failure_reasons),
            "date_range": {
                "start": progress_ctx.start_dt.isoformat(),
                "end": progress_ctx.end_dt.isoformat(),
            },
        }
    except asyncio.CancelledError:
        cancelled_via_job = await progress_ctx.is_cancelled(force=True)
        if cancelled_via_job:
            await asyncio.shield(
                _write_cancelled_progress(
                    add_event=progress_ctx.add_event,
                    write_progress=progress_ctx.write_progress,
                    windows_completed=windows_completed,
                ),
            )
        else:
            timeout_error = RuntimeError(
                "Trip history import timed out in worker before completion.",
            )
            await asyncio.shield(
                _finalize_import_failure(
                    progress_ctx=progress_ctx,
                    windows_completed=windows_completed,
                    error=timeout_error,
                ),
            )
        raise
    except Exception as exc:
        await _finalize_import_failure(
            progress_ctx=progress_ctx,
            windows_completed=windows_completed,
            error=exc,
        )
        raise
