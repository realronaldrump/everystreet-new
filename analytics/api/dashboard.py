"""API routes for dashboard analytics and insights."""

import logging

from fastapi import APIRouter, HTTPException, Request, status

from analytics.services import DashboardService
from core.cache import cached
from core.trip_source_policy import enforce_bouncie_source
from db import build_query_from_request

logger = logging.getLogger(__name__)
router = APIRouter()


@cached("driving_insights", ttl_seconds=300)
async def _driving_insights_cached(query: dict):
    return await DashboardService.get_driving_insights(query)


@cached("metrics", ttl_seconds=300)
async def _metrics_cached(query: dict):
    return await DashboardService.get_metrics(query)


@router.get("/api/driving-insights")
async def get_driving_insights(request: Request):
    """Get aggregated driving insights."""
    try:
        query = await build_query_from_request(request)
        query = enforce_bouncie_source(query)
        query["invalid"] = {"$ne": True}
        return await _driving_insights_cached(query)
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
        query["invalid"] = {"$ne": True}
        return await _metrics_cached(query)
    except Exception as e:
        logger.exception("Error in get_metrics")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
