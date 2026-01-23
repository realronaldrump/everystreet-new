from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from core.api import api_route
from setup.services.setup_service import SetupService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["setup-config"])


@router.get("/status/health", response_model=dict[str, Any])
@api_route(logger)
async def get_service_health() -> dict[str, Any]:
    """Return aggregated health status for geo services and dependencies."""
    return await SetupService.get_service_health()


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
