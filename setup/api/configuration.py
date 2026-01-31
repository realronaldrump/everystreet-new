from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from admin.services.admin_service import AdminService
from core.api import api_route
from core.repo_info import get_repo_version_info
from logs.api import list_docker_containers
from map_data.services import get_map_services_status
from setup.services.setup_service import SetupService
from tasks.api import _build_task_snapshot

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["setup-config"])


@router.get("/status/health", response_model=dict[str, Any])
@api_route(logger)
async def get_service_health() -> dict[str, Any]:
    """Return aggregated health status for geo services and dependencies."""
    return await SetupService.get_service_health()


@router.get("/status/overview", response_model=dict[str, Any])
@api_route(logger)
async def get_status_overview() -> dict[str, Any]:
    """Return a summarized operations overview for the status dashboard."""
    health = await SetupService.get_service_health()
    map_services = await get_map_services_status(force_refresh=True)
    tasks_snapshot = await _build_task_snapshot()
    setup_status = await SetupService.get_setup_status()

    tasks = tasks_snapshot.get("tasks", {}) if isinstance(tasks_snapshot, dict) else {}
    statuses = [task.get("status") for task in tasks.values() if task]
    running_count = sum(1 for status in statuses if status in {"RUNNING", "PENDING"})
    failed_count = sum(1 for status in statuses if status == "FAILED")

    storage = await AdminService.get_storage_info()

    docker_available = False
    docker_detail = ""
    container_count = 0
    try:
        container_payload = await list_docker_containers()
        containers = container_payload.get("containers", [])
        container_count = len(containers)
        docker_available = True
    except Exception as exc:
        docker_detail = str(exc)

    bouncie_step = setup_status.get("steps", {}).get("bouncie", {})
    integrations_summary = (
        "Bouncie connected" if bouncie_step.get("complete") else "Bouncie needs setup"
    )

    version_info = get_repo_version_info()

    return {
        "overall": {
            "status": health.get("overall", {}).get("status"),
            "label": health.get("overall", {}).get("status", "").upper() or "UNKNOWN",
            "message": health.get("overall", {}).get("message"),
            "last_updated": health.get("overall", {}).get("last_updated"),
        },
        "services": health.get("services", {}),
        "recent_errors": health.get("recent_errors", []),
        "map_services": map_services,
        "tasks": {
            "summary": {
                "total": len(tasks),
                "running": running_count,
                "failed": failed_count,
                "disabled": bool(tasks_snapshot.get("disabled"))
                if isinstance(tasks_snapshot, dict)
                else False,
            },
            "config": tasks_snapshot,
        },
        "storage": storage,
        "docker": {
            "available": docker_available,
            "container_count": container_count,
            "detail": docker_detail
            or ("Docker online" if docker_available else "Docker unavailable"),
        },
        "integrations": {
            "summary": integrations_summary,
            "detail": "Manage integrations in the setup wizard.",
        },
        "setup": setup_status,
        "app": {
            "version": f"{version_info.commit_hash} - {version_info.last_updated}",
            "commit_hash": version_info.commit_hash,
            "commit_count": version_info.commit_count,
            "last_updated": version_info.last_updated,
        },
        "last_updated": health.get("overall", {}).get("last_updated"),
    }


@router.post("/services/{service_name}/restart", response_model=dict[str, Any])
@api_route(logger)
async def restart_service(service_name: str) -> dict[str, Any]:
    """Restart a geo service container (Valhalla/Nominatim)."""
    return await SetupService.restart_service(service_name)


@router.get("/status/logs/{service_name}", response_model=dict[str, Any])
@api_route(logger)
async def get_service_logs(service_name: str) -> dict[str, Any]:
    """Get recent logs for a service."""
    return await SetupService.get_service_logs(service_name)


@router.post("/admin/tasks/{task_id}/run", response_model=dict[str, Any])
@api_route(logger)
async def trigger_task(task_id: str) -> dict[str, Any]:
    """Manually trigger a background task."""
    return await SetupService.trigger_task(task_id)
