"""Map services API endpoints."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from map_data.services import (
    cancel_map_setup,
    configure_map_services,
    get_map_services_status,
)
from map_data.us_states import REGIONS, list_states

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/map-services", tags=["map-services"])


class ConfigureMapServicesRequest(BaseModel):
    states: list[str] = Field(default_factory=list)
    force: bool = False


@router.get("/status")
async def map_services_status() -> dict[str, Any]:
    """Return overall map services status and progress."""
    try:
        return await get_map_services_status()
    except Exception as exc:
        logger.exception("Failed to fetch map services status")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch status: {exc!s}",
        )


@router.get("/states")
async def list_us_states() -> dict[str, Any]:
    """Return the static US state catalog for coverage selection."""
    return {
        "success": True,
        "states": list_states(),
        "regions": REGIONS,
    }


@router.post("/configure")
async def configure_map_services_endpoint(
    payload: ConfigureMapServicesRequest,
) -> dict[str, Any]:
    """Start the unified setup pipeline for selected states."""
    try:
        return await configure_map_services(payload.states, force=payload.force)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to configure map services")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to configure map services: {exc!s}",
        )


@router.post("/cancel")
async def cancel_map_services_setup() -> dict[str, Any]:
    """Cancel the current map setup pipeline."""
    try:
        return await cancel_map_setup()
    except Exception as exc:
        logger.exception("Failed to cancel map setup")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to cancel map setup: {exc!s}",
        )

