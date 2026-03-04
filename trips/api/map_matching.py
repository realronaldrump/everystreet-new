"""API routes for map matching jobs."""

import logging
from typing import Annotated

from fastapi import APIRouter, Query

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
    return await service.enqueue_job(request, source="manual")


@router.get("/api/map_matching/jobs/{job_id}", response_model=dict[str, object])
@api_route(logger)
async def get_map_matching_job(job_id: str):
    """Retrieve progress for a map matching job."""
    return await service.get_job(job_id)


@router.get("/api/map_matching/jobs", response_model=dict[str, object])
@api_route(logger)
async def list_map_matching_jobs(
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """List recent map matching jobs."""
    return await service.list_jobs(limit=limit, offset=offset)


@router.delete("/api/map_matching/jobs", response_model=dict[str, object])
@api_route(logger)
async def clear_map_matching_history(
    include_active: Annotated[bool, Query()] = False,
):
    """Delete map matching job history entries."""
    return await service.clear_history(include_active=include_active)


@router.post("/api/map_matching/jobs/preview", response_model=dict[str, object])
@api_route(logger)
async def preview_map_matching_jobs(
    request: MapMatchJobRequest,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
):
    """Preview trips that would be matched by a job request."""
    return await service.preview(request, limit=limit)


@router.delete("/api/map_matching/jobs/{job_id}", response_model=dict[str, object])
@api_route(logger)
async def delete_map_matching_job(
    job_id: str,
    force: Annotated[bool, Query()] = False,
):
    """Delete a map matching job entry from history."""
    return await service.delete_job(job_id, allow_active=force)


@router.post("/api/map_matching/jobs/{job_id}/cancel", response_model=dict[str, object])
@api_route(logger)
async def cancel_map_matching_job(job_id: str):
    """Cancel a running map matching job."""
    return await service.cancel_job(job_id)


@router.get("/api/map_matching/jobs/{job_id}/matches", response_model=dict[str, object])
@api_route(logger)
async def preview_map_matching_results(
    job_id: str,
    limit: Annotated[int, Query(ge=1, le=300)] = 120,
):
    """Preview matched trips for a completed job."""
    return await service.preview_matches(job_id, limit=limit)
