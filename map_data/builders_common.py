"""
Shared helpers for map-data build orchestration.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

from config import get_osm_extracts_path

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)


def _raise_error(msg: str, exc_type: type[Exception] = RuntimeError) -> None:
    raise exc_type(msg)


# Build configuration
PROGRESS_UPDATE_INTERVAL = 5.0  # Update progress every 5 seconds
CONTAINER_START_TIMEOUT = 120  # seconds to wait for container to start
_OUTPUT_LINE_OVERFLOW_TEXT = "Output line exceeded buffer; skipping"
_OUTPUT_LINE_OVERFLOW_BYTES = _OUTPUT_LINE_OVERFLOW_TEXT.encode("utf-8")


def _get_int_env(name: str, default: int) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    else:
        return parsed if parsed > 0 else default


async def _safe_readline(
    stream: asyncio.StreamReader,
    *,
    wait_timeout: float,
    label: str,
) -> bytes:
    try:
        return await asyncio.wait_for(stream.readline(), timeout=wait_timeout)
    except asyncio.LimitOverrunError as exc:
        consumed = int(getattr(exc, "consumed", 0) or 0)
        if consumed > 0:
            with contextlib.suppress(Exception):
                await stream.readexactly(consumed)
        logger.warning(
            "%s output line exceeded buffer; skipped %s bytes",
            label,
            consumed,
        )
        return _OUTPUT_LINE_OVERFLOW_BYTES
    except ValueError as exc:
        if "Separator is found, but chunk is longer than limit" in str(
            exc,
        ) or "Separator is not found, and chunk exceed the limit" in str(exc):
            logger.warning(
                "%s output line exceeded buffer (ValueError); skipping",
                label,
            )
            return _OUTPUT_LINE_OVERFLOW_BYTES
        raise


def _resolve_pbf_path(pbf_path: str) -> tuple[str, str]:
    extracts_path = get_osm_extracts_path()
    if Path(pbf_path).is_absolute():
        pbf_full_path = pbf_path
        pbf_relative = os.path.relpath(pbf_full_path, extracts_path)
    else:
        pbf_relative = pbf_path
        pbf_full_path = str(Path(extracts_path) / pbf_path)

    if pbf_relative.startswith(".."):
        msg = f"PBF path must be within extracts volume: {pbf_path}"
        raise ValueError(msg)

    return pbf_full_path, pbf_relative


async def _safe_callback(
    callback: Callable[[float, str], Any],
    progress: float,
    message: str,
) -> None:
    """Safely call a progress callback, handling both sync and async."""
    try:
        result = callback(progress, message)
        if asyncio.iscoroutine(result):
            await result
    except Exception as e:
        if isinstance(e, asyncio.CancelledError):
            raise
        if e.__class__.__name__ == "MapSetupCancelled":
            raise
        logger.warning("Progress callback failed: %s", e)
