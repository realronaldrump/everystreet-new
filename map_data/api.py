"""Map services API endpoints."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from map_data.auto_provision import (
    auto_provision_map_data,
    detect_trip_states,
    get_auto_provision_status,
)
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


@router.get("/auto-status")
async def get_auto_status() -> dict[str, Any]:
    """
    Get automatic provisioning status.

    Returns comprehensive status for the hands-off map services UI,
    including detected trip states, configured states, and service
    health.
    """
    try:
        return await get_auto_provision_status()
    except Exception as exc:
        logger.exception("Failed to get auto-provision status")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get status: {exc!s}",
        )


@router.get("/detect-states")
async def detect_states_from_trips() -> dict[str, Any]:
    """
    Detect which US states contain trip data.

    Analyzes trip GPS coordinates to determine which states the user has
    traveled in.
    """
    try:
        return await detect_trip_states()
    except Exception as exc:
        logger.exception("Failed to detect trip states")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to detect states: {exc!s}",
        )


@router.post("/auto-provision")
async def trigger_auto_provision() -> dict[str, Any]:
    """
    Trigger automatic map data provisioning.

    Detects states from trip data and configures map services for all
    detected states that aren't already configured.
    """
    try:
        return await auto_provision_map_data()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to auto-provision map data")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to provision: {exc!s}",
        )
