"""API routes for trip export and bounds querying."""

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from core.api import api_route
from trips.services import TripQueryService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/trips_in_bounds", tags=["Trips API"])
@api_route(logger)
async def get_trips_in_bounds(
    min_lat: Annotated[
        float,
        Query(description="Minimum latitude of the bounding box"),
    ],
    min_lon: Annotated[
        float,
        Query(description="Minimum longitude of the bounding box"),
    ],
    max_lat: Annotated[
        float,
        Query(description="Maximum latitude of the bounding box"),
    ],
    max_lon: Annotated[
        float,
        Query(description="Maximum longitude of the bounding box"),
    ],
):
    """
    Get raw or matched trip coordinates within a given bounding box.

    Uses a spatial query for efficiency. Queries the single trips
    collection.
    """
    try:
        return await TripQueryService.get_trips_in_bounds(
            min_lat,
            min_lon,
            max_lat,
            max_lon,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error in get_trips_in_bounds: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve trips within bounds: {e}",
        )
