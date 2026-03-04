"""
Execution engine for trip history import.

This module keeps history-import orchestration/progress concerns, while
delegating all Bouncie fetch/normalize/ingest execution to the shared runtime
in ``trips.services.bouncie_ingest_runtime``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from beanie.operators import In

from config import get_bouncie_config
from core.date_utils import ensure_utc
from core.http.session import get_session
from core.jobs import JobHandle
from db.models import Vehicle
from setup.services.bouncie_oauth import BouncieOAuth
from trips.pipeline import TripPipeline
from trips.services.bouncie_ingest_runtime import (
    build_ingest_counters,
    fetch_trips_for_window as fetch_trips_for_window_runtime,
    filter_trips_to_window as filter_trips_to_window_runtime,
    merge_ingest_counters,
    process_bouncie_trips as process_bouncie_trips_runtime,
)
from trips.services.trip_history_import_service_config import (
    IMPORT_DO_COVERAGE,
    IMPORT_DO_GEOCODE,
    _vehicle_label,
    build_import_windows,
    resolve_import_imeis,
)
from trips.services.trip_history_import_service_progress import (
    ImportProgressContext,
    _load_progress_job,
    _write_cancelled_progress,
)

logger = logging.getLogger(__name__)


@dataclass
class ImportRuntime:
    client: Any
    imeis: list[str]
    windows_total: int
    semaphore: asyncio.Semaphore
    lock: asyncio.Lock
    counters: dict[str, int]
    per_device: dict[str, dict[str, int]]
    pipeline: TripPipeline
    do_geocode: bool
    do_coverage: bool
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


def _build_per_device_counters() -> dict[str, int]:
    return {
        "windows_completed": 0,
        "found_raw": 0,
        "found_unique": 0,
        "skipped_existing": 0,
        "skipped_conflicting_source": 0,
        "validation_failed": 0,
        "inserted": 0,
        "updated": 0,
        "fetch_errors": 0,
        "process_errors": 0,
        "errors": 0,
    }


def _merge_per_device_counters(
    device_counters: dict[str, int],
    delta: dict[str, int],
) -> None:
    for key in (
        "found_raw",
        "found_unique",
        "skipped_existing",
        "skipped_conflicting_source",
        "validation_failed",
        "inserted",
        "updated",
        "fetch_errors",
        "process_errors",
    ):
        device_counters[key] = int(device_counters.get(key, 0) or 0) + int(
            delta.get(key, 0) or 0,
        )
    device_counters["errors"] = int(device_counters.get("fetch_errors", 0) or 0) + int(
        device_counters.get("process_errors", 0) or 0,
    )


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
    # History import can stress upstream APIs; keep bounded.
    fetch_concurrency = min(fetch_concurrency, 4)

    vehicles = await Vehicle.find(In(Vehicle.imei, imeis)).to_list() if imeis else []
    vehicles_by_imei = {v.imei: v for v in vehicles if v and getattr(v, "imei", None)}
    devices = [
        {"imei": imei, "name": _vehicle_label(vehicles_by_imei.get(imei), imei)}
        for imei in imeis
    ]
    windows = build_import_windows(start_dt, end_dt)

    counters = build_ingest_counters()
    per_device = {
        device["imei"]: _build_per_device_counters()
        for device in devices
        if device.get("imei")
    }

    return ImportSetup(
        credentials=credentials,
        imeis=imeis,
        devices=devices,
        windows=windows,
        windows_total=(len(windows) * len(imeis)) if imeis else 0,
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
    units = [
        (imei, window_index, window_start, window_end)
        for imei in runtime.imeis
        for window_index, (window_start, window_end) in enumerate(windows, start=1)
    ]
    total_vehicle_windows = max(1, runtime.windows_total or len(units))
    windows_completed = 0

    async def process_unit(
        imei: str,
        window_index: int,
        window_start: datetime,
        window_end: datetime,
    ) -> None:
        nonlocal windows_completed
        if await runtime.is_cancelled(force=False):
            return

        current_window = {
            "index": window_index,
            "imei": imei,
            "start_iso": window_start.isoformat(),
            "end_iso": window_end.isoformat(),
        }
        delta = build_ingest_counters()

        try:
            async with runtime.semaphore:
                if await runtime.is_cancelled(force=False):
                    return

                raw_trips = await fetch_trips_for_window_runtime(
                    runtime.client,
                    imei=imei,
                    window_start=window_start,
                    window_end=window_end,
                    add_event=runtime.add_event,
                )
                bounded_trips = filter_trips_to_window_runtime(
                    raw_trips,
                    window_start=window_start,
                    window_end=window_end,
                )
                result = await process_bouncie_trips_runtime(
                    bounded_trips,
                    pipeline=runtime.pipeline,
                    mode="insert_only",
                    do_map_match=False,
                    do_geocode=runtime.do_geocode,
                    do_coverage=runtime.do_coverage,
                    sync_mobility=False,
                    force_rematch_all=False,
                )
                delta = dict(result.get("counters", {}))
                runtime.add_event(
                    "info",
                    f"Window processed for {imei}",
                    {
                        "imei": imei,
                        "window_index": window_index,
                        "processed": len(result.get("processed_transaction_ids", [])),
                    },
                )
        except Exception as exc:
            logger.exception(
                "History import window failed (imei=%s, %s - %s)",
                imei,
                window_start.isoformat(),
                window_end.isoformat(),
            )
            delta["fetch_errors"] = int(delta.get("fetch_errors", 0) or 0) + 1
            runtime.add_event(
                "error",
                f"Window failed for {imei}",
                {
                    "imei": imei,
                    "window_index": window_index,
                    "start_iso": window_start.isoformat(),
                    "end_iso": window_end.isoformat(),
                    "error": str(exc),
                },
            )
            runtime.record_failure_reason(str(exc))
        finally:
            async with runtime.lock:
                merge_ingest_counters(runtime.counters, delta)
                per_device = runtime.per_device.get(imei)
                if per_device is not None:
                    _merge_per_device_counters(per_device, delta)
                    per_device["windows_completed"] = (
                        int(
                            per_device.get("windows_completed", 0) or 0,
                        )
                        + 1
                    )

                windows_completed += 1
                progress = min(
                    99.0,
                    (windows_completed / total_vehicle_windows) * 100.0,
                )

            await runtime.write_progress(
                status="running",
                stage="processing",
                message=(
                    f"Processed {windows_completed}/{total_vehicle_windows} "
                    "vehicle-windows"
                ),
                progress=progress,
                current_window=current_window,
                windows_completed=windows_completed,
            )

    await asyncio.gather(*(process_unit(*unit) for unit in units))

    cancelled = await progress_ctx.is_cancelled(force=True)
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
        await _authenticate_import(
            session=session,
            credentials=setup.credentials,
            progress_ctx=progress_ctx,
            windows_completed=windows_completed,
        )

        from core.clients.bouncie import BouncieClient

        runtime = ImportRuntime(
            client=BouncieClient(session, credentials=setup.credentials),
            imeis=setup.imeis,
            windows_total=setup.windows_total,
            semaphore=asyncio.Semaphore(setup.fetch_concurrency),
            lock=asyncio.Lock(),
            counters=setup.counters,
            per_device=setup.per_device,
            pipeline=TripPipeline(),
            do_geocode=bool(IMPORT_DO_GEOCODE),
            do_coverage=bool(IMPORT_DO_COVERAGE),
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
    "_finalize_import_failure",
    "_finalize_import_success",
    "_run_import_windows",
    "run_import",
]
