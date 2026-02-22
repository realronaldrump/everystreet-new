"""Configuration and planning helpers for trip history import."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from typing import Any

from beanie.operators import In

from config import get_bouncie_config
from core.date_utils import ensure_utc
from core.trip_source_policy import enforce_bouncie_source
from db.models import Trip, Vehicle

WINDOW_DAYS = 7
OVERLAP_HOURS = 24
STEP_HOURS = (WINDOW_DAYS * 24) - OVERLAP_HOURS
try:
    _MIN_WINDOW_HOURS = float(
        os.getenv("TRIP_HISTORY_IMPORT_MIN_WINDOW_HOURS", "0.25"),
    )
except ValueError:
    _MIN_WINDOW_HOURS = 0.25
MIN_WINDOW_HOURS = max((1.0 / 60.0), _MIN_WINDOW_HOURS)
try:
    _SPLIT_CHUNK_HOURS = int(os.getenv("TRIP_HISTORY_IMPORT_SPLIT_CHUNK_HOURS", "12"))
except ValueError:
    _SPLIT_CHUNK_HOURS = 12
SPLIT_CHUNK_HOURS = max(1, _SPLIT_CHUNK_HOURS)
try:
    _REQUEST_TIMEOUT_SECONDS = int(
        os.getenv("TRIP_HISTORY_IMPORT_REQUEST_TIMEOUT_SECONDS", "60"),
    )
except ValueError:
    _REQUEST_TIMEOUT_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = max(3, _REQUEST_TIMEOUT_SECONDS)
try:
    _DEVICE_FETCH_TIMEOUT_SECONDS = int(
        os.getenv("TRIP_HISTORY_IMPORT_DEVICE_FETCH_TIMEOUT_SECONDS", "600"),
    )
except ValueError:
    _DEVICE_FETCH_TIMEOUT_SECONDS = 600
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
    # Default start date.
    return datetime(2020, 1, 1, tzinfo=UTC)


async def resolve_import_start_dt_from_db(
    start_dt: datetime | None,
) -> datetime:
    if start_dt is not None:
        resolved = ensure_utc(start_dt)
        if resolved is not None:
            return resolved

    earliest_trip = (
        await Trip.find(enforce_bouncie_source({})).sort("startTime").first_or_none()
    )
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
    """Build Bouncie request windows (<= 7 days) with a safety overlap."""
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
        if getattr(vehicle, "vin", None):
            return f"VIN {vehicle.vin}"
    suffix = imei[-6:] if imei else "unknown"
    return f"Device {suffix}"


def resolve_import_imeis(
    authorized_imeis: list[str] | None,
    selected_imeis: list[str] | None = None,
) -> list[str]:
    """Return a de-duplicated, authorized import IMEI list."""
    normalized_authorized: list[str] = []
    seen_authorized: set[str] = set()
    for raw in authorized_imeis or []:
        imei = str(raw or "").strip()
        if not imei or imei in seen_authorized:
            continue
        seen_authorized.add(imei)
        normalized_authorized.append(imei)

    if selected_imeis is None:
        return normalized_authorized

    selected_set = {
        str(raw or "").strip() for raw in selected_imeis if str(raw or "").strip()
    }
    if not selected_set:
        return []

    return [imei for imei in normalized_authorized if imei in selected_set]


async def build_import_plan(
    *,
    start_dt: datetime,
    end_dt: datetime,
    selected_imeis: list[str] | None = None,
) -> dict[str, Any]:
    credentials = await get_bouncie_config()
    imeis = resolve_import_imeis(
        list(credentials.get("authorized_devices") or []),
        selected_imeis=selected_imeis,
    )
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


__all__ = [
    "DEVICE_FETCH_TIMEOUT_SECONDS",
    "IMPORT_DO_COVERAGE",
    "IMPORT_DO_GEOCODE",
    "MIN_WINDOW_HOURS",
    "OVERLAP_HOURS",
    "REQUEST_PAUSE_SECONDS",
    "REQUEST_TIMEOUT_SECONDS",
    "SPLIT_CHUNK_HOURS",
    "STEP_HOURS",
    "WINDOW_DAYS",
    "_DEVICE_FETCH_TIMEOUT_SECONDS",
    "_MIN_WINDOW_HOURS",
    "_REQUEST_PAUSE_SECONDS",
    "_REQUEST_TIMEOUT_SECONDS",
    "_SPLIT_CHUNK_HOURS",
    "_vehicle_label",
    "build_import_plan",
    "build_import_windows",
    "resolve_import_imeis",
    "resolve_import_start_dt",
    "resolve_import_start_dt_from_db",
]
