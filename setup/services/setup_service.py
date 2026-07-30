"""Setup status and health endpoints for first-run configuration."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException, status

from config import get_mapbox_token, validate_mapbox_token
from core.mapping.factory import get_router
from core.service_config import clear_config_cache
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


def _normalized_map_provider(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw or "self_hosted").strip().lower()


async def get_setup_status() -> dict[str, Any]:
    settings = await _get_or_create_settings()
    credentials = await get_bouncie_credentials()
    map_provider = _normalized_map_provider(settings.map_provider)
    using_google = map_provider == "google"

    bouncie_missing = [
        field
        for field in ["client_id", "client_secret", "redirect_uri"]
        if not credentials.get(field)
    ]

    devices = _normalize_devices(credentials.get("authorized_devices"))
    if not devices:
        bouncie_missing.append("authorized_devices")

    bouncie_complete = len(bouncie_missing) == 0

    mapbox_token = get_mapbox_token()
    mapbox_complete = True
    mapbox_error = None
    try:
        validate_mapbox_token(mapbox_token)
    except RuntimeError as exc:
        mapbox_complete = False
        mapbox_error = str(exc)

    map_config = await MapServiceConfig.get_or_create()
    coverage_complete = (
        True
        if using_google
        else (
            map_config.status == MapServiceConfig.STATUS_READY
            and bool(map_config.selected_states)
        )
    )
    google_key_complete = bool((settings.google_maps_api_key or "").strip())
    required_complete = (
        bouncie_complete and google_key_complete
        if using_google
        else (bouncie_complete and mapbox_complete and coverage_complete)
    )

    return {
        "map_provider": map_provider,
        "setup_completed": bool(settings.setup_completed),
        "setup_completed_at": (
            settings.setup_completed_at.isoformat()
            if settings.setup_completed_at
            else None
        ),
        "required_complete": required_complete,
        "steps": {
            "provider": {
                "complete": map_provider in {"self_hosted", "google"},
                "selected": map_provider,
                "required": True,
            },
            "bouncie": {
                "complete": bouncie_complete,
                "missing": bouncie_missing,
                "required": True,
            },
            "mapbox": {
                "complete": mapbox_complete if not using_google else True,
                "missing": (
                    ["hardcoded_token"]
                    if (not mapbox_complete and not using_google)
                    else []
                ),
                "error": mapbox_error,
                "required": not using_google,
                "skipped": using_google,
            },
            "google_maps": {
                "complete": google_key_complete,
                "missing": ["google_maps_api_key"] if not google_key_complete else [],
                "required": using_google,
                "skipped": not using_google,
            },
            "coverage": {
                "complete": coverage_complete,
                "required": not using_google,
                "skipped": using_google,
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
        map_provider = str(status_payload.get("map_provider") or "self_hosted").lower()
        detail = "Complete Bouncie credentials and map coverage before finishing setup."
        if map_provider == "google":
            detail = (
                "Complete Bouncie credentials and add a Google Maps API key "
                "before finishing setup."
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        )

    settings.setup_completed = True
    settings.setup_completed_at = now
    settings.updated_at = now
    await settings.save()
    clear_config_cache()

    await set_global_disable(False)
    await _enable_task("periodic_fetch_trips", 5)

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


def _format_geo_details(
    container_running: bool,
    has_data: bool,
) -> list[dict[str, Any]]:
    container_label = "Running" if container_running else "Stopped"
    if not container_running:
        service_label = "Unavailable"
    else:
        service_label = "Ready" if has_data else "Starting up"
    return [
        {"label": "Container", "value": container_label},
        {"label": "Service", "value": service_label},
    ]


_BOUNCIE_WEBHOOK_STALE_AFTER = timedelta(days=7)
_BOUNCIE_EVENT_LABELS = {
    "tripStart": "Trip started",
    "tripData": "Trip data",
    "tripMetrics": "Trip metrics",
    "tripEnd": "Trip ended",
}


def _parse_utc_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _bouncie_delivery_is_stale(last_received: Any, *, now: datetime) -> bool:
    received_at = _parse_utc_datetime(last_received)
    if received_at is None:
        return False
    return now - received_at > _BOUNCIE_WEBHOOK_STALE_AFTER


async def get_service_health() -> dict[str, Any]:
    now = datetime.now(UTC)
    settings = await _get_or_create_settings()
    map_provider = _normalized_map_provider(settings.map_provider)
    using_google = map_provider == "google"

    mongo_status = "healthy"
    mongo_message = "Connected"
    mongo_details: list[dict[str, Any]] = []
    try:
        await AppSettings.find_one()
    except Exception as exc:
        mongo_status = "error"
        mongo_message = "MongoDB unavailable"
        mongo_details.append({"label": "Error", "value": str(exc)})

    redis_status = "healthy"
    redis_message = "Connected"
    redis_details: list[dict[str, Any]] = []
    redis = None
    try:
        redis = await get_arq_pool()
        await redis.ping()
    except Exception as exc:
        redis_status = "error"
        redis_message = "Redis unavailable"
        redis_details.append({"label": "Error", "value": str(exc)})

    worker_status = "warning"
    worker_message = "Waiting for worker heartbeat"
    worker_details: list[dict[str, Any]] = []
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
                worker_details.append(
                    {"label": "Heartbeat", "value": "Unreadable timestamp"},
                )

            if heartbeat_dt is not None:
                if heartbeat_dt.tzinfo is None:
                    heartbeat_dt = heartbeat_dt.replace(tzinfo=UTC)
                else:
                    heartbeat_dt = heartbeat_dt.astimezone(UTC)
                age_seconds = max(0, (now - heartbeat_dt).total_seconds())
                if age_seconds <= 120:
                    worker_status = "healthy"
                    worker_message = "Worker online"
                else:
                    worker_status = "warning"
                    worker_message = "Worker heartbeat stale"
                worker_details.append(
                    {
                        "label": "Last heartbeat",
                        "value": heartbeat_dt.isoformat(),
                        "format": "relative_datetime",
                    },
                )

    active_tasks = await TaskHistory.find(
        {"status": {"$in": ["RUNNING", "PENDING"]}},
    ).count()
    worker_details.append(
        {
            "label": "Active tasks",
            "value": active_tasks,
            "format": "integer",
        },
    )

    from tracking.services.tracking_service import TrackingService

    credentials = await get_bouncie_credentials()
    webhook_status = await TrackingService.get_webhook_status()
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
    bouncie_label = "Configured" if bouncie_ready else "Setup needed"
    bouncie_message = (
        f"{len(bouncie_devices)} {'device' if len(bouncie_devices) == 1 else 'devices'} configured"
        if bouncie_ready
        else "Credentials not configured"
    )
    bouncie_details: list[dict[str, Any]] = []
    if bouncie_ready:
        bouncie_details.append(
            {
                "label": "Devices",
                "value": len(bouncie_devices),
                "format": "integer",
            },
        )

    last_received = webhook_status.get("last_received")
    if last_received:
        bouncie_details.append(
            {
                "label": "Last delivery",
                "value": last_received,
                "format": "relative_datetime",
            },
        )
        event_type = webhook_status.get("event_type")
        if event_type:
            bouncie_details.append(
                {
                    "label": "Event",
                    "value": _BOUNCIE_EVENT_LABELS.get(event_type, str(event_type)),
                },
            )
    elif bouncie_ready:
        bouncie_details.append({"label": "Last delivery", "value": "None yet"})

    webhook_url = webhook_status.get("webhook_url")
    if webhook_url:
        bouncie_details.append(
            {
                "label": "Webhook URL",
                "value": webhook_url,
                "format": "url",
                "copyable": True,
            },
        )

    public_ok = webhook_status.get("webhook_public_ok")
    public_status_code = webhook_status.get("webhook_status_code")
    public_error = webhook_status.get("webhook_error")
    webhook_active = webhook_status.get("webhook_active")

    if bouncie_ready and public_ok is False:
        bouncie_status = "error"
        bouncie_label = "Unreachable"
        bouncie_message = "Public webhook endpoint is unreachable"
        if public_status_code is not None:
            bouncie_details.append(
                {"label": "Public probe", "value": f"HTTP {public_status_code}"},
            )
        if public_error:
            bouncie_details.append({"label": "Probe error", "value": public_error})
    elif bouncie_ready and webhook_active is False:
        bouncie_status = "warning"
        bouncie_label = "Inactive"
        bouncie_message = "Bouncie webhook is inactive"
        bouncie_details.append(
            {
                "label": "Action",
                "value": "Update the webhook in the Bouncie Developer Portal",
            },
        )
    elif bouncie_ready and _bouncie_delivery_is_stale(last_received, now=now):
        bouncie_status = "warning"
        bouncie_label = "Stale"
        bouncie_message = "No webhook deliveries in the past 7 days"
    elif bouncie_ready and last_received:
        bouncie_label = "Receiving data"
    elif bouncie_ready:
        bouncie_message = "Waiting for the first webhook delivery"

    provider_status = "healthy"
    provider_message = (
        "Google Maps provider is active"
        if using_google
        else "Self-hosted provider active"
    )
    provider_details: list[dict[str, Any]] = []
    if using_google:
        try:
            router = await get_router()
            router_state = await router.status()
            engine = str(router_state.get("engine") or "").strip().lower()
            if engine and engine != "google":
                provider_status = "warning"
                provider_message = f"Active router reports '{engine}'"
                provider_details.append(
                    {
                        "label": "Expected provider",
                        "value": "Google Maps",
                    },
                )
        except Exception as exc:
            provider_status = "warning"
            provider_message = "Google routing provider not reachable"
            provider_details.append({"label": "Error", "value": str(exc)})

    if using_google:
        nominatim_status = "healthy"
        nominatim_message = "Skipped (Google provider enabled)"
        nominatim_details = [
            {"label": "Provider", "value": "Google Maps"},
            {"label": "Local service", "value": "Not required"},
        ]
        valhalla_status = "healthy"
        valhalla_message = "Skipped (Google provider enabled)"
        valhalla_details = [
            {"label": "Provider", "value": "Google Maps"},
            {"label": "Local service", "value": "Not required"},
        ]
        nominatim_container_running = False
        nominatim_has_data = False
        valhalla_container_running = False
        valhalla_has_data = False
    else:
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
        nominatim_details = _format_geo_details(
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
        valhalla_details = _format_geo_details(
            geo_health.valhalla_container_running,
            geo_health.valhalla_has_data,
        )
        nominatim_container_running = geo_health.nominatim_container_running
        nominatim_has_data = geo_health.nominatim_has_data
        valhalla_container_running = geo_health.valhalla_container_running
        valhalla_has_data = geo_health.valhalla_has_data

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
            "details": mongo_details,
        },
        "redis": {
            "status": redis_status,
            "label": _status_label(redis_status),
            "message": redis_message,
            "details": redis_details,
        },
        "worker": {
            "status": worker_status,
            "label": _status_label(worker_status),
            "message": worker_message,
            "details": worker_details,
        },
        "nominatim": {
            "status": nominatim_status,
            "label": _status_label(nominatim_status),
            "message": nominatim_message,
            "details": nominatim_details,
            "container_running": nominatim_container_running,
            "has_data": nominatim_has_data,
            "skipped": using_google,
        },
        "valhalla": {
            "status": valhalla_status,
            "label": _status_label(valhalla_status),
            "message": valhalla_message,
            "details": valhalla_details,
            "container_running": valhalla_container_running,
            "has_data": valhalla_has_data,
            "skipped": using_google,
        },
        "bouncie": {
            "status": bouncie_status,
            "label": bouncie_label,
            "message": bouncie_message,
            "details": bouncie_details,
        },
        "mapping_provider": {
            "status": provider_status,
            "label": _status_label(provider_status),
            "message": provider_message,
            "details": provider_details,
            "provider": map_provider,
        },
    }

    statuses = [
        entry["status"]
        for entry in service_statuses.values()
        if not entry.get("skipped")
    ]
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
    allowed = {"nominatim", "valhalla", "mongo", "redis", "worker", "app"}
    if (
        service_name not in allowed
        and not service_name.startswith("everystreet-")
        and service_name != "web"
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Unsupported service", "code": "invalid_service"},
        )

    container_map = {
        "nominatim": "nominatim",
        "valhalla": "valhalla",
        "mongodb": "mongo",
        "redis": "redis",
        "worker": "worker",
        "app": "app",
        "bouncie": "app",
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
