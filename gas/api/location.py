"""API routes for vehicle location and odometer estimation."""

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Query

from core.api import api_route
from gas.services import OdometerService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/vehicle-location")
@api_route(logger)
async def get_vehicle_location_at_time(
    imei: Annotated[str, Query(description="Vehicle IMEI")],
    timestamp: Annotated[
        str | None,
        Query(description="ISO datetime to lookup"),
    ] = None,
    use_now: Annotated[
        bool,
        Query(description="Use last known location instead of timestamp"),
    ] = False,
) -> dict[str, Any]:
    """Get vehicle location and odometer at a specific time."""
    return await OdometerService.get_vehicle_location_at_time(
        imei,
        timestamp,
        use_now,
    )


@router.get("/api/vehicles/estimate-odometer")
@api_route(logger)
async def estimate_odometer_reading(
    imei: Annotated[str, Query(description="Vehicle IMEI")],
    timestamp: Annotated[str, Query(description="ISO datetime to estimate at")],
) -> dict[str, Any]:
    """Estimate odometer reading by interpolating/extrapolating from nearest known
    anchors.
    """
    return await OdometerService.estimate_odometer_reading(imei, timestamp)
