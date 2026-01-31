from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Query

from core.api import api_route
from driving.services.driving_service import DrivingNavigationRequest, DrivingService

if TYPE_CHECKING:
    from beanie import PydanticObjectId

logger = logging.getLogger(__name__)
router = APIRouter(tags=["driving"])


@router.post("/api/driving-navigation/next-route", response_model=dict[str, Any])
@api_route(logger)
async def get_next_driving_navigation_route(
    payload: DrivingNavigationRequest,
) -> dict[str, Any]:
    """Find a route to the nearest undriven street (or a specific segment)."""
    return await DrivingService.get_next_driving_navigation_route(payload)


@router.get(
    "/api/driving-navigation/suggest-next-street/{area_id}",
    response_model=dict[str, Any],
)
@api_route(logger)
async def suggest_next_street(
    area_id: PydanticObjectId,
    current_lat: Annotated[float, Query()],
    current_lon: Annotated[float, Query()],
    top_n: Annotated[int, Query()] = 3,
    min_cluster_size: Annotated[int, Query()] = 2,
) -> dict[str, Any]:
    """Suggest efficient clusters of undriven streets."""
    return await DrivingService.suggest_next_street(
        area_id,
        current_lat,
        current_lon,
        top_n,
        min_cluster_size,
    )
