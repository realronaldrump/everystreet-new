"""API routes for visit-related endpoints."""

import logging

from fastapi import APIRouter, HTTPException, status

from core.api import api_route
from db.schemas import NonCustomPlaceVisit, PlaceVisitsResponse
from visits.services import PlaceService, VisitStatsService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/places/{place_id}/trips", response_model=PlaceVisitsResponse)
@api_route(logger)
async def get_trips_for_place(place_id: str):
    """Get trips that visited a specific place, with corrected duration logic."""
    place = await PlaceService.get_place_by_id(place_id)
    if not place:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place not found",
        )
    return await VisitStatsService.get_trips_for_place(place)


@router.get("/api/non_custom_places_visits", response_model=list[NonCustomPlaceVisit])
@api_route(logger)
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
    return await VisitStatsService.get_non_custom_places_visits(timeframe)
