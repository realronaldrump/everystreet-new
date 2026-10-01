"""API routes for visit-related endpoints."""

import logging

from fastapi import APIRouter, HTTPException, status

from core.api import api_route
from db.schemas import PlaceVisitsResponse
from visits.services.place_service import PlaceService
from visits.services.visit_stats_service import VisitStatsService

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
