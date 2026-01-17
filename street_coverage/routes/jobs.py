"""
Job status API endpoints.

Provides endpoints for checking background job progress.
"""

import logging

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from street_coverage.models import CoverageArea, Job

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["coverage-jobs"])


# =============================================================================
# Response Models
# =============================================================================


class JobStatusResponse(BaseModel):
    """Job status response."""

    success: bool = True
    job_id: str
    job_type: str
    area_id: str | None = None
    area_display_name: str | None = None
    status: str
    stage: str
    progress: float
    message: str
    error: str | None = None

    # Timing
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None


class JobListResponse(BaseModel):
    """Response for listing jobs."""

    success: bool = True
    jobs: list[JobStatusResponse]


# =============================================================================
# Endpoints
# =============================================================================


@router.get("/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: PydanticObjectId):
    """
    Get the status of a background job.

    Poll this endpoint to track progress of:
    - Area ingestion
    - Area rebuilds
    - Route generation
    """
    job = await Job.get(job_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )

    area_id_str = str(job.area_id) if job.area_id else None
    area_display_name = None
    if job.area_id:
        area = await CoverageArea.get(job.area_id)
        area_display_name = area.display_name if area else None

    return JobStatusResponse(
        job_id=str(job.id),
        job_type=job.job_type,
        area_id=area_id_str,
        area_display_name=area_display_name,
        status=job.status,
        stage=job.stage,
        progress=job.progress,
        message=job.message,
        error=job.error,
        created_at=job.created_at.isoformat(),
        started_at=job.started_at.isoformat() if job.started_at else None,
        completed_at=job.completed_at.isoformat() if job.completed_at else None,
    )


@router.get("/areas/{area_id}/jobs", response_model=JobListResponse)
async def get_area_jobs(area_id: PydanticObjectId, limit: int = 10):
    """
    Get recent jobs for a coverage area.

    Returns the most recent jobs, ordered by creation time.
    """
    jobs = (
        await Job.find({"area_id": area_id}).sort("-created_at").limit(limit).to_list()
    )

    area = await CoverageArea.get(area_id)
    area_display_name = area.display_name if area else None

    return JobListResponse(
        jobs=[
            JobStatusResponse(
                job_id=str(job.id),
                job_type=job.job_type,
                area_id=str(job.area_id) if job.area_id else str(area_id),
                area_display_name=area_display_name,
                status=job.status,
                stage=job.stage,
                progress=job.progress,
                message=job.message,
                error=job.error,
                created_at=job.created_at.isoformat(),
                started_at=job.started_at.isoformat() if job.started_at else None,
                completed_at=job.completed_at.isoformat() if job.completed_at else None,
            )
            for job in jobs
        ],
    )


@router.get("/jobs", response_model=JobListResponse)
async def list_active_jobs():
    """
    Get all active (pending or running) jobs.

    Useful for a global status view.
    """
    jobs = (
        await Job.find({"status": {"$in": ["pending", "running"]}})
        .sort("-created_at")
        .to_list()
    )

    area_ids = {job.area_id for job in jobs if job.area_id}
    areas = (
        await CoverageArea.find({"_id": {"$in": list(area_ids)}}).to_list()
        if area_ids
        else []
    )
    area_name_by_id = {str(area.id): area.display_name for area in areas}

    return JobListResponse(
        jobs=[
            JobStatusResponse(
                job_id=str(job.id),
                job_type=job.job_type,
                area_id=str(job.area_id) if job.area_id else None,
                area_display_name=(
                    area_name_by_id.get(str(job.area_id)) if job.area_id else None
                ),
                status=job.status,
                stage=job.stage,
                progress=job.progress,
                message=job.message,
                error=job.error,
                created_at=job.created_at.isoformat(),
                started_at=job.started_at.isoformat() if job.started_at else None,
                completed_at=job.completed_at.isoformat() if job.completed_at else None,
            )
            for job in jobs
        ],
    )


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: PydanticObjectId):
    """
    Cancel a pending or running job.

    Note: This doesn't immediately stop running tasks, but prevents
    retries and marks the job as cancelled.
    """
    job = await Job.get(job_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )

    if job.status in ["completed", "failed", "needs_attention"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot cancel job with status: {job.status}",
        )

    job.status = "cancelled"
    job.stage = "Cancelled by user"
    await job.save()

    return {
        "success": True,
        "message": "Job cancelled",
    }
