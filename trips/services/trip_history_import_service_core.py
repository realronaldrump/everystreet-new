"""
Execution engine for trip history import.

Merges fetch, processing, and orchestration logic that was previously
spread across fetch / processing / runtime modules.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from beanie.operators import In

from config import get_bouncie_config
from core.bouncie_normalization import normalize_rest_trip_payload
from core.clients.bouncie import BouncieClient
from core.date_utils import ensure_utc, parse_timestamp
from core.http.session import get_session
from core.jobs import JobHandle
from core.trip_source_policy import BOUNCIE_SOURCE
from db.models import Trip, Vehicle
from setup.services.bouncie_oauth import BouncieOAuth
from trips.models import TripStatusProjection
from trips.pipeline import TripPipeline
from trips.services.trip_history_import_service_config import (
    DEVICE_FETCH_TIMEOUT_SECONDS,
    IMPORT_DO_COVERAGE,
    IMPORT_DO_GEOCODE,
    MIN_WINDOW_HOURS,
    REQUEST_PAUSE_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
    SPLIT_CHUNK_HOURS,
    _vehicle_label,
    build_import_windows,
    resolve_import_imeis,
)
from trips.services.trip_history_import_service_progress import (
    ImportProgressContext,
    _load_progress_job,
    _write_cancelled_progress,
)
from trips.services.trip_ingest_issue_service import TripIngestIssueService

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Runtime context — replaces the 17-parameter function signatures
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Fetch helpers
# ---------------------------------------------------------------------------


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
            raise

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
            sub_start: datetime,
            sub_end: datetime,
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
            else:
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
    """Defensively enforce window bounds on returned trips."""
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
    runtime: ImportRuntime,
    imei: str,
    window_start: datetime,
    window_end: datetime,
    window_index: int,
    devices_done_ref: dict[str, int],
    current_window: dict[str, Any],
    windows_completed: int,
) -> list[dict[str, Any]]:
    """Fetch, dedupe, and filter trips for one device-window."""
    total_devices = len(runtime.imeis)

    async with runtime.semaphore:
        devices_done = 0
        try:
            async with asyncio.timeout(DEVICE_FETCH_TIMEOUT_SECONDS):
                trips = await _fetch_trips_for_window(
                    runtime.client,
                    token=runtime.token,
                    imei=imei,
                    window_start=window_start,
                    window_end=window_end,
                    add_event=runtime.add_event,
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
            async with runtime.lock:
                runtime.counters["fetch_errors"] += 1
                if imei in runtime.per_device:
                    runtime.per_device[imei]["errors"] += 1
                    runtime.per_device[imei]["windows_completed"] += 1
                devices_done_ref["done"] += 1
                devices_done = devices_done_ref["done"]
            runtime.add_event(
                "error",
                f"Fetch failed for {imei}",
                {"error": error_text, "imei": imei, "window_index": window_index},
            )
            runtime.record_failure_reason(error_text)
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
            await _write_scan_progress(
                runtime=runtime,
                windows_completed=windows_completed,
            )
            return []

        async with runtime.lock:
            if imei in runtime.per_device:
                runtime.per_device[imei]["found_raw"] += len(trips)
                runtime.per_device[imei]["windows_completed"] += 1
            runtime.counters["found_raw"] += len(trips)
            devices_done_ref["done"] += 1
            devices_done = devices_done_ref["done"]
        runtime.add_event(
            "info",
            f"Fetched {len(trips)} trips for {imei}",
            {"window_index": window_index},
        )
        await _write_scan_progress(
            runtime=runtime,
            windows_completed=windows_completed,
        )
        if REQUEST_PAUSE_SECONDS > 0:
            await asyncio.sleep(REQUEST_PAUSE_SECONDS)
        return trips


# ---------------------------------------------------------------------------
# Processing helpers
# ---------------------------------------------------------------------------


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
        and str(getattr(doc, "source", "") or "").strip().lower() == BOUNCIE_SOURCE
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
    runtime: ImportRuntime,
    validation: dict[str, Any],
    tx: str,
    imei: str | None,
    window_index: int,
) -> None:
    runtime.counters["validation_failed"] += 1
    if isinstance(imei, str) and imei in runtime.per_device:
        runtime.per_device[imei]["validation_failed"] += 1
    reason = (
        (validation.get("processing_status") or {}).get("errors", {}).get("validation")
    )
    runtime.add_event(
        "error",
        f"Trip failed validation ({tx})",
        {
            "transactionId": tx,
            "imei": imei,
            "reason": reason,
            "window_index": window_index,
        },
    )
    runtime.record_failure_reason(str(reason))
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
    runtime: ImportRuntime,
    exc: Exception,
    tx: str,
    imei: str | None,
    window_index: int,
) -> None:
    runtime.counters["process_errors"] += 1
    if isinstance(imei, str) and imei in runtime.per_device:
        runtime.per_device[imei]["errors"] += 1
    runtime.add_event(
        "error",
        f"Failed processing trip {tx}",
        {
            "error": str(exc),
            "transactionId": tx,
            "imei": imei,
            "window_index": window_index,
        },
    )
    runtime.record_failure_reason(str(exc))
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
                runtime=runtime,
                validation=validation,
                tx=tx,
                imei=imei if isinstance(imei, str) else None,
                window_index=window_index,
            )
            processed_count += 1
            await _write_insert_progress(
                runtime=runtime,
                processed_count=processed_count,
                total=len(new_trips),
                window_index=window_index,
                windows_completed=windows_completed,
                current_window=current_window,
            )
            continue

        try:
            processing_status = validation.get("processing_status") or {}
            validated_trip_data = validation.get("processed_data")
            if not isinstance(validated_trip_data, dict):
                validated_trip_data = None
            inserted = await runtime.pipeline.process_raw_trip(
                trip,
                source="bouncie",
                do_map_match=False,
                do_geocode=runtime.do_geocode,
                do_coverage=runtime.do_coverage,
                prevalidated_data=validated_trip_data,
                prevalidated_history=processing_status.get("history"),
                prevalidated_state=processing_status.get("state"),
                sync_mobility=False,
            )
        except Exception as exc:
            await _record_process_failure(
                runtime=runtime,
                exc=exc,
                tx=tx,
                imei=imei if isinstance(imei, str) else None,
                window_index=window_index,
            )
        else:
            _update_insert_result_counters(
                inserted=bool(inserted),
                imei=imei if isinstance(imei, str) else None,
                counters=runtime.counters,
                per_device=runtime.per_device,
            )

        processed_count += 1
        await _write_insert_progress(
            runtime=runtime,
            processed_count=processed_count,
            total=len(new_trips),
            window_index=window_index,
            windows_completed=windows_completed,
            current_window=current_window,
        )

    return False


# ---------------------------------------------------------------------------
# Unified progress helpers
# ---------------------------------------------------------------------------


async def _write_scan_progress(
    *,
    runtime: ImportRuntime,
    windows_completed: int,
) -> None:
    total_all_windows = max(1, len(runtime.imeis) * runtime.windows_total)
    overall = windows_completed / total_all_windows

    await runtime.write_progress(
        status="running",
        stage="scanning",
        message=f"Scanning history (Completed {windows_completed}/{total_all_windows} vehicle-windows)",
        progress=min(99.0, overall * 100.0),
        current_window=None,
        windows_completed=windows_completed,
    )


async def _write_insert_progress(
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


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


async def _process_device_import(
    *,
    runtime: ImportRuntime,
    imei: str,
    windows: list[tuple[datetime, datetime]],
) -> None:
    devices_done_ref = {"done": 0}

    for idx, (window_start, window_end) in enumerate(windows, start=1):
        if await runtime.is_cancelled(force=False):
            return

        current_window = {
            "index": idx,
            "start_iso": window_start.isoformat(),
            "end_iso": window_end.isoformat(),
        }

        raw_trips = await _fetch_device_window(
            runtime=runtime,
            imei=imei,
            window_start=window_start,
            window_end=window_end,
            window_index=idx,
            devices_done_ref=devices_done_ref,
            current_window=current_window,
            windows_completed=sum(
                d["windows_completed"] for d in runtime.per_device.values()
            ),
        )

        if not raw_trips:
            continue

        unique_trips = _collect_unique_window_trips(
            raw_trips,
            seen_transaction_ids=runtime.seen_transaction_ids,
            counters=runtime.counters,
        )
        _record_per_device_unique_counts(unique_trips, runtime.per_device)

        if not unique_trips:
            continue

        existing_ids = await _load_existing_transaction_ids(unique_trips)
        new_trips = _collect_new_trips(
            unique_trips=unique_trips,
            existing_ids=existing_ids,
            counters=runtime.counters,
            per_device=runtime.per_device,
        )

        if await runtime.is_cancelled(force=False):
            return

        if not new_trips:
            continue

        runtime.add_event(
            "info",
            f"Inserting {len(new_trips)} new trips for {imei}",
            {"window_index": idx, "imei": imei},
        )

        cancelled = await _process_new_trips_batch(
            runtime=runtime,
            new_trips=new_trips,
            window_index=idx,
            windows_completed=sum(
                d["windows_completed"] for d in runtime.per_device.values()
            ),
            current_window=current_window,
        )
        if cancelled:
            return


async def _build_import_setup(
    *,
    start_dt: datetime,
    end_dt: datetime,
    selected_imeis: list[str] | None = None,
) -> ImportSetup:
    credentials = await get_bouncie_config()
    imeis = resolve_import_imeis(
        list(credentials.get("authorized_devices") or []),
        selected_imeis=selected_imeis,
    )
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
    device_tasks = [
        _process_device_import(
            runtime=runtime,
            imei=imei,
            windows=windows,
        )
        for imei in runtime.imeis
    ]

    await asyncio.gather(*device_tasks)

    cancelled = await progress_ctx.is_cancelled(force=True)
    windows_completed = sum(d["windows_completed"] for d in runtime.per_device.values())
    return cancelled, windows_completed


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


def _validate_import_setup(setup: ImportSetup) -> None:
    if setup.imeis:
        return
    msg = "No eligible vehicles selected for history import."
    raise RuntimeError(msg)


async def run_import(
    *,
    progress_job_id: str | None,
    start_dt: datetime,
    end_dt: datetime,
    selected_imeis: list[str] | None = None,
) -> dict[str, Any]:
    """
    Run the history import.

    This function is intended to be called from an ARQ worker.
    """
    start_dt = ensure_utc(start_dt) or start_dt
    end_dt = ensure_utc(end_dt) or end_dt
    setup = await _build_import_setup(
        start_dt=start_dt,
        end_dt=end_dt,
        selected_imeis=selected_imeis,
    )
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
        _validate_import_setup(setup)
        token = await _authenticate_import(
            session=session,
            credentials=setup.credentials,
            progress_ctx=progress_ctx,
            windows_completed=windows_completed,
        )
        pipeline = TripPipeline()
        client = BouncieClient(session)

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


__all__ = [
    "ImportRuntime",
    "ImportSetup",
    "_authenticate_import",
    "_build_import_setup",
    "_build_progress_context",
    "_collect_new_trips",
    "_collect_unique_window_trips",
    "_dedupe_trips_by_transaction_id",
    "_fetch_device_window",
    "_fetch_trips_for_window",
    "_filter_trips_to_window",
    "_finalize_import_failure",
    "_finalize_import_success",
    "_load_existing_transaction_ids",
    "_process_device_import",
    "_process_new_trips_batch",
    "_record_per_device_unique_counts",
    "_record_process_failure",
    "_record_validation_failure",
    "_run_import_windows",
    "_update_insert_result_counters",
    "_write_insert_progress",
    "_write_scan_progress",
    "run_import",
]
