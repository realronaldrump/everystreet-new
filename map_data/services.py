"""
Map services management.

Provides:
- Container/service health checks
- Simplified map services configuration and status
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from pathlib import Path
from datetime import UTC, datetime
from typing import Any

import httpx

from config import get_nominatim_base_url, get_osm_extracts_path, get_valhalla_base_url
from map_data.models import GeoServiceHealth, MapBuildProgress, MapServiceConfig
from map_data.us_states import get_state, total_size_mb
from tasks.arq import get_arq_pool
from tasks.ops import abort_job

logger = logging.getLogger(__name__)

DOCKER_CMD_TIMEOUT = 10.0
MAX_RETRIES = int(os.getenv("MAP_SERVICE_MAX_RETRIES", "3"))


def _cleanup_map_setup_artifacts() -> dict[str, int]:
    removed = {"states": 0, "temps": 0, "merged": 0, "coverage": 0}
    extracts_path = Path(get_osm_extracts_path())
    if not extracts_path.exists():
        return removed

    states_dir = extracts_path / "states"
    if states_dir.exists():
        for path in states_dir.glob("*.downloading"):
            with contextlib.suppress(OSError):
                path.unlink()
                removed["temps"] += 1
        for path in states_dir.glob("*.tmp"):
            with contextlib.suppress(OSError):
                path.unlink()
                removed["temps"] += 1
        for path in states_dir.glob("*.osm.pbf"):
            with contextlib.suppress(OSError):
                path.unlink()
                removed["states"] += 1

    merged_dir = extracts_path / "merged"
    if merged_dir.exists():
        for name in ("us-states.osm.pbf", "us-states.osm.pbf.tmp"):
            with contextlib.suppress(OSError):
                (merged_dir / name).unlink()
                removed["merged"] += 1
        for path in merged_dir.glob("*.tmp"):
            with contextlib.suppress(OSError):
                path.unlink()
                removed["merged"] += 1

    coverage_dir = extracts_path / "coverage"
    if coverage_dir.exists():
        for name in ("coverage.osm.pbf", "coverage.geojson", "coverage.osm.pbf.tmp"):
            with contextlib.suppress(OSError):
                (coverage_dir / name).unlink()
                removed["coverage"] += 1
        for path in coverage_dir.glob("*.tmp"):
            with contextlib.suppress(OSError):
                path.unlink()
                removed["coverage"] += 1

    return removed


def _is_docker_unavailable_error(error_text: str) -> bool:
    lowered = error_text.lower()
    return any(
        phrase in lowered
        for phrase in [
            "cannot connect to the docker daemon",
            "permission denied",
            "docker is not running",
            "error during connect",
            "dial unix",
        ]
    )


async def _run_docker_cmd(cmd: list[str]) -> tuple[int, str, str]:
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=DOCKER_CMD_TIMEOUT,
            )
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            return 124, "", "timeout"
        return (
            process.returncode,
            stdout.decode(errors="replace").strip(),
            stderr.decode(errors="replace").strip(),
        )
    except FileNotFoundError as exc:
        return 127, "", str(exc)


async def _infer_compose_project(service_name: str) -> str | None:
    env_project = os.getenv("COMPOSE_PROJECT_NAME", "").strip()
    if env_project:
        return env_project

    cmd = [
        "docker",
        "ps",
        "-a",
        "--filter",
        f"label=com.docker.compose.service={service_name}",
        "--format",
        '{{.Label "com.docker.compose.project"}}',
    ]
    rc, stdout, stderr = await _run_docker_cmd(cmd)
    if rc != 0:
        if _is_docker_unavailable_error(stderr):
            return None
        return None
    for line in stdout.splitlines():
        value = line.strip()
        if value:
            return value
    return None


async def _find_container_names(service_name: str) -> tuple[list[str], str | None]:
    project = await _infer_compose_project(service_name)

    if project:
        cmd = [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--filter",
            f"label=com.docker.compose.service={service_name}",
            "--format",
            "{{.Names}}",
        ]
        rc, stdout, stderr = await _run_docker_cmd(cmd)
        if rc == 0 and stdout:
            return stdout.splitlines(), None
        if _is_docker_unavailable_error(stderr):
            return [], stderr or "docker unavailable"

    cmd = [
        "docker",
        "ps",
        "-a",
        "--filter",
        f"name={service_name}",
        "--format",
        "{{.Names}}",
    ]
    rc, stdout, stderr = await _run_docker_cmd(cmd)
    if rc == 0 and stdout:
        return stdout.splitlines(), None
    if _is_docker_unavailable_error(stderr):
        return [], stderr or "docker unavailable"
    return [], None


async def _inspect_container(container_name: str) -> dict[str, Any]:
    cmd = ["docker", "inspect", container_name]
    rc, stdout, stderr = await _run_docker_cmd(cmd)
    if rc != 0:
        if _is_docker_unavailable_error(stderr):
            return {"error": stderr or "docker unavailable"}
        return {"error": stderr or "inspect failed"}
    try:
        data = json.loads(stdout)
        if isinstance(data, list) and data:
            return data[0]
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        return {"error": "inspect returned invalid json"}
    return {"error": "inspect returned no data"}


async def check_container_status(service_name: str) -> dict[str, Any]:
    """
    Check if a docker compose service container is running.

    Tries Docker Compose v2 (docker compose) first, then falls back to
    Docker Compose v1 (docker-compose) if unavailable, then finally
    falls back to docker ps if both fail.

    Uses asyncio subprocesses to avoid blocking the event loop.
    """
    # Try Docker Compose v2 (plugin) and v1 (standalone) in order
    names, error = await _find_container_names(service_name)
    if error:
        return {
            "running": False,
            "status": "docker unavailable",
            "error": error,
            "container": None,
        }

    if not names:
        return {
            "running": False,
            "status": "not found",
            "container": None,
        }

    container_name = names[0]
    inspect = await _inspect_container(container_name)
    state = inspect.get("State") if isinstance(inspect, dict) else {}
    running = bool(state.get("Running"))
    status_text = str(state.get("Status") or "unknown")
    restart_count = inspect.get("RestartCount") if isinstance(inspect, dict) else None
    oom_killed = bool(state.get("OOMKilled")) if isinstance(state, dict) else False
    exit_code = state.get("ExitCode") if isinstance(state, dict) else None

    return {
        "running": running,
        "status": status_text,
        "container": {
            "name": container_name,
            "status": status_text,
            "oom_killed": oom_killed,
            "exit_code": exit_code,
            "restart_count": restart_count,
            "error": inspect.get("error") if isinstance(inspect, dict) else None,
        },
    }


async def check_service_health(force_refresh: bool = False) -> GeoServiceHealth:
    """
    Check health of Nominatim and Valhalla services.

    Args:
        force_refresh: If True, always perform fresh health checks

    Returns:
        GeoServiceHealth document with current status
    """
    health = await GeoServiceHealth.get_or_create()

    if not force_refresh and health.last_updated:
        age = (datetime.now(UTC) - health.last_updated).total_seconds()
        if age < 30:
            return health

    nominatim_container = await check_container_status("nominatim")
    health.nominatim_container_running = bool(nominatim_container.get("running"))
    nominatim_url = get_nominatim_base_url()
    try:
        if not health.nominatim_container_running:
            health.nominatim_healthy = False
            health.nominatim_has_data = False
            container_info = nominatim_container.get("container") or {}
            if container_info.get("oom_killed"):
                health.nominatim_error = "Address lookup failed (OOM)"
            elif nominatim_container.get("status") == "docker unavailable":
                health.nominatim_error = "Docker unavailable (socket/permissions)"
            else:
                health.nominatim_error = "Address lookup offline"
            health.nominatim_last_check = datetime.now(UTC)
            health.nominatim_response_time_ms = None
            health.nominatim_version = None
        else:
            start = time.monotonic()
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{nominatim_url}/status")
            elapsed = (time.monotonic() - start) * 1000

            health.nominatim_has_data = response.status_code == 200
            health.nominatim_healthy = health.nominatim_has_data
            health.nominatim_response_time_ms = elapsed
            health.nominatim_last_check = datetime.now(UTC)
            health.nominatim_error = None

            if response.status_code == 200:
                try:
                    text = response.text
                    if "Nominatim" in text:
                        health.nominatim_version = text.strip()
                except Exception:
                    pass
            else:
                health.nominatim_error = "Address lookup starting..."
    except Exception as exc:
        health.nominatim_healthy = False
        health.nominatim_has_data = False
        health.nominatim_last_check = datetime.now(UTC)
        health.nominatim_response_time_ms = None
        health.nominatim_version = None
        error_str = str(exc).lower()
        if "connection refused" in error_str:
            health.nominatim_error = "Address lookup starting..."
        elif "timed out" in error_str or "timeout" in error_str:
            health.nominatim_error = "Address lookup not responding"
        else:
            health.nominatim_error = str(exc)

    valhalla_container = await check_container_status("valhalla")
    health.valhalla_container_running = bool(valhalla_container.get("running"))
    valhalla_url = get_valhalla_base_url()
    try:
        if not health.valhalla_container_running:
            health.valhalla_healthy = False
            health.valhalla_has_data = False
            container_info = valhalla_container.get("container") or {}
            if container_info.get("oom_killed"):
                health.valhalla_error = "Routing failed (OOM)"
            elif valhalla_container.get("status") == "docker unavailable":
                health.valhalla_error = "Docker unavailable (socket/permissions)"
            else:
                health.valhalla_error = "Routing offline"
            health.valhalla_last_check = datetime.now(UTC)
            health.valhalla_response_time_ms = None
            health.valhalla_version = None
            health.valhalla_tile_count = None
        else:
            start = time.monotonic()
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{valhalla_url}/status")
            elapsed = (time.monotonic() - start) * 1000

            health.valhalla_response_time_ms = elapsed
            health.valhalla_last_check = datetime.now(UTC)
            health.valhalla_error = None
            health.valhalla_has_data = False

            if response.status_code == 200:
                try:
                    data = response.json()
                    if isinstance(data, dict):
                        health.valhalla_version = data.get("version")
                        health.valhalla_tile_count = data.get("tileset", {}).get(
                            "tile_count",
                        )
                        health.valhalla_has_data = bool(
                            (health.valhalla_tile_count or 0) > 0,
                        )
                        if not health.valhalla_has_data:
                            tileset_last_modified = data.get("tileset_last_modified")
                            if tileset_last_modified:
                                health.valhalla_has_data = True
                except Exception:
                    pass

            health.valhalla_healthy = (
                response.status_code == 200 and health.valhalla_has_data
            )
            if response.status_code != 200 or not health.valhalla_has_data:
                health.valhalla_error = "Routing starting..."
    except Exception as exc:
        health.valhalla_healthy = False
        health.valhalla_has_data = False
        health.valhalla_last_check = datetime.now(UTC)
        health.valhalla_response_time_ms = None
        health.valhalla_version = None
        health.valhalla_tile_count = None
        error_str = str(exc).lower()
        if "connection refused" in error_str:
            health.valhalla_error = "Routing starting..."
        elif "timed out" in error_str or "timeout" in error_str:
            health.valhalla_error = "Routing not responding"
        else:
            health.valhalla_error = str(exc)

    health.last_updated = datetime.now(UTC)
    await health.save()

    return health


def normalize_state_codes(states: list[str]) -> tuple[list[str], list[str]]:
    normalized: list[str] = []
    invalid: list[str] = []
    seen = set()
    for state in states:
        code = str(state or "").strip().upper()
        if not code or code in seen:
            continue
        if not get_state(code):
            invalid.append(code)
            continue
        normalized.append(code)
        seen.add(code)
    return normalized, invalid


async def configure_map_services(
    states: list[str],
    *,
    force: bool = False,
) -> dict[str, Any]:
    selected_states, invalid = normalize_state_codes(states)
    if invalid:
        msg = f"Invalid state codes: {', '.join(invalid)}."
        raise ValueError(msg)
    if not selected_states:
        msg = "Select at least one state."
        raise ValueError(msg)

    config = await MapServiceConfig.get_or_create()
    progress = await MapBuildProgress.get_or_create()

    if (
        config.status
        in {
            MapServiceConfig.STATUS_DOWNLOADING,
            MapServiceConfig.STATUS_BUILDING,
        }
        and not progress.cancellation_requested
    ):
        msg = "Map setup already in progress."
        raise RuntimeError(msg)

    if (
        not force
        and config.status == MapServiceConfig.STATUS_READY
        and config.selected_states == selected_states
    ):
        return await get_map_services_status()

    now = datetime.now(UTC)
    config.selected_states = selected_states
    config.status = MapServiceConfig.STATUS_DOWNLOADING
    config.progress = 0.0
    config.message = "Preparing map setup..."
    config.geocoding_ready = False
    config.routing_ready = False
    config.last_error = None
    config.last_error_at = None
    config.retry_count = 0
    config.last_updated = now
    await config.save()

    progress.phase = MapBuildProgress.PHASE_DOWNLOADING
    progress.phase_progress = 0.0
    progress.total_progress = 0.0
    progress.started_at = now
    progress.cancellation_requested = False
    progress.last_progress_at = now
    progress.active_job_id = None
    await progress.save()

    pool = await get_arq_pool()
    arq_job = await pool.enqueue_job("setup_map_data_task", selected_states)
    job_id = (
        getattr(arq_job, "job_id", None) or getattr(arq_job, "id", None) or str(arq_job)
    )
    progress.active_job_id = job_id
    progress.last_progress_at = datetime.now(UTC)
    await progress.save()

    return await get_map_services_status()


async def cancel_map_setup() -> dict[str, Any]:
    progress = await MapBuildProgress.get_or_create()
    config = await MapServiceConfig.get_or_create()

    if config.status not in {
        MapServiceConfig.STATUS_DOWNLOADING,
        MapServiceConfig.STATUS_BUILDING,
    }:
        return await get_map_services_status()

    now = datetime.now(UTC)
    progress.cancellation_requested = True
    progress.last_progress_at = now
    await progress.save()

    aborted = False
    if progress.active_job_id:
        with contextlib.suppress(Exception):
            aborted = await abort_job(progress.active_job_id)

    cleanup_result = _cleanup_map_setup_artifacts()
    logger.info("Map setup cleanup removed artifacts: %s", cleanup_result)

    config.status = MapServiceConfig.STATUS_NOT_CONFIGURED
    config.message = "Setup cancelled"
    config.progress = 0.0
    config.last_error = None
    config.last_error_at = None
    config.retry_count = 0
    config.last_updated = now
    await config.save()

    progress.phase = MapBuildProgress.PHASE_IDLE
    progress.phase_progress = 0.0
    progress.total_progress = 0.0
    progress.active_job_id = None
    progress.started_at = None
    progress.last_progress_at = now
    await progress.save()

    return await get_map_services_status()


def _state_names_for_codes(codes: list[str]) -> list[str]:
    names = []
    for code in codes:
        state = get_state(code)
        if state:
            names.append(str(state.get("name") or code))
    return names


async def get_map_services_status(force_refresh: bool = False) -> dict[str, Any]:
    config = await MapServiceConfig.get_or_create()
    progress = await MapBuildProgress.get_or_create()

    health = await check_service_health(force_refresh=force_refresh)
    nominatim_container = await check_container_status("nominatim")
    valhalla_container = await check_container_status("valhalla")
    geocoding_ready = bool(health.nominatim_healthy)
    routing_ready = bool(health.valhalla_healthy)

    if config.selected_states:
        if config.geocoding_ready != geocoding_ready:
            config.geocoding_ready = geocoding_ready
        if config.routing_ready != routing_ready:
            config.routing_ready = routing_ready
        config.last_updated = datetime.now(UTC)
        await config.save()
    elif config.status == MapServiceConfig.STATUS_NOT_CONFIGURED and not config.message:
        config.message = "Select states to begin."
        config.last_updated = datetime.now(UTC)
        await config.save()

    selected_names = _state_names_for_codes(config.selected_states)
    total_size = total_size_mb(config.selected_states)

    return {
        "success": True,
        "config": {
            "selected_states": config.selected_states,
            "selected_state_names": selected_names,
            "status": config.status,
            "progress": config.progress,
            "message": config.message,
            "geocoding_ready": config.geocoding_ready,
            "routing_ready": config.routing_ready,
            "last_error": config.last_error,
            "retry_count": config.retry_count,
            "max_retries": MAX_RETRIES,
            "last_updated": (
                config.last_updated.isoformat() if config.last_updated else None
            ),
        },
        "build": {
            "phase": progress.phase,
            "phase_progress": progress.phase_progress,
            "total_progress": progress.total_progress,
            "started_at": (
                progress.started_at.isoformat() if progress.started_at else None
            ),
            "last_progress_at": (
                progress.last_progress_at.isoformat()
                if progress.last_progress_at
                else None
            ),
            "active_job_id": progress.active_job_id,
        },
        "progress": {
            "phase": progress.phase,
            "phase_progress": progress.phase_progress,
            "total_progress": progress.total_progress,
            "started_at": (
                progress.started_at.isoformat() if progress.started_at else None
            ),
            "last_progress_at": (
                progress.last_progress_at.isoformat()
                if progress.last_progress_at
                else None
            ),
            "cancellation_requested": progress.cancellation_requested,
        },
        "services": {
            "nominatim": {
                "healthy": health.nominatim_healthy,
                "has_data": health.nominatim_has_data,
                "error": health.nominatim_error,
                "container": nominatim_container.get("container"),
            },
            "valhalla": {
                "healthy": health.valhalla_healthy,
                "has_data": health.valhalla_has_data,
                "error": health.valhalla_error,
                "container": valhalla_container.get("container"),
            },
        },
        "total_size_mb": total_size,
    }
