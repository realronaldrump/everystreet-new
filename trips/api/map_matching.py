"""API routes for map matching jobs."""

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from core.api import api_route
from trips.models import MapMatchJobRequest
from trips.services.map_matching_jobs import MapMatchingJobService

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
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
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


@router.delete("/api/map_matching/jobs", response_model=dict[str, object])
@api_route(logger)
async def clear_map_matching_history(
    include_active: Annotated[bool, Query()] = False,
):
    """Delete map matching job history entries."""
    try:
        return await service.clear_history(include_active=include_active)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to clear map matching history")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@router.post("/api/map_matching/jobs/preview", response_model=dict[str, object])
@api_route(logger)
async def preview_map_matching_jobs(
    request: MapMatchJobRequest,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
):
    """Preview trips that would be matched by a job request."""
    try:
        return await service.preview(request, limit=limit)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to preview map matching job")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@router.delete("/api/map_matching/jobs/{job_id}", response_model=dict[str, object])
@api_route(logger)
async def delete_map_matching_job(
    job_id: str,
    force: Annotated[bool, Query()] = False,
):
    """Delete a map matching job entry from history."""
    try:
        return await service.delete_job(job_id, allow_active=force)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to delete map matching job")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@router.post("/api/map_matching/jobs/{job_id}/cancel", response_model=dict[str, object])
@api_route(logger)
async def cancel_map_matching_job(
    job_id: str,
):
    """Cancel a running map matching job."""
    try:
        return await service.cancel_job(job_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to cancel map matching job")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@router.get("/api/map_matching/jobs/{job_id}/matches", response_model=dict[str, object])
@api_route(logger)
async def preview_map_matching_results(
    job_id: str,
    limit: Annotated[int, Query(ge=1, le=300)] = 120,
):
    """Preview matched trips for a completed job."""
    try:
        return await service.preview_matches(job_id, limit=limit)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to preview map matching results")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )
