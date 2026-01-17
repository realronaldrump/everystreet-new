"""API routes for visit-related endpoints."""

import logging

from fastapi import APIRouter, HTTPException, status

from db.schemas import NonCustomPlaceVisit, PlaceVisitsResponse
from visits.services import PlaceService, VisitStatsService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/places/{place_id}/trips", response_model=PlaceVisitsResponse)
async def get_trips_for_place(place_id: str):
    """Get trips that visited a specific place, with corrected duration logic."""
    try:
        place = await PlaceService.get_place_by_id(place_id)
        if not place:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Place not found",
            )

        return await VisitStatsService.get_trips_for_place(place)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error getting trips for place %s: %s", place_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/non_custom_places_visits", response_model=list[NonCustomPlaceVisit])
async def get_non_custom_places_visits(timeframe: str | None = None):
    """
    Aggregate visits to non-custom destinations.

    The logic derives a human-readable place name from destination information,
    prioritizing actual place names over addresses:

       1. destinationPlaceName (if present - explicitly set place name)
       2. destination.formatted_address (full address from Nominatim, includes POI names)
       3. destination.address_components.street (street name as last resort)

    Supports an optional timeframe query-param (day | week | month | year).
    When supplied, only trips whose endTime falls inside that rolling window
    are considered.
    """
    try:
        return await VisitStatsService.get_non_custom_places_visits(timeframe)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error getting non-custom places visits: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
