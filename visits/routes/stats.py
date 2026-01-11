"""API routes for visit statistics and suggestions."""

import logging

from fastapi import APIRouter, HTTPException, Query, status

from db.schemas import PlaceStatisticsResponse, VisitSuggestion
from visits.services import PlaceService, VisitStatsService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/places/{place_id}/statistics", response_model=PlaceStatisticsResponse)
async def get_place_statistics(place_id: str):
    """Get statistics about visits to a place using robust calculation."""
    try:
        place = await PlaceService.get_place_by_id(place_id)
        if not place:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Place not found",
            )

        return await VisitStatsService.get_place_statistics(place)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error getting place statistics for %s: %s", place_id, e)
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
        logger.exception("Error in get_all_places_statistics: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/visit_suggestions", response_model=list[VisitSuggestion])
async def get_visit_suggestions(
    min_visits: int = Query(5, description="Minimum number of visits"),
    cell_size_m: int = Query(250, description="Grid cell size in meters"),
    timeframe: str | None = Query(None, description="Optional timeframe filter"),
):
    """Suggest areas that are visited often but are not yet custom places.

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
            min_visits, cell_size_m, timeframe
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error generating visit suggestions: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
