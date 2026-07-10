"""API routes for trips sync actions."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status

from core.api import api_route
from core.date_utils import parse_timestamp
from core.job_serialization import serialize_job_payload
from core.jobs import JobHandle
from core.streaming import sse_event_stream, sse_response
from db.models import Job, TaskHistory
from tasks.config import update_task_history_entry
from tasks.ops import abort_job
from trips.models import TripSyncConfigUpdate, TripSyncRequest
from trips.services.trip_history_import_service import (
    build_import_plan,
    resolve_import_start_dt_from_db,
)
from trips.services.trip_sync_service import TripSyncService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/actions/trips/sync/status", response_model=dict)
@api_route(logger)
async def get_trip_sync_status():
    """Get current trip sync status and last activity."""
    return await TripSyncService.get_sync_status()


@router.post("/api/actions/trips/sync", response_model=dict)
@api_route(logger)
async def start_trip_sync(payload: TripSyncRequest | None = None):
    """Trigger a trip sync action."""
    if payload is None:
        payload = TripSyncRequest()
    return await TripSyncService.start_sync(payload)


@router.delete("/api/actions/trips/sync/{job_id}", response_model=dict)
@api_route(logger)
async def cancel_trip_sync(job_id: str):
    """Cancel an active trip sync action."""
    return await TripSyncService.cancel_sync(job_id)


@router.get("/api/actions/trips/sync/config", response_model=dict)
@api_route(logger)
async def get_trip_sync_config():
    """Get sync defaults for trips."""
    return await TripSyncService.get_sync_config()


@router.post("/api/actions/trips/sync/config", response_model=dict)
@api_route(logger)
async def update_trip_sync_config(payload: TripSyncConfigUpdate):
    """Update sync defaults for trips."""
    return await TripSyncService.update_sync_config(payload)


@router.get("/api/actions/trips/sync/sse", response_model=None)
@api_route(logger)
async def stream_trip_sync_updates():
    """Stream trip sync updates via SSE."""
    return sse_response(
        sse_event_stream(
            TripSyncService.get_sync_status,
            is_terminal=lambda _: False,
            poll_interval=2,
            keepalive_every=7,
        ),
    )


def _job_payload(job: Job) -> dict:
    return serialize_job_payload(job)


@router.get("/api/actions/trips/sync/history_import/plan", response_model=dict)
@api_route(logger)
async def get_trip_history_import_plan(
    start_date: Annotated[
        str | None,
        Query(
            description="Optional import start datetime (ISO 8601). Defaults to earliest stored trip.",
        ),
    ] = None,
    selected_imeis: Annotated[
        str | None,
        Query(
            description=(
                "Optional comma-separated IMEI list to preview a scoped import plan. "
                "When omitted, all authorized vehicles are included."
            ),
        ),
    ] = None,
):
    """Preview a trip history import plan (windows, requests, devices)."""
    parsed = parse_timestamp(start_date) if start_date else None
    start_dt = await resolve_import_start_dt_from_db(parsed)
    end_dt = datetime.now(UTC)
    selected = None
    if selected_imeis is not None:
        selected = [
            imei.strip() for imei in selected_imeis.split(",") if imei and imei.strip()
        ]
    return await build_import_plan(
        start_dt=start_dt,
        end_dt=end_dt,
        selected_imeis=selected,
    )


@router.get(
    "/api/actions/trips/sync/history_import/{progress_job_id}",
    response_model=dict,
)
@api_route(logger)
async def get_trip_history_import_status(progress_job_id: PydanticObjectId):
    """Fetch current progress for a trip history import job."""
    job = await Job.get(progress_job_id)
    if not job or job.job_type != "trip_history_import":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="History import job not found",
        )
    return _job_payload(job)


@router.get(
    "/api/actions/trips/sync/history_import/{progress_job_id}/sse",
    response_model=None,
)
@api_route(logger)
async def stream_trip_history_import_status(progress_job_id: PydanticObjectId):
    """Stream history import progress via SSE."""

    async def fetch():
        job = await Job.get(progress_job_id)
        if not job or job.job_type != "trip_history_import":
            return {"_status": "not_found"}
        return _job_payload(job)

    def serialize(payload: dict[str, object]) -> dict[str, object]:
        if payload.get("_status") == "not_found":
            return {}
        return payload

    def is_terminal(payload: dict[str, object]) -> bool:
        status_value = str(payload.get("_status") or payload.get("status") or "")
        return status_value.lower() in {
            "not_found",
            "completed",
            "failed",
            "cancelled",
            "error",
        }

    return sse_response(
        sse_event_stream(
            fetch,
            is_terminal=is_terminal,
            serialize_fn=serialize,
            poll_interval=1,
            keepalive_every=10,
        ),
    )


@router.delete(
    "/api/actions/trips/sync/history_import/{progress_job_id}",
    response_model=dict,
)
@api_route(logger)
async def cancel_trip_history_import(progress_job_id: PydanticObjectId):
    """Cancel a running/pending history import."""
    job = await Job.get(progress_job_id)
    if not job or job.job_type != "trip_history_import":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="History import job not found",
        )

    if job.status in {"completed", "failed", "cancelled"}:
        # Idempotent cancel: also ensure any lingering TaskHistory lock is cleared.
        operation_id = job.operation_id
        if operation_id:
            status_map = {
                "completed": "COMPLETED",
                "failed": "FAILED",
                "cancelled": "CANCELLED",
            }
            try:
                history = await TaskHistory.get(operation_id)
                # Only "clear the lock" if TaskHistory still claims to be active.
                # Avoid mutating finalized entries (end_time/error/timestamp) on
                # an idempotent cancel request for an already-finished job.
                if history and (history.status in {"RUNNING", "PENDING"}):
                    final_status = status_map.get(job.status, "CANCELLED")
                    finished_at = (
                        job.completed_at or job.updated_at or datetime.now(UTC)
                    )
                    history.task_id = history.task_id or (
                        job.task_id or "fetch_all_missing_trips"
                    )
                    history.status = final_status
                    history.timestamp = finished_at
                    history.end_time = history.end_time or finished_at
                    if (
                        final_status == "FAILED"
                        and not history.error
                        and getattr(job, "error", None)
                    ):
                        history.error = str(job.error)
                    await history.save()
            except Exception:
                logger.exception(
                    "Failed to clear lingering task history lock for history import %s",
                    operation_id,
                )
        return {"status": "success", "message": "Job is already finished."}

    now = datetime.now(UTC)
    await JobHandle(job).update(
        status="cancelled",
        stage="cancelled",
        message="Cancelled",
        completed_at=now,
    )

    operation_id = job.operation_id
    if operation_id:
        try:
            await abort_job(operation_id)
        except Exception:
            logger.exception("Failed to abort ARQ job %s", operation_id)

        # Clear the task_history RUNNING/PENDING lock so new imports can start.
        try:
            await update_task_history_entry(
                job_id=operation_id,
                task_name=job.task_id or "fetch_all_missing_trips",
                status="CANCELLED",
                manual_run=True,
                error="Cancelled via trip history import modal",
                end_time=now,
            )
        except Exception:
            logger.exception(
                "Failed to mark task history cancelled for %s",
                operation_id,
            )

    return {"status": "success", "message": "Import cancelled"}
