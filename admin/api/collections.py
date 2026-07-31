from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from admin.services.admin_service import AdminService
from core.api import api_route

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/database/storage-info", response_model=dict[str, Any])
@api_route(logger)
async def get_storage_info() -> dict[str, Any]:
    """Return storage usage metadata for the application."""
    try:
        return await AdminService.get_storage_info()
    except Exception as exc:
        logger.exception("Error getting storage info")
        return {
            "used_mb": 0,
            "error": str(exc),
        }


@router.get("/api/storage/summary", response_model=dict[str, Any])
@api_route(logger)
async def get_storage_summary() -> dict[str, Any]:
    """Return storage usage metadata."""
    try:
        return await AdminService.get_storage_summary()
    except Exception as exc:
        logger.exception("Error getting storage summary")
        return {
            "used_mb": 0,
            "error": str(exc),
        }
