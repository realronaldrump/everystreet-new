"""Unified map setup pipeline tasks."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import aiofiles
import httpx
from shapely.geometry import box
from shapely.ops import unary_union

from config import get_geofabrik_mirror, get_osm_extracts_path
from core.service_config import get_service_config
from map_data.auto_provision import US_STATE_BOUNDS
from map_data.builders import (
    build_nominatim_data,
    build_valhalla_tiles,
    start_container_on_demand,
)
from map_data.coverage import (
    build_trip_coverage_extract,
    build_trip_coverage_extract_from_geometry,
    build_trip_coverage_polygon,
)
from map_data.geofabrik_index import (
    find_smallest_covering_extract,
    load_geofabrik_index,
)
from map_data.models import MapServiceConfig
from map_data.progress import MapBuildProgress
from map_data.services import check_service_health
from map_data.us_states import build_geofabrik_path, get_state
from tasks.arq import get_arq_pool
from tasks.ops import abort_job, run_task_with_history

logger = logging.getLogger(__name__)

SETUP_JOB_TIMEOUT_SECONDS = int(
    os.getenv("MAP_SERVICE_SETUP_JOB_TIMEOUT_SECONDS", str(10 * 60 * 60)),
)
STALL_THRESHOLD_MINUTES = int(os.getenv("MAP_SERVICE_STALL_MINUTES", "25"))
RETRY_BASE_SECONDS = int(os.getenv("MAP_SERVICE_RETRY_BASE_SECONDS", "90"))
RETRY_MAX_SECONDS = int(os.getenv("MAP_SERVICE_RETRY_MAX_SECONDS", "900"))
MAX_RETRIES = int(os.getenv("MAP_SERVICE_MAX_RETRIES", "3"))
COVERAGE_BUILD_TIMEOUT_SECONDS = int(
    os.getenv("MAP_SERVICE_COVERAGE_TIMEOUT_SECONDS", "600"),
)
COVERAGE_EXTRACT_TIMEOUT_SECONDS = int(
    os.getenv("MAP_SERVICE_COVERAGE_EXTRACT_TIMEOUT_SECONDS", "1800"),
)
COVERAGE_EXTRACT_HEARTBEAT_SECONDS = float(
    os.getenv("MAP_SERVICE_COVERAGE_HEARTBEAT_SECONDS", "20"),
)

DOWNLOAD_PROGRESS_END = 40.0
MERGE_PROGRESS_END = 45.0
NOMINATIM_PROGRESS_END = 70.0
VALHALLA_PROGRESS_END = 95.0
VERIFY_PROGRESS_END = 100.0

CHUNK_SIZE = 4 * 1024 * 1024


class MapSetupCancelledError(RuntimeError):
    """Raised when map setup is cancelled."""


@dataclass
class DownloadTracker:
    total_bytes: int
    downloaded_bytes: int = 0
    last_update: float = 0.0

    def percent(self) -> float:
        if self.total_bytes <= 0:
            return 0.0
        return (self.downloaded_bytes / self.total_bytes) * 100.0


@dataclass
class DownloadResult:
    files: list[str]
    used_covering_extract: bool = False


@dataclass(frozen=True)
class DownloadTarget:
    geofabrik_id: str
    filename: str
    label: str


def _normalize_states(states: list[str]) -> list[str]:
    normalized: list[str] = []
    seen = set()
    for state in states:
        code = str(state or "").strip().upper()
        if not code or code in seen:
            continue
        if not get_state(code):
            msg = f"Invalid state code: {code}"
            raise ValueError(msg)
        normalized.append(code)
        seen.add(code)
    return normalized


def _state_filename(geofabrik_id: str) -> str:
    safe_id = geofabrik_id.replace("/", "-")
    return f"{safe_id}.osm.pbf"


def _state_download_url(geofabrik_id: str) -> str:
    mirror = get_geofabrik_mirror()
    path = build_geofabrik_path(geofabrik_id)
    return f"{mirror}/{path}-latest.osm.pbf"


def _format_extract_label(geofabrik_id: str, default_label: str) -> str:
    parts = [part for part in geofabrik_id.split("/") if part]
    if parts and parts[0] == "north-america":
        parts = parts[1:]
    if parts[:1] == ["us"] and len(parts) > 1:
        parts = parts[1:]
    if not parts:
        return default_label
    return " / ".join(segment.replace("-", " ").title() for segment in parts)


def _build_state_bounds_union(states: list[str]) -> Any | None:
    boxes = []
    for code in states:
        bounds = US_STATE_BOUNDS.get(code)
        if bounds:
            boxes.append(box(*bounds))
    if not boxes:
        return None
    if len(boxes) == 1:
        return boxes[0]
    return unary_union(boxes)


def _retry_delay_seconds(retry_count: int) -> int:
    if retry_count <= 0:
        return 0
    return min(RETRY_BASE_SECONDS * (2 ** (retry_count - 1)), RETRY_MAX_SECONDS)


async def _sync_cancellation_flag(
    progress: MapBuildProgress,
    *,
    raise_on_cancel: bool = False,
) -> None:
    latest = await MapBuildProgress.get_or_create()
    progress.cancellation_requested = bool(latest.cancellation_requested)
    if raise_on_cancel and progress.cancellation_requested:
        msg = "Setup cancelled"
        raise MapSetupCancelledError(msg)


async def _update_progress(
    config: MapServiceConfig,
    progress: MapBuildProgress,
    *,
    status: str | None = None,
    message: str | None = None,
    overall_progress: float | None = None,
    phase: str | None = None,
    phase_progress: float | None = None,
    geocoding_ready: bool | None = None,
    routing_ready: bool | None = None,
    last_error: str | None = None,
    allow_cancel: bool = True,
) -> None:
    await _sync_cancellation_flag(progress, raise_on_cancel=allow_cancel)
    now = datetime.now(UTC)
    if status is not None:
        config.status = status
    if message is not None:
        config.message = message
    if overall_progress is not None:
        config.progress = float(overall_progress)
        progress.total_progress = float(overall_progress)
    if geocoding_ready is not None:
        config.geocoding_ready = geocoding_ready
    if routing_ready is not None:
        config.routing_ready = routing_ready
    if last_error is not None:
        config.last_error = last_error
        config.last_error_at = now
    config.last_updated = now

    if phase is not None:
        progress.phase = phase
    if phase_progress is not None:
        progress.phase_progress = float(phase_progress)
    progress.last_progress_at = now

    await config.save()
    await progress.save()


async def _check_cancel(progress: MapBuildProgress) -> None:
    await _sync_cancellation_flag(progress, raise_on_cancel=True)


async def _download_state(
    client: httpx.AsyncClient,
    url: str,
    destination: str,
    tracker: DownloadTracker,
    progress_callback: Any,
    progress_doc: MapBuildProgress,
) -> None:
    temp_path = Path(f"{destination}.downloading")
    dest_path = Path(destination)
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    async with client.stream("GET", url) as response:
        response.raise_for_status()
        content_length = response.headers.get("Content-Length")
        if content_length:
            with contextlib.suppress(ValueError):
                tracker.total_bytes += max(0, int(content_length))
        async with aiofiles.open(temp_path, "wb") as handle:
            async for chunk in response.aiter_bytes(CHUNK_SIZE):
                await _check_cancel(progress_doc)
                await handle.write(chunk)
                tracker.downloaded_bytes += len(chunk)
                now = time.monotonic()
                if (now - tracker.last_update) >= 0.8:
                    tracker.last_update = now
                    await progress_callback()

    temp_path.replace(dest_path)
    await progress_callback(force=True)


async def _download_states(
    states: list[str],
    config: MapServiceConfig,
    progress: MapBuildProgress,
    *,
    coverage_by_state: dict[str, Any] | None = None,
) -> DownloadResult:
    download_plan: list[DownloadTarget] = []
    selected_ids: set[str] = set()
    index_data = None

    if len(states) > 1:
        union_geometry = _build_state_bounds_union(states)
        index_data = await load_geofabrik_index()
        path_prefix = build_geofabrik_path("us")
        covering_id = None
        if union_geometry is not None:
            covering_id = find_smallest_covering_extract(
                index_data,
                path_prefix=path_prefix,
                coverage_geometry=union_geometry,
            )
        if not covering_id:
            covering_id = "us"
            logger.info(
                "Falling back to US extract for multi-state selection (no smaller covering extract found).",
            )
        label = _format_extract_label(covering_id, "Selected states")
        download_plan.append(
            DownloadTarget(covering_id, _state_filename(covering_id), label),
        )
        selected_ids.add(covering_id)
    else:
        if coverage_by_state:
            index_data = await load_geofabrik_index()

        for code in states:
            state = get_state(code)
            if not state:
                continue
            geofabrik_id = str(state.get("geofabrik_id"))
            target_id = geofabrik_id
            coverage_geom = coverage_by_state.get(code) if coverage_by_state else None
            if coverage_geom is not None and index_data:
                path_prefix = build_geofabrik_path(geofabrik_id)
                candidate = find_smallest_covering_extract(
                    index_data,
                    path_prefix=path_prefix,
                    coverage_geometry=coverage_geom,
                )
                if candidate:
                    target_id = candidate
                    if target_id != geofabrik_id:
                        logger.info("Using smaller extract %s for %s", target_id, code)

            if target_id in selected_ids:
                continue
            selected_ids.add(target_id)

            filename = _state_filename(target_id)
            label = _format_extract_label(target_id, state.get("name", code))
            download_plan.append(DownloadTarget(target_id, filename, label))

    extracts_path = Path(get_osm_extracts_path())
    states_dir = extracts_path / "states"
    states_dir.mkdir(parents=True, exist_ok=True)
    existing_bytes = 0
    for target in download_plan:
        target_path = states_dir / target.filename
        if target_path.exists() and target_path.stat().st_size > 0:
            existing_bytes += target_path.stat().st_size

    tracker = DownloadTracker(total_bytes=max(existing_bytes, 1))
    tracker.downloaded_bytes = existing_bytes

    async def progress_callback(force: bool = False) -> None:
        percent = tracker.percent()
        overall = DOWNLOAD_PROGRESS_END * (percent / 100.0)
        if force:
            overall = min(DOWNLOAD_PROGRESS_END, overall)
        await _update_progress(
            config,
            progress,
            status=MapServiceConfig.STATUS_DOWNLOADING,
            message="Downloading map data...",
            overall_progress=overall,
            phase=MapBuildProgress.PHASE_DOWNLOADING,
            phase_progress=percent,
        )

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=30.0),
        follow_redirects=True,
    ) as client:
        for target in download_plan:
            await _check_cancel(progress)
            url = _state_download_url(target.geofabrik_id)
            target_path = states_dir / target.filename
            if target_path.exists() and target_path.stat().st_size > 0:
                await progress_callback(force=True)
                continue
            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_DOWNLOADING,
                message=f"Downloading {target.label}...",
            )
            await _download_state(
                client,
                url,
                str(target_path),
                tracker,
                progress_callback,
                progress,
            )

    await _update_progress(
        config,
        progress,
        status=MapServiceConfig.STATUS_DOWNLOADING,
        message="Download complete",
        overall_progress=DOWNLOAD_PROGRESS_END,
        phase=MapBuildProgress.PHASE_DOWNLOADING,
        phase_progress=100.0,
    )

    return DownloadResult(
        files=[str(states_dir / target.filename) for target in download_plan],
        used_covering_extract=len(states) > 1,
    )


async def _merge_pbf_files(
    files: list[str],
    config: MapServiceConfig,
    progress: MapBuildProgress,
) -> str:
    extracts_path = Path(get_osm_extracts_path())
    merged_dir = extracts_path / "merged"
    merged_dir.mkdir(parents=True, exist_ok=True)
    output_path = merged_dir / "us-states.osm.pbf"
    temp_output = output_path.with_suffix(".osm.pbf.tmp")

    await _update_progress(
        config,
        progress,
        status=MapServiceConfig.STATUS_DOWNLOADING,
        message="Merging map files...",
        overall_progress=DOWNLOAD_PROGRESS_END + 2.0,
        phase=MapBuildProgress.PHASE_DOWNLOADING,
        phase_progress=100.0,
    )

    if len(files) == 1:
        src = Path(files[0])
        if src != output_path:
            with contextlib.suppress(FileNotFoundError):
                temp_output.unlink()
            with contextlib.suppress(FileNotFoundError):
                output_path.unlink()
            try:
                os.link(src, output_path)
            except OSError:
                shutil.copy2(src, output_path)
        await _update_progress(
            config,
            progress,
            status=MapServiceConfig.STATUS_DOWNLOADING,
            message="Map files ready",
            overall_progress=MERGE_PROGRESS_END,
        )
        return str(output_path)

    with contextlib.suppress(FileNotFoundError):
        temp_output.unlink()
    with contextlib.suppress(FileNotFoundError):
        output_path.unlink()

    cmd = ["osmium", "merge", "-f", "pbf", "-o", str(temp_output), *files]
    logger.info("Running osmium merge: %s", " ".join(cmd))

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await process.communicate()

    if process.returncode != 0:
        error_msg = stderr.decode().strip() if stderr else "osmium merge failed"
        raise RuntimeError(error_msg)

    temp_output.replace(output_path)
    await _update_progress(
        config,
        progress,
        status=MapServiceConfig.STATUS_DOWNLOADING,
        message="Map files ready",
        overall_progress=MERGE_PROGRESS_END,
    )
    return str(output_path)


async def _maybe_build_coverage_extract(
    merged_pbf: str,
    config: MapServiceConfig,
    progress: MapBuildProgress,
    *,
    coverage_geometry: Any | None = None,
    state_bounds_geometry: Any | None = None,
    skip_coverage_extract: bool = False,
) -> str:
    settings = await get_service_config()
    mode = str(getattr(settings, "mapCoverageMode", "trips") or "trips").lower()
    extract_path = None

    if mode in {"trips", "auto"}:
        if skip_coverage_extract:
            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_DOWNLOADING,
                message="Coverage analysis timed out; falling back to state bounds.",
                overall_progress=MERGE_PROGRESS_END + 2.0,
                phase=MapBuildProgress.PHASE_DOWNLOADING,
                phase_progress=100.0,
            )
        else:
            buffer_miles = float(
                getattr(settings, "mapCoverageBufferMiles", 10.0) or 10.0,
            )
            simplify_feet = float(
                getattr(settings, "mapCoverageSimplifyFeet", 150.0) or 0.0,
            )
            max_points = int(
                getattr(settings, "mapCoverageMaxPointsPerTrip", 2000) or 2000,
            )
            batch_size = int(getattr(settings, "mapCoverageBatchSize", 200) or 200)

            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_DOWNLOADING,
                message="Preparing coverage extract...",
                overall_progress=MERGE_PROGRESS_END + 1.0,
                phase=MapBuildProgress.PHASE_DOWNLOADING,
                phase_progress=-1.0,
            )

            async def coverage_progress(stats: Any) -> None:
                await _update_progress(
                    config,
                    progress,
                    status=MapServiceConfig.STATUS_DOWNLOADING,
                    message=(
                        "Preparing coverage extract... "
                        f"trips={getattr(stats, 'trips_seen', 0):,} "
                        f"geometries={getattr(stats, 'geometries_used', 0):,}"
                    ),
                    overall_progress=MERGE_PROGRESS_END + 1.0,
                    phase=MapBuildProgress.PHASE_DOWNLOADING,
                    phase_progress=-1.0,
                )

            async def extract_heartbeat() -> None:
                await _update_progress(
                    config,
                    progress,
                    status=MapServiceConfig.STATUS_DOWNLOADING,
                    message="Preparing coverage extract...",
                    overall_progress=MERGE_PROGRESS_END + 1.0,
                    phase=MapBuildProgress.PHASE_DOWNLOADING,
                    phase_progress=-1.0,
                    allow_cancel=False,
                )

            try:
                if coverage_geometry is not None:
                    extract_path = await build_trip_coverage_extract_from_geometry(
                        merged_pbf,
                        coverage_geometry,
                        heartbeat_callback=extract_heartbeat,
                        heartbeat_interval=COVERAGE_EXTRACT_HEARTBEAT_SECONDS,
                        timeout_seconds=COVERAGE_EXTRACT_TIMEOUT_SECONDS,
                    )
                else:
                    extract_path = await build_trip_coverage_extract(
                        merged_pbf,
                        buffer_miles=buffer_miles,
                        simplify_feet=simplify_feet,
                        max_points_per_trip=max_points,
                        batch_size=batch_size,
                        progress_callback=coverage_progress,
                        polygon_timeout_seconds=COVERAGE_BUILD_TIMEOUT_SECONDS,
                        extract_timeout_seconds=COVERAGE_EXTRACT_TIMEOUT_SECONDS,
                        extract_heartbeat=extract_heartbeat,
                        extract_heartbeat_interval=COVERAGE_EXTRACT_HEARTBEAT_SECONDS,
                    )
            except Exception as exc:
                logger.warning("Coverage extract failed: %s", exc)
                extract_path = None

            if extract_path:
                await _update_progress(
                    config,
                    progress,
                    status=MapServiceConfig.STATUS_DOWNLOADING,
                    message="Coverage extract ready",
                    overall_progress=MERGE_PROGRESS_END + 2.0,
                    phase=MapBuildProgress.PHASE_DOWNLOADING,
                    phase_progress=100.0,
                )
                return extract_path
            logger.warning(
                "Coverage extract unavailable; falling back to state bounds.",
            )

    if state_bounds_geometry is not None:
        try:
            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_DOWNLOADING,
                message="Clipping extract to selected states...",
                overall_progress=MERGE_PROGRESS_END + 1.0,
                phase=MapBuildProgress.PHASE_DOWNLOADING,
                phase_progress=100.0,
            )
            extract_path = await build_trip_coverage_extract_from_geometry(
                merged_pbf,
                state_bounds_geometry,
                heartbeat_interval=COVERAGE_EXTRACT_HEARTBEAT_SECONDS,
                timeout_seconds=COVERAGE_EXTRACT_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning("State bounds extract failed: %s", exc)
            extract_path = None

        if extract_path:
            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_DOWNLOADING,
                message="State bounds extract ready",
                overall_progress=MERGE_PROGRESS_END + 2.0,
                phase=MapBuildProgress.PHASE_DOWNLOADING,
                phase_progress=100.0,
            )
            return extract_path
        logger.warning("State bounds extract unavailable; using merged PBF.")

    await _update_progress(
        config,
        progress,
        status=MapServiceConfig.STATUS_DOWNLOADING,
        message="Using full extract.",
        overall_progress=MERGE_PROGRESS_END + 2.0,
        phase=MapBuildProgress.PHASE_DOWNLOADING,
        phase_progress=100.0,
    )
    return merged_pbf


async def _build_nominatim(
    pbf_relative: str,
    config: MapServiceConfig,
    progress: MapBuildProgress,
) -> None:
    last_determinate = 0.0

    async def progress_callback(phase_progress: float, message: str) -> None:
        nonlocal last_determinate
        if phase_progress is not None and phase_progress >= 0:
            last_determinate = phase_progress
        effective = last_determinate
        detail = (message or "").strip() or "Import in progress..."
        if not detail.lower().startswith(("geocoding:", "nominatim:", "geocoder:")):
            detail = f"Geocoding: {detail}"
        overall = MERGE_PROGRESS_END + (effective / 100.0) * (
            NOMINATIM_PROGRESS_END - MERGE_PROGRESS_END
        )
        await _update_progress(
            config,
            progress,
            status=MapServiceConfig.STATUS_BUILDING,
            message=detail,
            overall_progress=overall,
            phase=MapBuildProgress.PHASE_BUILDING_GEOCODER,
            phase_progress=phase_progress,
        )

    await _update_progress(
        config,
        progress,
        status=MapServiceConfig.STATUS_BUILDING,
        message="Geocoding: Preparing import...",
        overall_progress=MERGE_PROGRESS_END,
        phase=MapBuildProgress.PHASE_BUILDING_GEOCODER,
        phase_progress=0.0,
    )
    await build_nominatim_data(
        pbf_relative,
        label="selected states",
        progress_callback=progress_callback,
    )


async def _build_valhalla(
    pbf_relative: str,
    config: MapServiceConfig,
    progress: MapBuildProgress,
) -> None:
    last_determinate = 0.0

    async def progress_callback(phase_progress: float, message: str) -> None:
        nonlocal last_determinate
        if phase_progress is not None and phase_progress >= 0:
            last_determinate = phase_progress
        effective = last_determinate
        detail = (message or "").strip() or "Building tiles..."
        if not detail.lower().startswith(("routing:", "valhalla:", "router:")):
            detail = f"Routing: {detail}"
        overall = NOMINATIM_PROGRESS_END + (effective / 100.0) * (
            VALHALLA_PROGRESS_END - NOMINATIM_PROGRESS_END
        )
        await _update_progress(
            config,
            progress,
            status=MapServiceConfig.STATUS_BUILDING,
            message=detail,
            overall_progress=overall,
            phase=MapBuildProgress.PHASE_BUILDING_ROUTER,
            phase_progress=phase_progress,
        )

    await _update_progress(
        config,
        progress,
        status=MapServiceConfig.STATUS_BUILDING,
        message="Routing: Preparing tiles...",
        overall_progress=NOMINATIM_PROGRESS_END,
        phase=MapBuildProgress.PHASE_BUILDING_ROUTER,
        phase_progress=0.0,
    )
    await build_valhalla_tiles(
        pbf_relative,
        label="selected states",
        progress_callback=progress_callback,
    )


async def _verify_health(
    config: MapServiceConfig,
    progress: MapBuildProgress,
) -> None:
    await _update_progress(
        config,
        progress,
        status=MapServiceConfig.STATUS_BUILDING,
        message="Finalizing services...",
        overall_progress=VALHALLA_PROGRESS_END,
    )

    for attempt in range(10):
        await _check_cancel(progress)
        health = await check_service_health(force_refresh=True)
        await _update_progress(
            config,
            progress,
            status=MapServiceConfig.STATUS_BUILDING,
            message="Finalizing services...",
            overall_progress=VALHALLA_PROGRESS_END + 2 + attempt,
            geocoding_ready=health.nominatim_healthy,
            routing_ready=health.valhalla_healthy,
        )
        if health.nominatim_healthy and health.valhalla_healthy:
            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_READY,
                message="Maps ready",
                overall_progress=VERIFY_PROGRESS_END,
                geocoding_ready=True,
                routing_ready=True,
            )
            return
        await asyncio.sleep(5)

    await _update_progress(
        config,
        progress,
        status=MapServiceConfig.STATUS_READY,
        message="Map services starting up...",
        overall_progress=VERIFY_PROGRESS_END,
    )


async def setup_map_data_task(ctx: dict, states: list[str]) -> dict[str, Any]:
    job_id = ctx.get("job_id") or ctx.get("id")

    async def run_pipeline() -> dict[str, Any]:
        config = await MapServiceConfig.get_or_create()
        progress = await MapBuildProgress.get_or_create()

        normalized = _normalize_states(states)
        if not normalized:
            msg = "No valid states selected."
            raise ValueError(msg)

        settings = await get_service_config()
        mode = str(getattr(settings, "mapCoverageMode", "trips") or "trips").lower()
        buffer_miles = float(
            getattr(settings, "mapCoverageBufferMiles", 10.0) or 10.0,
        )
        simplify_feet = float(
            getattr(settings, "mapCoverageSimplifyFeet", 150.0) or 0.0,
        )
        max_points = int(
            getattr(settings, "mapCoverageMaxPointsPerTrip", 2000) or 2000,
        )
        batch_size = int(getattr(settings, "mapCoverageBatchSize", 200) or 200)

        initial_message = (
            "Analyzing trip coverage..."
            if mode in {"trips", "auto"}
            else "Preparing downloads..."
        )
        await _update_progress(
            config,
            progress,
            status=MapServiceConfig.STATUS_DOWNLOADING,
            message=initial_message,
            overall_progress=0.0,
            phase=MapBuildProgress.PHASE_DOWNLOADING,
            phase_progress=0.0,
            geocoding_ready=False,
            routing_ready=False,
        )

        coverage_geometry = None
        coverage_analysis_timed_out = False
        coverage_by_state: dict[str, Any] = {}
        if mode in {"trips", "auto"}:

            async def coverage_progress(stats: Any) -> None:
                await _update_progress(
                    config,
                    progress,
                    status=MapServiceConfig.STATUS_DOWNLOADING,
                    message=(
                        "Analyzing trip coverage... "
                        f"trips={stats.trips_seen:,} "
                        f"geometries={stats.geometries_used:,}"
                    ),
                    overall_progress=0.0,
                    phase=MapBuildProgress.PHASE_DOWNLOADING,
                    phase_progress=0.0,
                )

            try:
                coverage_geometry, _stats = await asyncio.wait_for(
                    build_trip_coverage_polygon(
                        buffer_miles=buffer_miles,
                        simplify_feet=simplify_feet,
                        max_points_per_trip=max_points,
                        batch_size=batch_size,
                        progress_callback=coverage_progress,
                    ),
                    timeout=COVERAGE_BUILD_TIMEOUT_SECONDS,
                )
            except TimeoutError:
                coverage_analysis_timed_out = True
                logger.warning(
                    "Coverage polygon build timed out after %s seconds",
                    COVERAGE_BUILD_TIMEOUT_SECONDS,
                )
                await _update_progress(
                    config,
                    progress,
                    status=MapServiceConfig.STATUS_DOWNLOADING,
                    message="Coverage analysis timed out; downloading full extracts...",
                    overall_progress=0.0,
                    phase=MapBuildProgress.PHASE_DOWNLOADING,
                    phase_progress=0.0,
                )

            if coverage_geometry is not None:
                for code in normalized:
                    bounds = US_STATE_BOUNDS.get(code)
                    if not bounds:
                        continue
                    state_box = box(*bounds)
                    intersection = coverage_geometry.intersection(state_box)
                    if not intersection.is_empty:
                        coverage_by_state[code] = intersection

        progress.active_job_id = str(job_id) if job_id else None
        progress.cancellation_requested = False
        progress.started_at = progress.started_at or datetime.now(UTC)
        progress.last_progress_at = datetime.now(UTC)
        await progress.save()

        try:
            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_DOWNLOADING,
                message="Downloading map data...",
                overall_progress=0.0,
                phase=MapBuildProgress.PHASE_DOWNLOADING,
                phase_progress=0.0,
                geocoding_ready=False,
                routing_ready=False,
            )

            download_result = await _download_states(
                normalized,
                config,
                progress,
                coverage_by_state=coverage_by_state or None,
            )
            await _check_cancel(progress)

            if download_result.used_covering_extract:
                await _update_progress(
                    config,
                    progress,
                    status=MapServiceConfig.STATUS_DOWNLOADING,
                    message="Using single covering extract to avoid duplicates...",
                    overall_progress=DOWNLOAD_PROGRESS_END,
                    phase=MapBuildProgress.PHASE_DOWNLOADING,
                    phase_progress=100.0,
                )

            merged = await _merge_pbf_files(download_result.files, config, progress)
            await _check_cancel(progress)

            extracts_path = get_osm_extracts_path()
            state_bounds_union = (
                _build_state_bounds_union(normalized)
                if download_result.used_covering_extract
                else None
            )
            coverage_pbf = await _maybe_build_coverage_extract(
                merged,
                config,
                progress,
                coverage_geometry=coverage_geometry,
                state_bounds_geometry=state_bounds_union,
                skip_coverage_extract=coverage_analysis_timed_out,
            )
            await _check_cancel(progress)
            pbf_relative = os.path.relpath(coverage_pbf, extracts_path)

            await _build_nominatim(pbf_relative, config, progress)
            await _check_cancel(progress)
            await _build_valhalla(pbf_relative, config, progress)
            await _check_cancel(progress)

            await _verify_health(config, progress)

            config.retry_count = 0
            config.last_error = None
            config.last_error_at = None
            await config.save()

            progress.phase = MapBuildProgress.PHASE_IDLE
            progress.phase_progress = 100.0
            progress.total_progress = VERIFY_PROGRESS_END
            progress.active_job_id = None
            progress.cancellation_requested = False
            progress.last_progress_at = datetime.now(UTC)
            await progress.save()
        except MapSetupCancelledError as exc:
            config.last_error = None
            config.last_error_at = None
            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_NOT_CONFIGURED,
                message="Setup cancelled",
                overall_progress=0.0,
                allow_cancel=False,
            )
            progress.phase = MapBuildProgress.PHASE_IDLE
            progress.phase_progress = 0.0
            progress.total_progress = 0.0
            progress.active_job_id = None
            progress.cancellation_requested = False
            progress.last_progress_at = datetime.now(UTC)
            await progress.save()
            return {"success": False, "error": str(exc)}
        except Exception as exc:
            logger.exception("Map setup failed")
            config.retry_count = min(config.retry_count + 1, MAX_RETRIES)
            retry_exhausted = config.retry_count >= MAX_RETRIES
            await _update_progress(
                config,
                progress,
                status=MapServiceConfig.STATUS_ERROR,
                message=(
                    "Setup failed, retry limit reached"
                    if retry_exhausted
                    else "Setup paused, will retry automatically"
                ),
                overall_progress=config.progress,
                last_error=str(exc),
            )
            progress.phase = MapBuildProgress.PHASE_IDLE
            progress.phase_progress = 0.0
            progress.active_job_id = None
            progress.last_progress_at = datetime.now(UTC)
            await progress.save()
            return {"success": False, "error": str(exc)}
        else:
            return {"success": True}

    return await run_task_with_history(
        ctx,
        "setup_map_data_task",
        run_pipeline,
    )


async def _enqueue_setup_job(states: list[str]) -> str:
    pool = await get_arq_pool()
    arq_job = await pool.enqueue_job("setup_map_data_task", states)
    return (
        getattr(arq_job, "job_id", None) or getattr(arq_job, "id", None) or str(arq_job)
    )


async def _monitor_map_services_logic() -> dict[str, Any]:
    config = await MapServiceConfig.get_or_create()
    progress = await MapBuildProgress.get_or_create()
    now = datetime.now(UTC)

    restarted = False
    retried = False

    if config.status in {
        MapServiceConfig.STATUS_DOWNLOADING,
        MapServiceConfig.STATUS_BUILDING,
    }:
        last_progress = progress.last_progress_at or progress.started_at
        if last_progress and now - last_progress > timedelta(
            minutes=STALL_THRESHOLD_MINUTES,
        ):
            progress.cancellation_requested = True
            await progress.save()
            if progress.active_job_id:
                with contextlib.suppress(Exception):
                    await abort_job(progress.active_job_id)
            config.status = MapServiceConfig.STATUS_ERROR
            config.last_error = "Setup stalled, restarting"
            config.last_error_at = now
            config.message = "Setup paused, will retry automatically"
            config.last_updated = now
            await config.save()
            restarted = True

    if (
        config.status == MapServiceConfig.STATUS_ERROR
        and config.retry_count > 0
        and config.retry_count < MAX_RETRIES
        and config.selected_states
    ):
        delay_seconds = _retry_delay_seconds(config.retry_count)
        if config.last_error_at and now >= config.last_error_at + timedelta(
            seconds=delay_seconds,
        ):
            progress.phase = MapBuildProgress.PHASE_DOWNLOADING
            progress.phase_progress = 0.0
            progress.total_progress = 0.0
            progress.cancellation_requested = False
            progress.started_at = now
            progress.last_progress_at = now
            job_id = await _enqueue_setup_job(config.selected_states)
            progress.active_job_id = job_id
            await progress.save()

            config.status = MapServiceConfig.STATUS_DOWNLOADING
            config.message = "Retrying map setup..."
            config.progress = 0.0
            config.last_updated = now
            await config.save()
            retried = True

    if config.status == MapServiceConfig.STATUS_READY and config.selected_states:
        health = await check_service_health(force_refresh=True)
        if not health.nominatim_container_running:
            with contextlib.suppress(Exception):
                await start_container_on_demand("nominatim")
                restarted = True
        if not health.valhalla_container_running:
            with contextlib.suppress(Exception):
                await start_container_on_demand("valhalla")
                restarted = True

    return {
        "status": "success",
        "restarted": restarted,
        "retried": retried,
    }


async def monitor_map_services(
    ctx: dict,
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "monitor_map_data_jobs",
        _monitor_map_services_logic,
        manual_run=manual_run,
    )


async def _auto_provision_logic() -> dict[str, Any]:
    """
    Check for trips in unconfigured states and auto-provision if needed.

    This runs periodically to ensure map services stay in sync with trip
    data.
    """
    from map_data.auto_provision import auto_provision_map_data, should_auto_provision

    try:
        check = await should_auto_provision()

        if not check.get("should_provision"):
            return {
                "status": "no_action",
                "reason": check.get("reason", "No provisioning needed"),
            }

        # Auto-provision detected states
        result = await auto_provision_map_data()

    except Exception as e:
        logger.exception("Auto-provision check failed")
        return {
            "status": "error",
            "error": str(e),
        }
    else:
        return {
            "status": "provisioning_triggered",
            "result": result,
        }


async def auto_provision_check(
    ctx: dict,
    manual_run: bool = False,
) -> dict[str, Any]:
    """
    Background task to check for and auto-provision map data.

    Runs periodically to detect trips in unconfigured states and
    automatically trigger map data downloads.
    """
    return await run_task_with_history(
        ctx,
        "auto_provision_map_data",
        _auto_provision_logic,
        manual_run=manual_run,
    )
