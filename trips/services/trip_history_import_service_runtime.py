"""Orchestration for the trip history import pipeline."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from beanie.operators import In
from admin.services.admin_service import AdminService
from config import get_bouncie_config
from core.clients.bouncie import BouncieClient
from core.date_utils import ensure_utc
from core.jobs import JobHandle
from core.http.session import get_session
from db.models import Vehicle
from setup.services.bouncie_oauth import BouncieOAuth
from trips.pipeline import TripPipeline

from trips.services.trip_history_import_service_config import (
    IMPORT_DO_COVERAGE,
    IMPORT_DO_GEOCODE,
    _vehicle_label,
    build_import_windows,
)
from trips.services.trip_history_import_service_fetch import (
    _fetch_device_window,
)
from trips.services.trip_history_import_service_processing import (
    _collect_new_trips,
    _collect_unique_window_trips,
    _load_existing_transaction_ids,
    _process_new_trips_batch,
    _record_per_device_unique_counts,
)
from trips.services.trip_history_import_service_progress import (
    ImportProgressContext,
    _load_progress_job,
    _write_cancelled_progress,
)

logger = logging.getLogger(__name__)


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


__all__ = [
    "ImportRuntime",
    "_process_import_window",
    "ImportSetup",
    "_build_import_setup",
    "_build_progress_context",
    "_authenticate_import",
    "_run_import_windows",
    "_finalize_import_success",
    "_finalize_import_failure",
    "run_import",
]
