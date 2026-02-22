"""
Build orchestration for Nominatim and Valhalla.

The implementation lives in dedicated modules; this file preserves the
public build entrypoints used across the codebase.
"""

from __future__ import annotations

import logging

from map_data.builders_common import (
    _OUTPUT_LINE_OVERFLOW_BYTES,
    _OUTPUT_LINE_OVERFLOW_TEXT,
    CONTAINER_START_TIMEOUT,
    PROGRESS_UPDATE_INTERVAL,
    _get_int_env,
    _raise_error,
    _resolve_pbf_path,
    _safe_callback,
    _safe_readline,
)
from map_data.builders_container import (
    _restart_container,
    check_container_running,
    start_container_on_demand,
)
from map_data.builders_nominatim import (
    _clear_nominatim_import_marker,
    _mark_nominatim_import_finished,
    _stop_nominatim_service,
    _terminate_nominatim_connections,
    _wait_for_nominatim_db_ready,
    _wait_for_nominatim_healthy,
    build_nominatim_data,
)
from map_data.builders_valhalla import _wait_for_valhalla_healthy, build_valhalla_tiles

logger = logging.getLogger(__name__)

__all__ = [
    "CONTAINER_START_TIMEOUT",
    "PROGRESS_UPDATE_INTERVAL",
    "_OUTPUT_LINE_OVERFLOW_BYTES",
    "_OUTPUT_LINE_OVERFLOW_TEXT",
    "_clear_nominatim_import_marker",
    "_get_int_env",
    "_mark_nominatim_import_finished",
    "_raise_error",
    "_resolve_pbf_path",
    "_restart_container",
    "_safe_callback",
    "_safe_readline",
    "_stop_nominatim_service",
    "_terminate_nominatim_connections",
    "_wait_for_nominatim_db_ready",
    "_wait_for_nominatim_healthy",
    "_wait_for_valhalla_healthy",
    "build_nominatim_data",
    "build_valhalla_tiles",
    "check_container_running",
    "logger",
    "start_container_on_demand",
]
