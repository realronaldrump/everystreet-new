from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from admin.services.admin_service import COLLECTION_TO_MODEL, AdminService
from core.api import api_route

logger = logging.getLogger(__name__)
router = APIRouter()

_COLLECTION_KEYS = ("collection", "collection_name", "collectionName", "name")


class ClearCollectionRequest(BaseModel):
    collection: str = Field(..., description="Name of the collection to clear")


@router.post("/api/database/clear-collection", response_model=dict[str, Any])
@api_route(logger)
async def clear_collection(payload: ClearCollectionRequest) -> dict[str, Any]:
    """Clear a known MongoDB collection via its registered model."""
    name = payload.collection

    if name not in COLLECTION_TO_MODEL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Unknown collection "
                f"'{name}'. Supported: {list(COLLECTION_TO_MODEL.keys())}"
            ),
        )

    return await AdminService.clear_collection(name)


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
    """Return storage usage metadata for the application."""
    try:
        return await AdminService.get_storage_info()
    except Exception as exc:
        logger.exception("Error getting storage summary")
        return {
            "used_mb": 0,
            "error": str(exc),
        }
