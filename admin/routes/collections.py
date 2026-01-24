from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from admin.services.admin_service import COLLECTION_TO_MODEL, AdminService
from core.api import api_route

logger = logging.getLogger(__name__)
router = APIRouter()

_COLLECTION_KEYS = ("collection", "collection_name", "collectionName", "name")


def _extract_collection(payload: Any) -> str | None:
    if isinstance(payload, dict):
        for key in _COLLECTION_KEYS:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for key in _COLLECTION_KEYS:
            value = payload.get(key)
            if value is not None:
                return str(value)
        return None
    if isinstance(payload, str) and payload.strip():
        return payload.strip()
    return None


@router.post("/api/database/clear-collection", response_model=dict[str, Any])
@api_route(logger)
async def clear_collection(request: Request) -> dict[str, Any]:
    """Clear a known MongoDB collection via its registered model."""
    payload: Any = None
    raw_body = await request.body()
    if raw_body:
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            payload = raw_body.decode(errors="ignore").strip()

    name = _extract_collection(payload)
    if not name:
        for key in _COLLECTION_KEYS:
            value = request.query_params.get(key)
            if value and value.strip():
                name = value.strip()
                break

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
