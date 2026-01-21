from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status

from admin.services.admin_service import AdminService, COLLECTION_TO_MODEL
from core.api import api_route
from db.schemas import CollectionModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/database/clear-collection", response_model=dict[str, Any])
@api_route(logger)
async def clear_collection(data: CollectionModel) -> dict[str, Any]:
    """Clear a known MongoDB collection via its registered model."""
    name = data.collection
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing 'collection' field",
        )

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
    """Return storage usage metadata for the database."""
    try:
        return await AdminService.get_storage_info()
    except Exception as exc:
        logger.exception("Error getting storage info")
        return {
            "used_mb": 0,
            "error": str(exc),
        }
