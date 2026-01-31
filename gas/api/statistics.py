"""API routes for gas statistics and vehicle synchronization."""

import logging
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query

from gas.services import StatisticsService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/gas-statistics")
async def get_gas_statistics(
    imei: Annotated[str | None, Query(description="Filter by vehicle IMEI")] = None,
    start_date: Annotated[str | None, Query(description="Start date filter")] = None,
    end_date: Annotated[str | None, Query(description="End date filter")] = None,
) -> dict[str, Any]:
    """Get gas consumption statistics."""
    try:
        return await StatisticsService.get_gas_statistics(imei, start_date, end_date)

    except Exception as e:
        logger.exception("Error calculating gas statistics")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/vehicles/sync-from-trips")
async def sync_vehicles_from_trips() -> dict[str, Any]:
    """Sync vehicles from trip data - creates vehicle records with VIN info from trips."""
    try:
        return await StatisticsService.sync_vehicles_from_trips()

    except Exception as e:
        logger.exception("Error syncing vehicles")
        raise HTTPException(status_code=500, detail=str(e))
