from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Body, HTTPException

from admin.services.admin_service import (
    MAPBOX_SETTINGS_ERROR,
    AdminService,
)
from core.api import api_route
from db.models import AppSettings

if TYPE_CHECKING:
    from db.schemas import ValidateLocationModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get(
    "/api/app_settings",
    response_model=AppSettings,
    response_model_exclude={"id"},
    summary="Get Application Settings",
    description="Retrieve persisted application-wide settings.",
)
@api_route(logger)
async def get_app_settings_endpoint() -> dict[str, Any]:
    """Get persisted application settings."""
    return await AdminService.get_app_settings_payload()


@router.post(
    "/api/app_settings",
    response_model=AppSettings,
    response_model_exclude={"id"},
    summary="Update Application Settings",
    description="Persist application settings. Fields omitted in payload remain unchanged.",
)
@api_route(logger)
async def update_app_settings_endpoint(
    settings: Annotated[dict, Body()],
) -> AppSettings:
    """Persist application settings changes."""
    if not isinstance(settings, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")
    # Mapbox token is immutable and cannot be updated through this endpoint.
    if "mapbox_access_token" in settings or "mapbox_token" in settings:
        raise HTTPException(
            status_code=400,
            detail=MAPBOX_SETTINGS_ERROR,
        )

    return await AdminService.update_app_settings(settings)


@router.post("/api/validate_location", response_model=dict[str, Any])
@api_route(logger)
async def validate_location(
    data: ValidateLocationModel,
) -> dict[str, Any]:
    """Validate a location via OSM-backed lookup."""
    return await AdminService.validate_location(
        data.location,
        data.locationType,
    )


@router.get("/api/first_trip_date", response_model=dict[str, str])
@api_route(logger)
async def get_first_trip_date() -> dict[str, str]:
    """Return the earliest trip date in ISO format."""
    return await AdminService.get_first_trip_date()
