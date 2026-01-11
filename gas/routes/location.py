"""API routes for vehicle location and odometer estimation."""

import logging
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query

from gas.services import OdometerService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/vehicle-location")
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
    try:
        return await OdometerService.get_vehicle_location_at_time(
            imei,
            timestamp,
            use_now,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error getting vehicle location: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/vehicles/estimate-odometer")
async def estimate_odometer_reading(
    imei: Annotated[str, Query(description="Vehicle IMEI")],
    timestamp: Annotated[str, Query(description="ISO datetime to estimate at")],
) -> dict[str, Any]:
    """Estimate odometer reading by interpolating/extrapolating from nearest known
    anchors.
    """
    try:
        return await OdometerService.estimate_odometer_reading(imei, timestamp)

    except Exception as e:
        logger.exception("Error estimating odometer: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
