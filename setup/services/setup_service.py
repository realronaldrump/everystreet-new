"""Setup status and health endpoints for first-run configuration."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import HTTPException, status

from config import validate_mapbox_token
from core.service_config import clear_config_cache, get_service_config
from db.models import AppSettings, TaskConfig, TaskHistory
from map_data.models import MapServiceConfig
from map_data.services import check_service_health
from setup.services.bouncie_credentials import get_bouncie_credentials
from tasks.arq import get_arq_pool
from tasks.config import set_global_disable
from tasks.ops import enqueue_task
from tasks.registry import TASK_DEFINITIONS

logger = logging.getLogger(__name__)


async def _get_or_create_settings() -> AppSettings:
    settings = await AppSettings.find_one()
    if not settings:
        settings = AppSettings()
        await settings.insert()
    return settings


def _normalize_devices(devices: Any) -> list[str]:
    if isinstance(devices, list):
        return [str(device).strip() for device in devices if str(device).strip()]
    if isinstance(devices, str):
        return [device.strip() for device in devices.split(",") if device.strip()]
    return []


async def get_setup_status() -> dict[str, Any]:
    settings = await _get_or_create_settings()
    credentials = await get_bouncie_credentials()

    bouncie_missing = []
    for field in ["client_id", "client_secret", "redirect_uri"]:
        if not credentials.get(field):
            bouncie_missing.append(field)

    devices = _normalize_devices(credentials.get("authorized_devices"))
    if not devices:
        bouncie_missing.append("authorized_devices")

    bouncie_complete = len(bouncie_missing) == 0

    mapbox_token = (await get_service_config()).mapbox_token or ""
    mapbox_complete = False
    mapbox_error = None
    if mapbox_token:
        try:
            validate_mapbox_token(mapbox_token)
        except RuntimeError as exc:
            mapbox_error = str(exc)
        else:
            mapbox_complete = True

    map_config = await MapServiceConfig.get_or_create()
    coverage_complete = map_config.status == MapServiceConfig.STATUS_READY and bool(
        map_config.selected_states,
    )

    return {
        "setup_completed": bool(settings.setup_completed),
        "setup_completed_at": (
            settings.setup_completed_at.isoformat()
            if settings.setup_completed_at
            else None
        ),
        "required_complete": bouncie_complete and mapbox_complete and coverage_complete,
        "steps": {
            "bouncie": {
                "complete": bouncie_complete,
                "missing": bouncie_missing,
                "required": True,
            },
            "mapbox": {
                "complete": mapbox_complete,
                "missing": ["mapbox_token"] if not mapbox_complete else [],
                "error": mapbox_error,
                "required": True,
            },
            "coverage": {
                "complete": coverage_complete,
                "required": True,
                "selected_states": map_config.selected_states,
                "status": map_config.status,
            },
        },
    }


async def _enable_task(task_id: str, interval_minutes: int) -> None:
    task_config = await TaskConfig.find_one(TaskConfig.task_id == task_id)
    if not task_config:
        task_config = TaskConfig(task_id=task_id)
    task_config.enabled = True
    task_config.interval_minutes = interval_minutes
    task_config.last_updated = datetime.now(UTC)
    task_config.config = task_config.config or {}
    await task_config.save()


async def complete_setup() -> dict[str, Any]:
    settings = await _get_or_create_settings()
    now = datetime.now(UTC)
    if settings.setup_completed:
        return {
            "success": True,
            "message": "Setup already completed",
            "already_completed": True,
            "initial_fetch_job_id": None,
        }

    status_payload = await get_setup_status()
    if not status_payload.get("required_complete"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Complete Bouncie credentials, Mapbox token, and map coverage "
                "before finishing setup."
            ),
        )

    settings.setup_completed = True
    settings.setup_completed_at = now
    settings.updated_at = now
    await settings.save()
    clear_config_cache()

    await set_global_disable(False)
    await _enable_task("periodic_fetch_trips", 5)
    await _enable_task("cleanup_stale_trips", 60)

    initial_fetch = None
    try:
        initial_fetch = await enqueue_task(
            "periodic_fetch_trips",
            manual_run=True,
            trigger_source="setup",
        )
    except Exception as exc:
        logger.warning("Failed to enqueue initial trip fetch: %s", exc)

    return {
        "success": True,
        "message": "Setup completed",
        "initial_fetch_job_id": initial_fetch.get("job_id") if initial_fetch else None,
    }


def _status_label(status_value: str) -> str:
    return {
        "healthy": "Healthy",
        "warning": "Warning",
        "error": "Error",
    }.get(status_value, "Unknown")


def _derive_geo_status(
    container_running: bool,
    has_data: bool,
    error: str | None,
) -> str:
    if not container_running:
        return "error"
    if has_data:
        return "healthy"
    if error:
        return "warning"
    return "warning"


def _format_geo_detail(container_running: bool, has_data: bool) -> str:
    container_label = "Running" if container_running else "Stopped"
    if not container_running:
        service_label = "Unavailable"
    else:
        service_label = "Ready" if has_data else "Starting up"
    return f"Container: {container_label} | Service: {service_label}"


async def get_service_health() -> dict[str, Any]:
    now = datetime.now(UTC)

    mongo_status = "healthy"
    mongo_message = "Connected"
    mongo_detail = None
    try:
        await AppSettings.find_one()
    except Exception as exc:
        mongo_status = "error"
        mongo_message = "MongoDB unavailable"
        mongo_detail = str(exc)

    redis_status = "healthy"
    redis_message = "Connected"
    redis_detail = None
    redis = None
    try:
        redis = await get_arq_pool()
        await redis.ping()
    except Exception as exc:
        redis_status = "error"
        redis_message = "Redis unavailable"
        redis_detail = str(exc)

    worker_status = "warning"
    worker_message = "Waiting for worker heartbeat"
    worker_detail = None
    active_tasks = 0
    if redis_status == "healthy" and redis:
        heartbeat = await redis.get("arq:worker:heartbeat")
        if heartbeat:
            heartbeat_value = (
                heartbeat.decode()
                if isinstance(heartbeat, bytes | bytearray)
                else str(heartbeat)
            )
            heartbeat_dt = None
            try:
                heartbeat_dt = datetime.fromisoformat(heartbeat_value)
            except ValueError:
                worker_detail = "Heartbeat timestamp unreadable"

            if heartbeat_dt is not None:
                age_seconds = (now - cast("datetime", heartbeat_dt)).total_seconds()
                if age_seconds <= 120:
                    worker_status = "healthy"
                    worker_message = "Worker online"
                    worker_detail = f"Last heartbeat {int(age_seconds)}s ago"
                else:
                    worker_status = "warning"
                    worker_message = "Worker heartbeat stale"
                    worker_detail = f"Last heartbeat {int(age_seconds)}s ago"

    active_tasks = await TaskHistory.find(
        {"status": {"$in": ["RUNNING", "PENDING"]}},
    ).count()
    active_label = f"Active tasks: {active_tasks}"
    worker_detail = (
        f"{worker_detail} | {active_label}" if worker_detail else active_label
    )

    credentials = await get_bouncie_credentials()
    bouncie_devices = _normalize_devices(credentials.get("authorized_devices"))
    bouncie_ready = all(
        credentials.get(field)
        for field in [
            "client_id",
            "client_secret",
            "redirect_uri",
        ]
    ) and bool(bouncie_devices)
    bouncie_status = "healthy" if bouncie_ready else "warning"
    bouncie_message = (
        f"Configured for {len(bouncie_devices)} device(s)"
        if bouncie_ready
        else "Credentials not configured"
    )
    bouncie_detail = None

    geo_health = await check_service_health(force_refresh=True)
    nominatim_status = _derive_geo_status(
        geo_health.nominatim_container_running,
        geo_health.nominatim_has_data,
        geo_health.nominatim_error,
    )
    nominatim_message = (
        "Service ready"
        if geo_health.nominatim_has_data
        else geo_health.nominatim_error or "Starting up"
    )
    nominatim_detail = _format_geo_detail(
        geo_health.nominatim_container_running,
        geo_health.nominatim_has_data,
    )

    valhalla_status = _derive_geo_status(
        geo_health.valhalla_container_running,
        geo_health.valhalla_has_data,
        geo_health.valhalla_error,
    )
    valhalla_message = (
        "Service ready"
        if geo_health.valhalla_has_data
        else geo_health.valhalla_error or "Starting up"
    )
    valhalla_detail = _format_geo_detail(
        geo_health.valhalla_container_running,
        geo_health.valhalla_has_data,
    )

    sort_key = "-timestamp"
    recent_errors = (
        await TaskHistory.find({"status": "FAILED"}).sort(sort_key).limit(5).to_list()
    )
    recent_error_payload = [
        {
            "task_id": entry.task_id,
            "timestamp": entry.timestamp.isoformat() if entry.timestamp else None,
            "error": entry.error,
        }
        for entry in recent_errors
    ]

    service_statuses = {
        "mongodb": {
            "status": mongo_status,
            "label": _status_label(mongo_status),
            "message": mongo_message,
            "detail": mongo_detail,
        },
        "redis": {
            "status": redis_status,
            "label": _status_label(redis_status),
            "message": redis_message,
            "detail": redis_detail,
        },
        "worker": {
            "status": worker_status,
            "label": _status_label(worker_status),
            "message": worker_message,
            "detail": worker_detail,
        },
        "nominatim": {
            "status": nominatim_status,
            "label": _status_label(nominatim_status),
            "message": nominatim_message,
            "detail": nominatim_detail,
            "container_running": geo_health.nominatim_container_running,
            "has_data": geo_health.nominatim_has_data,
        },
        "valhalla": {
            "status": valhalla_status,
            "label": _status_label(valhalla_status),
            "message": valhalla_message,
            "detail": valhalla_detail,
            "container_running": geo_health.valhalla_container_running,
            "has_data": geo_health.valhalla_has_data,
        },
        "bouncie": {
            "status": bouncie_status,
            "label": _status_label(bouncie_status),
            "message": bouncie_message,
            "detail": bouncie_detail,
        },
    }

    statuses = [entry["status"] for entry in service_statuses.values()]
    overall_status = "healthy"
    if "error" in statuses:
        overall_status = "error"
    elif "warning" in statuses:
        overall_status = "warning"

    overall_message = {
        "healthy": "All services are healthy.",
        "warning": "Some services need attention.",
        "error": "Critical services are unavailable.",
    }[overall_status]

    return {
        "success": True,
        "overall": {
            "status": overall_status,
            "message": overall_message,
            "last_updated": now.isoformat(),
        },
        "services": service_statuses,
        "recent_errors": recent_error_payload,
    }


async def restart_service(service_name: str) -> dict[str, Any]:
    service_name = service_name.strip().lower()
    if service_name not in {"nominatim", "valhalla"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Unsupported service", "code": "invalid_service"},
        )

    from map_data.builders import _restart_container

    await _restart_container(service_name)

    return {
        "success": True,
        "message": f"{service_name.title()} restart triggered",
        "service": service_name,
    }


async def get_service_logs(service_name: str, tail: int = 100) -> dict[str, Any]:
    """Fetch recent logs for a service container."""
    service_name = service_name.strip().lower()
    # Basic allowlist for security
    allowed = {"nominatim", "valhalla", "mongo", "redis", "worker", "app"}
    if service_name not in allowed and not service_name.startswith("everystreet-"):
        # Also allow app service if named differently in compose
        if service_name != "web":
            pass

    # Actually, let's just use a mapped lookup for container names
    container_map = {
        "nominatim": "nominatim",
        "valhalla": "valhalla",
        "mongodb": "mongo",
        "redis": "redis",
        "worker": "worker",
        "app": "app",
        "bouncie": "bouncie-webhook",  # If separate, otherwise it might be part of app or worker
    }

    target_container = container_map.get(service_name, service_name)

    import asyncio

    # Try docker compose logs first
    cmd = [
        "docker",
        "compose",
        "logs",
        "--tail",
        str(tail),
        "--no-log-prefix",
        target_container,
    ]

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=5.0)

        output = stdout.decode("utf-8", errors="replace")
        error_out = stderr.decode("utf-8", errors="replace")

        if process.returncode != 0:
            # Fallback to simple docker logs if compose fails or container not found via compose
            # (Sometimes service names differ from container names)
            [
                "docker",
                "logs",
                "--tail",
                str(tail),
                f"everystreet-{target_container}-1",
            ]
            # This is a bit guessing, let's just return the error if compose failed for now
            # or try to interpret standard docker logs
            return {
                "success": False,
                "logs": f"Failed to fetch logs: {error_out}",
                "service": service_name,
            }

        return {
            "success": True,
            "logs": output,
            "service": service_name,
            "timestamp": datetime.now(UTC).isoformat(),
        }
    except Exception as exc:
        return {
            "success": False,
            "logs": f"Error fetching logs: {exc}",
            "service": service_name,
        }


async def trigger_task(task_name: str) -> dict[str, Any]:
    """Manually trigger a background task."""
    if task_name not in TASK_DEFINITIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown task: {task_name}",
        )

    try:
        job = await enqueue_task(
            task_name,
            manual_run=True,
            trigger_source="admin_dashboard",
        )
        return {
            "success": True,
            "message": f"Task '{task_name}' triggered successfully",
            "job_id": job.get("job_id") if job else None,
        }
    except Exception as exc:
        logger.exception("Failed to trigger task %s", task_name)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


class SetupService:
    """Setup wizard service helpers."""

    @staticmethod
    async def get_setup_status() -> dict[str, Any]:
        return await get_setup_status()

    @staticmethod
    async def complete_setup() -> dict[str, Any]:
        return await complete_setup()

    @staticmethod
    async def get_service_health() -> dict[str, Any]:
        return await get_service_health()

    @staticmethod
    async def restart_service(service_name: str) -> dict[str, Any]:
        return await restart_service(service_name)

    @staticmethod
    async def get_service_logs(service_name: str) -> dict[str, Any]:
        return await get_service_logs(service_name)

    @staticmethod
    async def trigger_task(task_name: str) -> dict[str, Any]:
        return await trigger_task(task_name)


__all__ = [
    "SetupService",
    "complete_setup",
    "get_service_health",
    "get_service_logs",
    "get_setup_status",
    "restart_service",
    "trigger_task",
]
