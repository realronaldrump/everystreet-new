"""API routes for visit statistics and suggestions."""

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from db.schemas import PlaceStatisticsResponse, VisitSuggestion
from visits.services import PlaceService, VisitStatsService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/places/{place_id}/statistics", response_model=PlaceStatisticsResponse)
async def get_place_statistics(place_id: str):
    """Get statistics about visits to a place using robust calculation."""
    place = await PlaceService.get_place_by_id(place_id)
    if not place:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place not found",
        )

    try:
        return await VisitStatsService.get_place_statistics(place)
    except Exception as e:
        logger.exception("Error getting place statistics for %s", place_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/places/statistics", response_model=list[PlaceStatisticsResponse])
async def get_all_places_statistics():
    """Get statistics for all custom places using robust, efficient calculation."""
    try:
        return await VisitStatsService.get_all_places_statistics()
    except Exception as e:
        logger.exception("Error in get_all_places_statistics")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/visit_suggestions", response_model=list[VisitSuggestion])
async def get_visit_suggestions(
    min_visits: Annotated[int, Query(description="Minimum number of visits")] = 5,
    cell_size_m: Annotated[int, Query(description="Grid cell size in meters")] = 250,
    timeframe: Annotated[
        str | None,
        Query(description="Optional timeframe filter"),
    ] = None,
):
    """
    Suggest areas that are visited often but are not yet custom places.

    This endpoint groups trip destinations without destinationPlaceId
    by a spatial grid (default ~250m x 250m) and returns any cells that have
    at least min_visits visits.  It supports an optional rolling
    timeframe (day/week/month/year) similar to other endpoints.

    The response is a list of dictionaries:

        [
            {
              "suggestedName": "Downtown Coffee Strip",
              "totalVisits": 17,
              "firstVisit": "…",
              "lastVisit": "…",
              "centroid": [lng, lat],
              "boundary": { …GeoJSON Polygon… }
            },
            …
        ]

    where boundary is a square cell polygon the frontend can edit/fine-tune
    before saving as a real custom place.
    """
    try:
        return await VisitStatsService.get_visit_suggestions(
            min_visits,
            cell_size_m,
            timeframe,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error generating visit suggestions")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
