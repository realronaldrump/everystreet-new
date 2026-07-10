"""Read-only capability and system health endpoints."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from core.api import api_route
from core.repo_info import get_repo_version_info
from db.models import AppSettings
from map_data.services import get_map_services_status
from setup.services.setup_service import SetupService
from tasks.config import get_task_config
from tasks.registry import TASK_DEFINITIONS

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["setup-config"])


@router.get("/status/health", response_model=dict[str, Any])
@api_route(logger)
async def get_service_health() -> dict[str, Any]:
    """Return dependency health without exposing maintenance operations."""
    return await SetupService.get_service_health()


@router.get("/status/overview", response_model=dict[str, Any])
@api_route(logger)
async def get_status_overview() -> dict[str, Any]:
    """Return the system's current convergence state and meaningful actions."""
    health = await SetupService.get_service_health()
    setup_status = await SetupService.get_setup_status()
    app_settings = await AppSettings.find_one()
    map_services = await get_map_services_status(force_refresh=True)
    task_snapshot = await get_task_config()
    tasks = task_snapshot.get("tasks", {})

    running = 0
    recovering = 0
    waiting = 0
    task_rows: list[dict[str, Any]] = []
    for task_id, definition in TASK_DEFINITIONS.items():
        config = tasks.get(task_id) or {}
        status = str(config.get("status") or "idle").upper()
        if status in {"RUNNING", "PENDING"}:
            running += 1
        if config.get("last_error"):
            recovering += 1
        if config.get("waiting_reason"):
            waiting += 1
        task_rows.append(
            {
                "id": task_id,
                "name": definition.get("display_name"),
                "status": status.lower(),
                "last_success": config.get("last_success_time"),
                "last_error": config.get("last_error"),
                "retry_after": config.get("retry_after"),
                "waiting_reason": config.get("waiting_reason"),
            },
        )

    steps = setup_status.get("steps", {})
    bouncie = steps.get("bouncie", {})
    actions: list[dict[str, str]] = []
    if not bouncie.get("complete"):
        actions.append(
            {
                "id": "connect_bouncie",
                "label": "Connect Bouncie",
                "message": "Authorization is required before trip history can sync.",
                "href": "/control-center#connections",
            },
        )
    if (
        app_settings
        and app_settings.map_provider == "google"
        and not app_settings.google_maps_api_key
    ):
        actions.append(
            {
                "id": "connect_google_maps",
                "label": "Add Google Maps key",
                "message": "The selected mapping provider needs an API key.",
                "href": "/control-center#connections",
            },
        )

    service_states = [
        str(item.get("status") or "warning")
        for item in (health.get("services") or {}).values()
        if not item.get("skipped")
    ]
    if actions:
        overall_status = "action_required"
        overall_message = "One decision needs your attention."
    elif recovering or "error" in service_states or "warning" in service_states:
        overall_status = "recovering"
        overall_message = "The system is recovering automatically."
    else:
        overall_status = "healthy"
        overall_message = "Everything is current and running normally."

    version_info = get_repo_version_info()
    return {
        "overall": {
            "status": overall_status,
            "label": overall_status.replace("_", " ").title(),
            "message": overall_message,
            "last_updated": health.get("overall", {}).get("last_updated"),
        },
        "services": health.get("services", {}),
        "automation": {
            "total": len(TASK_DEFINITIONS),
            "running": running,
            "recovering": recovering,
            "waiting": waiting,
            "tasks": task_rows,
        },
        "actions": actions,
        "map_services": map_services,
        "setup": setup_status,
        "app": {
            "version": f"{version_info.commit_hash} - {version_info.last_updated}",
            "commit_hash": version_info.commit_hash,
            "commit_count": version_info.commit_count,
            "last_updated": version_info.last_updated,
        },
        "last_updated": health.get("overall", {}).get("last_updated"),
    }
