"""API routes for map matching jobs."""

import logging

from fastapi import APIRouter, HTTPException, Query, status

from core.api import api_route
from map_matching.schemas import MapMatchJobRequest
from map_matching.service import MapMatchingJobService

logger = logging.getLogger(__name__)
router = APIRouter()

service = MapMatchingJobService()


@router.post("/api/map_matching/jobs", response_model=dict[str, object])
@api_route(logger)
async def create_map_matching_job(request: MapMatchJobRequest):
    """Queue a new map matching job."""
    try:
        return await service.enqueue_job(request, source="manual")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to enqueue map matching job")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@router.get("/api/map_matching/jobs/{job_id}", response_model=dict[str, object])
@api_route(logger)
async def get_map_matching_job(job_id: str):
    """Retrieve progress for a map matching job."""
    try:
        return await service.get_job(job_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to fetch map matching job")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@router.get("/api/map_matching/jobs", response_model=dict[str, object])
@api_route(logger)
async def list_map_matching_jobs(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """List recent map matching jobs."""
    try:
        return await service.list_jobs(limit=limit, offset=offset)
    except Exception as exc:
        logger.exception("Failed to list map matching jobs")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )
