"""
Setup and status endpoints for first-run configuration.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import APIRouter, HTTPException, status

from bouncie_credentials import get_bouncie_credentials
from config import validate_mapbox_token
from db.models import AppSettings, MapRegion, TaskConfig, TaskHistory
from map_data.services import (
    check_service_health,
    download_and_build_all,
    suggest_region_from_first_trip,
)
from service_config import clear_config_cache, get_service_config
from tasks.arq import get_arq_pool
from tasks.config import set_global_disable
from tasks.ops import enqueue_task

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["setup"])


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
    for field in ["client_id", "client_secret", "authorization_code", "redirect_uri"]:
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

    region_count = await MapRegion.find_all().count()
    region_complete = region_count > 0

    return {
        "setup_completed": bool(settings.setup_completed),
        "setup_completed_at": (
            settings.setup_completed_at.isoformat()
            if settings.setup_completed_at
            else None
        ),
        "required_complete": bouncie_complete and mapbox_complete,
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
            "region": {
                "complete": region_complete,
                "required": False,
            },
        },
    }


@router.get("/setup/status")
async def get_setup_status_endpoint() -> dict[str, Any]:
    return await get_setup_status()


async def _enable_task(task_id: str, interval_minutes: int) -> None:
    task_config = await TaskConfig.find_one(TaskConfig.task_id == task_id)
    if not task_config:
        task_config = TaskConfig(task_id=task_id)
    task_config.enabled = True
    task_config.interval_minutes = interval_minutes
    task_config.last_updated = datetime.now(UTC)
    task_config.config = task_config.config or {}
    await task_config.save()


@router.post("/setup/complete")
async def complete_setup() -> dict[str, Any]:
    status_payload = await get_setup_status()
    if not status_payload.get("required_complete"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Complete Bouncie credentials and Mapbox token before finishing setup.",
        )

    settings = await _get_or_create_settings()
    settings.setup_completed = True
    settings.setup_completed_at = datetime.now(UTC)
    settings.updated_at = datetime.now(UTC)
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


@router.post("/setup/auto-configure-region")
async def auto_configure_region() -> dict[str, Any]:
    suggestion = await suggest_region_from_first_trip()
    if not suggestion:
        return {
            "success": False,
            "message": "No trips found to suggest a region.",
        }

    try:
        job = await download_and_build_all(
            geofabrik_id=suggestion["id"],
            display_name=suggestion.get("name"),
        )
    except Exception as exc:
        logger.exception("Failed to auto-configure region")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )

    return {
        "success": True,
        "job_id": str(job.id),
        "region": suggestion,
    }


def _status_label(status_value: str) -> str:
    return {
        "healthy": "Healthy",
        "warning": "Warning",
        "error": "Error",
    }.get(status_value, "Unknown")


def _derive_service_status(healthy: bool, error: str | None) -> str:
    if healthy:
        return "healthy"
    if error:
        lowered = error.lower()
        if (
            "not configured" in lowered
            or "not running" in lowered
            or "setup" in lowered
        ):
            return "warning"
    return "error"


@router.get("/status/health")
async def get_status_health() -> dict[str, Any]:
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
                if isinstance(heartbeat, (bytes, bytearray))
                else str(heartbeat)
            )
            heartbeat_dt = None
            try:
                heartbeat_dt = datetime.fromisoformat(heartbeat_value)
            except ValueError:
                worker_detail = "Heartbeat timestamp unreadable"

            if heartbeat_dt is not None:
                age_seconds = (now - cast(datetime, heartbeat_dt)).total_seconds()
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
            "authorization_code",
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
    nominatim_status = _derive_service_status(
        geo_health.nominatim_healthy, geo_health.nominatim_error
    )
    nominatim_message = (
        "Healthy"
        if geo_health.nominatim_healthy
        else geo_health.nominatim_error or "Not ready"
    )
    nominatim_detail = None

    valhalla_status = _derive_service_status(
        geo_health.valhalla_healthy, geo_health.valhalla_error
    )
    valhalla_message = (
        "Healthy"
        if geo_health.valhalla_healthy
        else geo_health.valhalla_error or "Not ready"
    )
    valhalla_detail = None

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
        },
        "valhalla": {
            "status": valhalla_status,
            "label": _status_label(valhalla_status),
            "message": valhalla_message,
            "detail": valhalla_detail,
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
