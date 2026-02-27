"""
Job status API endpoints.

Provides endpoints for checking background job progress,
including a Server-Sent Events (SSE) stream for real-time updates.
"""

import asyncio
import json
import logging
import time
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.responses import StreamingResponse

from db.models import CoverageArea, Job
from street_coverage.events import publish, subscribe, unsubscribe
from street_coverage.ingestion import cancel_ingestion_job

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
    result: dict[str, Any] | None = None


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
        result=job.result,
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
                result=job.result,
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
                result=job.result,
            )
            for job in jobs
        ],
    )


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: PydanticObjectId):
    """
    Cancel a pending or running job.

    Attempts to cancel in-process tasks (best-effort) and marks the job
    as cancelled in the database. Ingestion pipelines also self-abort by
    checking job status between stages.
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

    # Best-effort: cancel in-process asyncio task(s) for this job.
    cancel_ingestion_job(job_id)

    now = datetime.now(UTC)
    job.status = "cancelled"
    job.stage = "Cancelled by user"
    job.message = "Cancelled"
    job.completed_at = now
    job.updated_at = now
    await job.save()

    # For area ingestion/rebuild jobs, also mark the area as unavailable so the
    # UI doesn't remain stuck in initializing/rebuilding.
    if job.area_id and job.job_type in {"area_ingestion", "area_rebuild"}:
        area = await CoverageArea.get(job.area_id)
        if area:
            await area.set(
                {
                    "status": "error",
                    "health": "unavailable",
                    "last_error": "Cancelled by user",
                },
            )

    return {
        "success": True,
        "message": "Job cancelled",
    }


# =============================================================================
# Server-Sent Events stream
# =============================================================================

HEARTBEAT_INTERVAL = 15  # seconds
SSE_TIMEOUT = 600  # 10 minutes max


def _sse_format(event: str, data: Any) -> str:
    """Format a single SSE frame."""
    payload = json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


async def _job_event_stream(job_id: str):
    """Async generator that yields SSE frames for a job."""
    # Send initial snapshot
    try:
        job = await Job.get(job_id)
    except Exception:
        yield _sse_format("error", {"message": "Job not found"})
        return

    if not job:
        yield _sse_format("error", {"message": "Job not found"})
        return

    area_name = None
    if job.area_id:
        area = await CoverageArea.get(job.area_id)
        area_name = area.display_name if area else None

    yield _sse_format("snapshot", {
        "job_id": str(job.id),
        "job_type": job.job_type,
        "area_id": str(job.area_id) if job.area_id else None,
        "area_name": area_name,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "message": job.message,
        "error": job.error,
        "result": job.result,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
    })

    # If already terminal, no need to stream
    if job.status in ("completed", "failed", "cancelled"):
        yield _sse_format("done", {
            "status": job.status,
            "result": job.result,
            "error": job.error,
        })
        return

    # Subscribe to live events
    q = subscribe(job_id)
    last_heartbeat = time.monotonic()
    start = time.monotonic()

    try:
        while True:
            elapsed = time.monotonic() - start
            if elapsed > SSE_TIMEOUT:
                yield _sse_format("timeout", {"message": "Stream timeout"})
                return

            try:
                event = await asyncio.wait_for(q.get(), timeout=HEARTBEAT_INTERVAL)
            except asyncio.TimeoutError:
                # Send heartbeat to keep connection alive
                yield _sse_format("heartbeat", {"ts": time.time()})
                last_heartbeat = time.monotonic()
                continue

            event_type = event.pop("_type", "progress")
            yield _sse_format(event_type, event)

            # Terminal events end the stream
            if event_type == "done" or event.get("status") in (
                "completed",
                "failed",
                "cancelled",
            ):
                return
    finally:
        unsubscribe(job_id, q)


@router.get("/jobs/{job_id}/stream")
async def stream_job_progress(job_id: PydanticObjectId):
    """
    Stream real-time job progress via Server-Sent Events.

    Events:
    - snapshot: Initial state on connect
    - progress: Stage/progress updates with metrics
    - stage: Stage transition with timing
    - done: Job completed/failed/cancelled
    - heartbeat: Keep-alive (every 15s)
    """
    return StreamingResponse(
        _job_event_stream(str(job_id)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
