"""API routes for dashboard analytics and insights."""

import logging

from fastapi import APIRouter, HTTPException, Request, status

from analytics.services import DashboardService
from db import build_query_from_request
from core.trip_source_policy import enforce_bouncie_source

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/driving-insights")
async def get_driving_insights(request: Request):
    """Get aggregated driving insights."""
    try:
        query = await build_query_from_request(request)
        query = enforce_bouncie_source(query)
        return await DashboardService.get_driving_insights(query)
    except Exception as e:
        logger.exception("Error in get_driving_insights")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/metrics")
async def get_metrics(request: Request):
    """Get trip metrics and statistics using database aggregation."""
    try:
        query = await build_query_from_request(request)
        query = enforce_bouncie_source(query)
        return await DashboardService.get_metrics(query)
    except Exception as e:
        logger.exception("Error in get_metrics")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
