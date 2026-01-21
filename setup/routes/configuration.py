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
