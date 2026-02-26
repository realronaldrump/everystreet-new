"""API routes for trip analytics."""

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status

from analytics.services import (
    DrilldownService,
    TimeAnalyticsService,
    TripAnalyticsService,
)
from core.api import api_route
from core.cache import cached
from core.trip_source_policy import enforce_bouncie_source
from db import build_query_from_request

logger = logging.getLogger(__name__)
router = APIRouter()


@cached("trip_analytics", ttl_seconds=600)
async def _trip_analytics_cached(query: dict):
    return await TripAnalyticsService.get_trip_analytics(query)


@cached("driver_behavior", ttl_seconds=600)
async def _driver_behavior_cached(query: dict):
    return await TripAnalyticsService.get_driver_behavior_analytics(query)


@router.get("/api/trip-analytics")
@api_route(logger)
async def get_trip_analytics(request: Request):
    """Get analytics on trips over time."""
    query = await build_query_from_request(request)
    query = enforce_bouncie_source(query)

    if "$expr" not in query and (
        request.query_params.get("start_date") is None
        or request.query_params.get("end_date") is None
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing date range",
        )

    return await _trip_analytics_cached(query)


@router.get("/api/time-period-trips")
@api_route(logger)
async def get_time_period_trips(request: Request):
    """Get trips for a specific time period (hour or day of week)."""
    query = await build_query_from_request(request)
    query = enforce_bouncie_source(query)

    time_type = request.query_params.get("time_type")
    time_value = request.query_params.get("time_value")

    if not time_type or time_value is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing time_type or time_value parameter",
        )

    try:
        time_value = int(time_value)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="time_value must be an integer",
        )

    try:
        return await TimeAnalyticsService.get_time_period_trips(
            query,
            time_type,
            time_value,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.get("/api/drilldown-trips")
@api_route(logger)
async def get_drilldown_trips(request: Request):
    """Get a small list of trips for drill-down insights modals."""
    query = await build_query_from_request(request)
    query = enforce_bouncie_source(query)

    kind = request.query_params.get("kind", "trips")
    limit_raw = request.query_params.get("limit", "100")

    try:
        limit = int(limit_raw)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="limit must be an integer",
        )

    try:
        return await DrilldownService.get_drilldown_trips(query, kind, limit)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.get("/api/driver-behavior")
@api_route(logger)
async def driver_behavior_analytics(request: Request):
    """
    Aggregate driving behavior statistics within optional date range filters.

    Accepts the same `start_date` and `end_date` query parameters used by other API endpoints.
    If no filters are provided, all trips are considered.
    """
    query = await build_query_from_request(request)
    query = enforce_bouncie_source(query)
    return await _driver_behavior_cached(query)


@router.get("/api/trips/history")
@api_route(logger)
async def get_recent_trips(
    limit: Annotated[
        int,
        Query(ge=1, le=100, description="Number of trips to return"),
    ] = 5,
):
    """Get recent trips for landing page activity feed."""
    trips = await TripAnalyticsService.get_recent_trips(limit)
    return {"trips": trips}
