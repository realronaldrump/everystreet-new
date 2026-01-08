"""API routes for dashboard analytics and insights."""

import logging

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse

from analytics.services import DashboardService
from db import build_query_from_request, serialize_for_json

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/driving-insights")
async def get_driving_insights(request: Request):
    """Get aggregated driving insights."""
    try:
        query = await build_query_from_request(request)
        combined = await DashboardService.get_driving_insights(query)
        return JSONResponse(content=serialize_for_json(combined))
    except Exception as e:
        logger.exception(
            "Error in get_driving_insights: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/metrics")
async def get_metrics(request: Request):
    """Get trip metrics and statistics using database aggregation."""
    try:
        query = await build_query_from_request(request)
        response_content = await DashboardService.get_metrics(query)
        return JSONResponse(content=response_content)

    except Exception as e:
        logger.exception("Error in get_metrics: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
