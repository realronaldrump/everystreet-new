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

import logging

from trips.services.trip_history_import_service_config import (
    _DEVICE_FETCH_TIMEOUT_SECONDS,
    _MIN_WINDOW_HOURS,
    _REQUEST_PAUSE_SECONDS,
    _REQUEST_TIMEOUT_SECONDS,
    _SPLIT_CHUNK_HOURS,
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
    _vehicle_label,
    build_import_plan,
    build_import_windows,
    resolve_import_start_dt,
    resolve_import_start_dt_from_db,
)
from trips.services.trip_history_import_service_core import (
    ImportRuntime,
    ImportSetup,
    _authenticate_import,
    _build_import_setup,
    _build_progress_context,
    _collect_new_trips,
    _collect_unique_window_trips,
    _dedupe_trips_by_transaction_id,
    _fetch_device_window,
    _fetch_trips_for_window,
    _filter_trips_to_window,
    _finalize_import_failure,
    _finalize_import_success,
    _load_existing_transaction_ids,
    _process_new_trips_batch,
    _record_per_device_unique_counts,
    _record_process_failure,
    _record_validation_failure,
    _run_import_windows,
    _update_insert_result_counters,
    _write_insert_progress,
    _write_scan_progress,
    run_import,
)
from trips.services.trip_history_import_service_progress import (
    ImportProgressContext,
    _add_progress_event,
    _load_progress_job,
    _record_failure_reason,
    _trim_events,
    _write_cancelled_progress,
)

# Back-compat aliases for renamed progress helpers
_write_window_scan_progress = _write_scan_progress
_write_window_insert_progress = _write_insert_progress

logger = logging.getLogger(__name__)

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
    "ImportProgressContext",
    "ImportRuntime",
    "ImportSetup",
    "_add_progress_event",
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
    "_load_progress_job",
    "_process_new_trips_batch",
    "_record_failure_reason",
    "_record_per_device_unique_counts",
    "_record_process_failure",
    "_record_validation_failure",
    "_run_import_windows",
    "_trim_events",
    "_update_insert_result_counters",
    "_vehicle_label",
    "_write_cancelled_progress",
    "_write_insert_progress",
    "_write_scan_progress",
    "_write_window_insert_progress",
    "_write_window_scan_progress",
    "build_import_plan",
    "build_import_windows",
    "logger",
    "resolve_import_start_dt",
    "resolve_import_start_dt_from_db",
    "run_import",
]
