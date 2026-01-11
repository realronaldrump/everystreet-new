"""API routes for gas statistics and vehicle synchronization."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from gas.services import StatisticsService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/gas-statistics")
async def get_gas_statistics(
    imei: str | None = Query(None, description="Filter by vehicle IMEI"),
    start_date: str | None = Query(None, description="Start date filter"),
    end_date: str | None = Query(None, description="End date filter"),
) -> dict[str, Any]:
    """Get gas consumption statistics."""
    try:
        stats = await StatisticsService.get_gas_statistics(imei, start_date, end_date)
        return stats

    except Exception as e:
        logger.error("Error calculating gas statistics: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/vehicles/sync-from-trips")
async def sync_vehicles_from_trips() -> dict[str, Any]:
    """Sync vehicles from trip data - creates vehicle records with VIN info from trips."""
    try:
        result = await StatisticsService.sync_vehicles_from_trips()
        return result

    except Exception as e:
        logger.error("Error syncing vehicles: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/trip-gas-cost")
async def calculate_trip_gas_cost(
    trip_id: str = Query(..., description="Trip transaction ID or ObjectId"),
    imei: str | None = Query(None, description="Vehicle IMEI"),
) -> dict[str, Any]:
    """Calculate the gas cost for a specific trip based on latest fill-up prices."""
    try:
        result = await StatisticsService.calculate_trip_gas_cost(trip_id, imei)
        return result

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("Error calculating trip gas cost: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
