"""API routes for trip statistics and geocoding operations."""

import logging

from fastapi import APIRouter, HTTPException, status

from config import get_mapbox_token
from core.api import api_route
from models import DateRangeModel
from trip_service import TripService
from trips.services import TripStatsService

logger = logging.getLogger(__name__)
router = APIRouter()

# Initialize TripService and TripStatsService
trip_service = TripService(get_mapbox_token())
trip_stats_service = TripStatsService(trip_service)


@router.post("/api/geocode_trips", tags=["Trips API"])
async def geocode_trips(data: DateRangeModel | None = None):
    """Unified endpoint to re-geocode trips within a date range with progress tracking.

    This replaces the old "GeoPoint Update", "Re-geocode All Trips", and
    "Update Geocoding" functionality.
    Only geocodes trips that don't already have addresses, and checks
    against custom places efficiently.
    """
    try:
        start_date = None
        end_date = None
        interval_days = 0

        if data:
            start_date = data.start_date
            end_date = data.end_date
            interval_days = data.interval_days

        result = await trip_stats_service.geocode_trips(
            start_date=start_date,
            end_date=end_date,
            interval_days=interval_days,
        )
        return result

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error in geocode_trips: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error geocoding trips: {e}",
        )


@router.get("/api/geocode_trips/progress/{task_id}", tags=["Trips API"])
@api_route(logger)
async def get_geocode_progress(task_id: str):
    """Get progress for a geocoding task."""
    try:
        result = await trip_stats_service.get_geocode_progress(task_id)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )


@router.post("/api/trips/{trip_id}/regeocode", tags=["Trips API"])
@api_route(logger)
async def regeocode_single_trip(trip_id: str):
    """Re-run geocoding for a single trip.

    Used by the Trips UI when a user clicks
    the per-trip "Refresh Geocoding" button so the trip is re-evaluated against
    any newly-created custom places.
    """
    try:
        result = await trip_stats_service.regeocode_single_trip(trip_id)
        return result
    except ValueError as e:
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(e),
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
