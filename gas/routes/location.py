"""API routes for vehicle location and odometer estimation."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from gas.services import OdometerService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/vehicle-location")
async def get_vehicle_location_at_time(
    imei: str = Query(..., description="Vehicle IMEI"),
    timestamp: str | None = Query(None, description="ISO datetime to lookup"),
    use_now: bool = Query(
        False, description="Use last known location instead of timestamp"
    ),
) -> dict[str, Any]:
    """Get vehicle location and odometer at a specific time."""
    try:
        location_data = await OdometerService.get_vehicle_location_at_time(
            imei, timestamp, use_now
        )
        return location_data

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error getting vehicle location: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/vehicles/estimate-odometer")
async def estimate_odometer_reading(
    imei: str = Query(..., description="Vehicle IMEI"),
    timestamp: str = Query(..., description="ISO datetime to estimate at"),
) -> dict[str, Any]:
    """Estimate odometer reading by interpolating/extrapolating from nearest known anchors."""
    try:
        result = await OdometerService.estimate_odometer_reading(imei, timestamp)
        return result

    except Exception as e:
        logger.error("Error estimating odometer: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
