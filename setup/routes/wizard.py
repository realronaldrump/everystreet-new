from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from core.api import api_route
from setup.services.setup_service import SetupService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["setup"])


@router.get("/setup/status", response_model=dict[str, Any])
@api_route(logger)
async def get_setup_status_endpoint() -> dict[str, Any]:
    """Return overall setup completion status and step details."""
    return await SetupService.get_setup_status()


@router.post("/setup/complete", response_model=dict[str, Any])
@api_route(logger)
async def complete_setup() -> dict[str, Any]:
    """Finalize setup and enable background tasks."""
    return await SetupService.complete_setup()
