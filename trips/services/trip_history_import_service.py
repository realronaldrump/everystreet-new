"""
Trip history import (Bouncie backfill) utilities.

This module powers the Settings -> Trip Sync -> Import history wizard.

Key guarantees:
- Insert-only: existing trips are never modified.
- Transparent progress: progress is recorded into Job.metadata for live UI updates.

Implementation is split across three files:
- trip_history_import_service_config.py  — configuration and planning helpers
- trip_history_import_service_progress.py — progress context and cancellation
- trip_history_import_service_core.py    — fetch, processing, and orchestration
"""

from __future__ import annotations

from trips.services.trip_history_import_service_config import (
    DEVICE_FETCH_TIMEOUT_SECONDS,
    IMPORT_DO_COVERAGE,
    IMPORT_DO_GEOCODE,
    MIN_WINDOW_HOURS,
    OVERLAP_HOURS,
    REQUEST_PAUSE_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
    SPLIT_CHUNK_HOURS,
    STEP_HOURS,
    WINDOW_DAYS,
    build_import_plan,
    build_import_windows,
    resolve_import_start_dt,
    resolve_import_start_dt_from_db,
)
from trips.services.trip_history_import_service_core import (
    ImportRuntime,
    ImportSetup,
    run_import,
)
from trips.services.trip_history_import_service_progress import (
    ImportProgressContext,
)

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
    "ImportProgressContext",
    "ImportRuntime",
    "ImportSetup",
    "build_import_plan",
    "build_import_windows",
    "resolve_import_start_dt",
    "resolve_import_start_dt_from_db",
    "run_import",
]
