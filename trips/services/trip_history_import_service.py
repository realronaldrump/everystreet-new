"""Trip history import (Bouncie backfill) utilities.

This module powers the Settings -> Trip Sync -> Import history wizard.

Key guarantees:
- Insert-only: existing trips are never modified.
- Transparent progress: progress is recorded into Job.metadata for live UI updates.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from beanie import PydanticObjectId
from beanie.operators import In

from admin.services.admin_service import AdminService
from config import API_BASE_URL, get_bouncie_config
from core.date_utils import ensure_utc, parse_timestamp
from core.http.retry import retry_async
from core.http.session import get_session
from core.jobs import JobHandle
from db.models import Job, Trip, Vehicle
from setup.services.bouncie_oauth import BouncieOAuth
from trips.models import TripStatusProjection
from trips.pipeline import TripPipeline

logger = logging.getLogger(__name__)

WINDOW_DAYS = 7
OVERLAP_HOURS = 24
STEP_HOURS = (WINDOW_DAYS * 24) - OVERLAP_HOURS

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
    step = timedelta(hours=step_hours)

    windows: list[tuple[datetime, datetime]] = []
    cursor = start_dt
    while cursor < end_dt:
        window_end = min(cursor + window_size, end_dt)
        windows.append((cursor, window_end))
        cursor = cursor + step
    return windows


def _vehicle_label(vehicle: Vehicle | None, imei: str) -> str:
    if vehicle:
        name = (vehicle.custom_name or "").strip()
        if name:
            return name
        parts = [str(vehicle.year) if vehicle.year else None, vehicle.make, vehicle.model]
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

    vehicles = (
        await Vehicle.find(In(Vehicle.imei, imeis)).to_list() if imeis else []
    )
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


@retry_async(max_retries=3, retry_delay=1.5)
async def _fetch_trips_for_device_strict(
    session,
    *,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime,
) -> list[dict[str, Any]]:
    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_dt.isoformat(),
        "ends-before": end_dt.isoformat(),
    }
    url = f"{API_BASE_URL}/trips"
    async with session.get(url, headers=headers, params=params) as response:
        response.raise_for_status()
        trips = await response.json()
        if not isinstance(trips, list):
            return []

        for trip in trips:
            if not isinstance(trip, dict):
                continue
            if "startTime" in trip:
                trip["startTime"] = parse_timestamp(trip["startTime"])
            if "endTime" in trip:
                trip["endTime"] = parse_timestamp(trip["endTime"])

        return trips


def _trim_events(events: list[dict[str, Any]], *, limit: int = 60) -> list[dict[str, Any]]:
    if len(events) <= limit:
        return events
    return events[-limit:]


async def _load_progress_job(progress_job_id: str) -> Job | None:
    try:
        oid = PydanticObjectId(progress_job_id)
    except Exception:
        return None
    return await Job.get(oid)


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

    handle: JobHandle | None = None
    job: Job | None = None

    if progress_job_id:
        job = await _load_progress_job(progress_job_id)
        if job:
            handle = JobHandle(job, throttle_ms=500)

    credentials = await get_bouncie_config()
    imeis = list(credentials.get("authorized_devices") or [])
    fetch_concurrency = credentials.get("fetch_concurrency", 12)
    if not isinstance(fetch_concurrency, int) or fetch_concurrency < 1:
        fetch_concurrency = 12

    vehicles = (
        await Vehicle.find(In(Vehicle.imei, imeis)).to_list() if imeis else []
    )
    vehicles_by_imei = {v.imei: v for v in vehicles if v and getattr(v, "imei", None)}

    devices = [
        {"imei": imei, "name": _vehicle_label(vehicles_by_imei.get(imei), imei)}
        for imei in imeis
    ]

    windows = build_import_windows(start_dt, end_dt)
    windows_total = len(windows)

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
        d["imei"]: {
            "windows_completed": 0,
            "found_raw": 0,
            "found_unique": 0,
            "skipped_existing": 0,
            "validation_failed": 0,
            "new_candidates": 0,
            "inserted": 0,
            "errors": 0,
        }
        for d in devices
    }

    events: list[dict[str, Any]] = []
    failure_reasons: dict[str, int] = {}

    def record_failure_reason(reason: str | None) -> None:
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

    def add_event(level: str, message: str, data: dict[str, Any] | None = None) -> None:
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

    async def write_progress(
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
        if not handle:
            return
        if windows_completed is None:
            windows_completed = 0
        meta_patch = {
            "start_iso": start_dt.isoformat(),
            "end_iso": end_dt.isoformat(),
            "window_days": WINDOW_DAYS,
            "overlap_hours": OVERLAP_HOURS,
            "step_hours": STEP_HOURS,
            "devices": devices,
            "windows_total": windows_total,
            "windows_completed": windows_completed,
            "current_window": current_window,
            "counters": dict(counters),
            "per_device": per_device,
            "events": _trim_events(list(events)),
            "failure_reasons": dict(failure_reasons),
        }
        await handle.update(
            status=status,
            stage=stage,
            message=message,
            progress=progress,
            metadata_patch=meta_patch,
            started_at=started_at,
            completed_at=completed_at,
            error=error,
        )

    cancel_state: dict[str, Any] = {"checked_at": 0.0, "cancelled": False}

    async def is_cancelled(*, force: bool = False) -> bool:
        if not progress_job_id:
            return False
        now = time.monotonic()
        if not force and now - float(cancel_state.get("checked_at") or 0.0) < 1.0:
            return bool(cancel_state.get("cancelled"))
        cancel_state["checked_at"] = now
        current = await _load_progress_job(progress_job_id)
        cancelled = bool(current and current.status == "cancelled")
        cancel_state["cancelled"] = cancelled
        return cancelled

    if handle:
        add_event("info", "Import queued", {"windows_total": windows_total})
        await write_progress(
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
        token = await BouncieOAuth.get_access_token(session, credentials)
        if not token:
            err_msg = "Failed to obtain Bouncie access token"
            add_event("error", err_msg)
            await write_progress(
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

        add_event("info", "Authenticated with Bouncie")
        await write_progress(
            status="running",
            stage="auth",
            message="Authenticated",
            progress=0.0,
            current_window=None,
            windows_completed=windows_completed,
            started_at=datetime.now(UTC),
            important=True,
        )

        pipeline = TripPipeline()
        app_settings = await AdminService.get_persisted_app_settings()
        # Keep reading settings for parity with other ingest paths, but history
        # import deliberately skips expensive per-trip side effects.
        _geocode_enabled_in_settings = bool(
            getattr(app_settings, "geocodeTripsOnFetch", True),
        )
        do_geocode = bool(IMPORT_DO_GEOCODE)
        do_coverage = bool(IMPORT_DO_COVERAGE)
        seen_transaction_ids: set[str] = set()

        semaphore = asyncio.Semaphore(fetch_concurrency)
        lock = asyncio.Lock()

        async def fetch_device_window(
            imei: str,
            window_start: datetime,
            window_end: datetime,
            *,
            window_index: int,
            devices_done_ref: dict[str, int],
        ) -> list[dict[str, Any]]:
            async with semaphore:
                try:
                    trips = await _fetch_trips_for_device_strict(
                        session,
                        token=token,
                        imei=imei,
                        start_dt=window_start,
                        end_dt=window_end,
                    )
                except Exception as exc:
                    async with lock:
                        counters["fetch_errors"] += 1
                        if imei in per_device:
                            per_device[imei]["errors"] += 1
                            per_device[imei]["windows_completed"] += 1
                        devices_done_ref["done"] += 1
                    add_event(
                        "error",
                        f"Fetch failed for {imei}",
                        {"error": str(exc), "imei": imei, "window_index": window_index},
                    )
                    record_failure_reason(str(exc))
                    return []

                async with lock:
                    if imei in per_device:
                        per_device[imei]["found_raw"] += len(trips)
                        per_device[imei]["windows_completed"] += 1
                    counters["found_raw"] += len(trips)
                    devices_done_ref["done"] += 1
                add_event(
                    "info",
                    f"Fetched {len(trips)} trips for {imei}",
                    {"window_index": window_index},
                )
                return trips

        for idx, (window_start, window_end) in enumerate(windows, start=1):
            if await is_cancelled(force=True):
                add_event("warning", "Cancelled by user")
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

            current_window = {
                "index": idx,
                "start_iso": window_start.isoformat(),
                "end_iso": window_end.isoformat(),
            }

            add_event(
                "info",
                f"Scanning window {idx}/{windows_total}",
                {"start": current_window["start_iso"], "end": current_window["end_iso"]},
            )

            devices_done_ref = {"done": 0}
            await write_progress(
                status="running",
                stage="scanning",
                message=f"Scanning window {idx}/{windows_total}",
                progress=((idx - 1) / max(1, windows_total)) * 100.0,
                current_window=current_window,
                windows_completed=windows_completed,
            )

            fetch_tasks = [
                fetch_device_window(
                    imei,
                    window_start,
                    window_end,
                    window_index=idx,
                    devices_done_ref=devices_done_ref,
                )
                for imei in imeis
            ]
            raw_lists = await asyncio.gather(*fetch_tasks)
            raw_trips = [t for sub in raw_lists for t in (sub or []) if isinstance(t, dict)]

            # Deduplicate within the entire import run, and enforce required fields.
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

            # Track per-device unique counts before DB filtering.
            for trip in unique_trips:
                imei = trip.get("imei")
                if isinstance(imei, str) and imei in per_device:
                    per_device[imei]["found_unique"] += 1

            if not unique_trips:
                windows_completed += 1
                await write_progress(
                    status="running",
                    stage="scanning",
                    message=f"No trips found (window {idx}/{windows_total})",
                    progress=(windows_completed / max(1, windows_total)) * 100.0,
                    current_window=current_window,
                    windows_completed=windows_completed,
                    important=True,
                )
                continue

            incoming_ids = [
                t.get("transactionId") for t in unique_trips if t.get("transactionId")
            ]
            existing_docs = (
                await Trip.find(In(Trip.transactionId, incoming_ids))
                .project(TripStatusProjection)
                .to_list()
            )
            existing_ids = {
                d.transactionId for d in existing_docs if getattr(d, "transactionId", None)
            }

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

            if await is_cancelled(force=True):
                add_event("warning", "Cancelled by user")
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

            if not new_trips:
                add_event(
                    "info",
                    "No new trips to insert in this window",
                    {"window_index": idx},
                )
                windows_completed += 1
                await write_progress(
                    status="running",
                    stage="processing",
                    message=f"No new trips (window {idx}/{windows_total})",
                    progress=(windows_completed / max(1, windows_total)) * 100.0,
                    current_window=current_window,
                    windows_completed=windows_completed,
                    important=True,
                )
                continue

            add_event("info", f"Processing {len(new_trips)} new trips", {"window_index": idx})
            await write_progress(
                status="running",
                stage="processing",
                message=f"Inserting {len(new_trips)} new trips (window {idx}/{windows_total})",
                progress=((idx - 1) / max(1, windows_total)) * 100.0,
                current_window=current_window,
                windows_completed=windows_completed,
                important=True,
            )

            processed_count = 0
            for trip in new_trips:
                # Avoid hot-looping DB reads; check roughly once per second.
                if processed_count and processed_count % 25 == 0 and await is_cancelled():
                    add_event("warning", "Cancelled by user")
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

                tx = trip.get("transactionId", "unknown")
                imei = trip.get("imei")

                validation = await pipeline.validate_raw_trip_with_basic(trip)
                if not validation.get("success"):
                    counters["validation_failed"] += 1
                    if isinstance(imei, str) and imei in per_device:
                        per_device[imei]["validation_failed"] += 1
                    reason = (
                        (validation.get("processing_status") or {})
                        .get("errors", {})
                        .get("validation")
                    )
                    add_event(
                        "error",
                        f"Trip failed validation ({tx})",
                        {
                            "transactionId": tx,
                            "imei": imei,
                            "reason": reason,
                            "window_index": idx,
                        },
                    )
                    record_failure_reason(str(reason))
                    processed_count += 1
                    if processed_count % 5 == 0 or processed_count == len(new_trips):
                        within = processed_count / max(1, len(new_trips))
                        overall = ((idx - 1) + (0.4 + (0.6 * within))) / max(
                            1,
                            windows_total,
                        )
                        await write_progress(
                            status="running",
                            stage="processing",
                            message=(
                                f"Processed {processed_count}/{len(new_trips)} trips "
                                f"(window {idx}/{windows_total})"
                            ),
                            progress=min(99.0, overall * 100.0),
                            current_window=current_window,
                            windows_completed=windows_completed,
                        )
                    continue

                try:
                    inserted = await pipeline.process_raw_trip_insert_only(
                        trip,
                        source="bouncie",
                        do_map_match=False,
                        do_geocode=do_geocode,
                        do_coverage=do_coverage,
                        skip_existing_check=True,
                    )
                except Exception as exc:
                    counters["process_errors"] += 1
                    if isinstance(imei, str) and imei in per_device:
                        per_device[imei]["errors"] += 1
                    add_event(
                        "error",
                        f"Failed processing trip {tx}",
                        {"error": str(exc), "transactionId": tx, "imei": imei, "window_index": idx},
                    )
                    record_failure_reason(str(exc))
                else:
                    if inserted:
                        counters["inserted"] += 1
                        if isinstance(imei, str) and imei in per_device:
                            per_device[imei]["inserted"] += 1
                    else:
                        # Insert-only skip (already exists / concurrent insert)
                        counters["skipped_existing"] += 1
                        if isinstance(imei, str) and imei in per_device:
                            per_device[imei]["skipped_existing"] += 1

                processed_count += 1
                if processed_count % 5 == 0 or processed_count == len(new_trips):
                    within = processed_count / max(1, len(new_trips))
                    overall = ((idx - 1) + (0.4 + (0.6 * within))) / max(1, windows_total)
                    await write_progress(
                        status="running",
                        stage="processing",
                        message=(
                            f"Inserted {processed_count}/{len(new_trips)} trips "
                            f"(window {idx}/{windows_total})"
                        ),
                        progress=min(99.0, overall * 100.0),
                        current_window=current_window,
                        windows_completed=windows_completed,
                    )

            windows_completed += 1
            await write_progress(
                status="running",
                stage="scanning",
                message=f"Completed window {idx}/{windows_total}",
                progress=min(99.0, (windows_completed / max(1, windows_total)) * 100.0),
                current_window=current_window,
                windows_completed=windows_completed,
                important=True,
            )

        add_event("info", "Import finished")
        await write_progress(
            status="completed",
            stage="completed",
            message="Import complete",
            progress=100.0,
            current_window=None,
            windows_completed=windows_completed,
            completed_at=datetime.now(UTC),
            important=True,
        )

        if handle:
            await handle.complete(
                message="Import complete",
                result={
                    "status": "completed",
                    "counters": dict(counters),
                    "start_iso": start_dt.isoformat(),
                    "end_iso": end_dt.isoformat(),
                    "failure_reasons": dict(failure_reasons),
                },
            )

        return {
            "status": "success",
            "message": "Import complete",
            "counters": dict(counters),
            "failure_reasons": dict(failure_reasons),
            "date_range": {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        }
    except Exception as exc:
        err_msg = str(exc)
        logger.exception("Trip history import failed")
        add_event("error", "Import failed", {"error": err_msg})
        await write_progress(
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
        raise
