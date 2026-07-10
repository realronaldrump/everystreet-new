"""
Job status API endpoints.

Provides endpoints for checking background job progress, including a
Server-Sent Events (SSE) stream for real-time updates.
"""

import contextlib
import logging
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from core.job_serialization import serialize_job_payload
from core.jobs import resolve_job_reference
from core.streaming import format_sse_event, sse_queue_stream, sse_response
from db.models import CoverageArea, Job
from street_coverage.events import subscribe, unsubscribe
from tasks.ops import abort_job

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["coverage-jobs"])


# =============================================================================
# Response Models
# =============================================================================


class JobStatusResponse(BaseModel):
    """Job status response."""

    success: bool = True
    job_id: str
    task_id: str | None = None
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


def _job_status_response(
    job: Job,
    *,
    area_display_name: str | None = None,
    fallback_area_id: PydanticObjectId | str | None = None,
) -> JobStatusResponse:
    payload = serialize_job_payload(job)
    area_id = (
        str(job.area_id)
        if job.area_id
        else (str(fallback_area_id) if fallback_area_id else None)
    )
    return JobStatusResponse(
        job_id=str(payload["job_id"]),
        task_id=payload["task_id"],
        job_type=payload["job_type"],
        area_id=area_id,
        area_display_name=area_display_name,
        status=payload["status"],
        stage=payload["stage"],
        progress=payload["progress"],
        message=payload["message"],
        error=payload["error"],
        created_at=payload["created_at"],
        started_at=payload["started_at"],
        completed_at=payload["completed_at"],
        result=payload["result"],
    )


# =============================================================================
# Endpoints
# =============================================================================


@router.get("/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: str):
    """
    Get the status of a background job.

    Accepts either a MongoDB ObjectId or an ARQ task_id.

    Poll this endpoint to track progress of:
    - Area ingestion
    - Area rebuilds
    - Route generation
    """
    job = await resolve_job_reference(job_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )

    area_display_name = None
    if job.area_id:
        area = await CoverageArea.get(job.area_id)
        area_display_name = area.display_name if area else None

    return _job_status_response(job, area_display_name=area_display_name)


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
            _job_status_response(
                job,
                area_display_name=area_display_name,
                fallback_area_id=area_id,
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
            _job_status_response(
                job,
                area_display_name=(
                    area_name_by_id.get(str(job.area_id)) if job.area_id else None
                ),
            )
            for job in jobs
        ],
    )


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: str):
    """
    Cancel a pending or running job.

    Accepts either a MongoDB ObjectId or an ARQ task_id.

    Requests an ARQ abort (best-effort) and marks the job as cancelled
    in the database. Ingestion pipelines also self-abort by checking job
    status between stages.
    """
    job = await resolve_job_reference(job_id)
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

    aborted = False
    operation_id = job.operation_id or job.task_id
    if not operation_id and len(job_id) != 24:
        operation_id = job_id
    if operation_id:
        with contextlib.suppress(Exception):
            aborted = await abort_job(operation_id)

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
        "aborted": aborted,
    }


# =============================================================================
# Server-Sent Events stream
# =============================================================================

HEARTBEAT_INTERVAL = 15  # seconds
SSE_TIMEOUT = 600  # 10 minutes max


async def _job_event_stream(job_id: str):
    """Async generator that yields SSE frames for a job."""
    # Send initial snapshot
    try:
        job = await Job.get(job_id)
    except Exception:
        yield format_sse_event({"message": "Job not found"}, event="error")
        return

    if not job:
        yield format_sse_event({"message": "Job not found"}, event="error")
        return

    area_name = None
    if job.area_id:
        area = await CoverageArea.get(job.area_id)
        area_name = area.display_name if area else None

    snapshot = serialize_job_payload(job)
    snapshot.update(
        {
            "area_id": str(job.area_id) if job.area_id else None,
            "area_name": area_name,
        },
    )
    yield format_sse_event(snapshot, event="snapshot")

    # If already terminal, no need to stream
    if job.status in {"completed", "failed", "cancelled"}:
        yield format_sse_event(
            {
                "status": job.status,
                "result": job.result,
                "error": job.error,
            },
            event="done",
        )
        return

    # Subscribe to live events
    q = subscribe(job_id)

    def _is_terminal_event(event_name: str, payload: dict[str, Any]) -> bool:
        return event_name == "done" or payload.get("status") in {
            "completed",
            "failed",
            "cancelled",
        }

    async def _next_event() -> dict[str, Any] | None:
        return await q.get()

    try:
        async for frame in sse_queue_stream(
            _next_event,
            event_name_key="_type",
            default_event_name="progress",
            timeout_s=HEARTBEAT_INTERVAL,
            keepalive_event_name="heartbeat",
            max_duration_s=SSE_TIMEOUT,
            is_terminal_event=_is_terminal_event,
        ):
            yield frame
    finally:
        unsubscribe(job_id, q)


@router.get("/jobs/{job_id}/stream")
async def stream_job_progress(job_id: str):
    """
    Stream real-time job progress via Server-Sent Events.

    Accepts either a MongoDB ObjectId or an ARQ task_id.

    Events:
    - snapshot: Initial state on connect
    - progress: Stage/progress updates with metrics
    - stage: Stage transition with timing
    - done: Job completed/failed/cancelled
    - heartbeat: Keep-alive (every 15s)
    """
    # Resolve to actual ObjectId for the stream
    job = await resolve_job_reference(job_id)
    resolved_id = str(job.id) if job else job_id
    return sse_response(
        _job_event_stream(resolved_id),
        **{"X-Accel-Buffering": "no"},
    )
