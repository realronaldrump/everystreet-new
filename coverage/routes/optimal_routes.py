"""
Route handlers for optimal route generation and management.

Handles generating, retrieving, and exporting optimal completion routes.
"""

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse

from coverage.models import CoverageArea
from db import OptimalRouteProgress

logger = logging.getLogger(__name__)


async def _get_coverage_area(area_id: PydanticObjectId) -> CoverageArea | None:
    """Fetch a coverage area by ID."""
    return await CoverageArea.get(area_id)


router = APIRouter()


@router.post("/api/coverage/areas/{area_id}/optimal-route")
async def start_optimal_route_generation(
    area_id: PydanticObjectId,
    start_lon: Annotated[
        float | None,
        Query(description="Optional starting longitude"),
    ] = None,
    start_lat: Annotated[
        float | None,
        Query(description="Optional starting latitude"),
    ] = None,
):
    """Start a background task to generate optimal completion route."""
    from tasks.ops import enqueue_task

    coverage_area = await _get_coverage_area(area_id)

    if not coverage_area:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    if coverage_area.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Coverage area is not ready (status: {coverage_area.status}).",
        )

    enqueue_result = await enqueue_task(
        "generate_optimal_route",
        location_id=str(area_id),
        start_lon=start_lon,
        start_lat=start_lat,
        manual_run=True,
    )
    task_id = enqueue_result.get("job_id")
    if not task_id:
        raise HTTPException(
            status_code=500,
            detail="Failed to enqueue optimal route generation task",
        )

    # Create initial progress document so SSE can track queued state
    # before worker picks up the task
    progress = OptimalRouteProgress(
        location=str(area_id),
        task_id=task_id,
        status="queued",
        stage="queued",
        progress=0,
        message="Task queued, waiting for worker...",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    await progress.insert()

    logger.info(
        "Started optimal route generation task %s for location %s",
        task_id,
        area_id,
    )

    return {"task_id": task_id, "status": "started"}


@router.get("/api/optimal-routes/worker-status")
async def get_worker_status():
    """Check if ARQ workers are connected and accepting tasks."""
    from tasks.arq import get_arq_pool

    try:
        redis = await get_arq_pool()
        heartbeat = await redis.get("arq:worker:heartbeat")
        if heartbeat:
            last_seen = (
                heartbeat.decode("utf-8") if isinstance(heartbeat, bytes) else heartbeat
            )
            return {
                "status": "ok",
                "message": "ARQ worker heartbeat detected",
                "workers": [{"name": "arq-worker", "last_seen": last_seen}],
            }
        return {
            "status": "no_workers",
            "message": "No ARQ worker heartbeat detected. Worker may be offline.",
            "workers": [],
            "recommendation": "Check that the ARQ worker is running",
        }

    except Exception as e:
        logger.exception("Failed to check worker status: %s", e)
        return {
            "status": "error",
            "message": f"Failed to check worker status: {e}",
            "workers": [],
        }


@router.get("/api/coverage/areas/{area_id}/optimal-route")
async def get_optimal_route(area_id: PydanticObjectId):
    """Retrieve the generated optimal route for a coverage area."""
    coverage_area = await _get_coverage_area(area_id)

    if not coverage_area:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    # Get route from the model - check several possible locations
    route = None
    if coverage_area.optimal_route:
        route = coverage_area.optimal_route

    if not route:
        raise HTTPException(
            status_code=404,
            detail="No optimal route generated yet. Use POST to generate one.",
        )

    # Prepare route data (handle dict or Pydantic model)
    route_data = route if isinstance(route, dict) else route.model_dump(by_alias=True)

    # Get location name
    location_name = coverage_area.display_name

    return {
        "status": "success",
        "location_name": location_name,
        **route_data,
    }


@router.get("/api/coverage/areas/{area_id}/optimal-route/gpx")
async def export_optimal_route_gpx(area_id: PydanticObjectId):
    """Export optimal route as GPX file for navigation apps."""
    from coverage.gpx import build_gpx_from_coords

    coverage_area = await _get_coverage_area(area_id)

    if not coverage_area:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    # Get route from the model
    route = None
    if coverage_area.optimal_route:
        route = coverage_area.optimal_route

    # Prepare route data (handle dict or Pydantic model)
    route_data = (
        route
        if isinstance(route, dict)
        else (route.model_dump(by_alias=True) if route else None)
    )

    if (
        route_data
        and not route_data.get("coordinates")
        and route_data.get("route_coordinates")
    ):
        route_data["coordinates"] = route_data["route_coordinates"]
    if not route_data or not route_data.get("coordinates"):
        raise HTTPException(
            status_code=404,
            detail="No optimal route available. Generate one first.",
        )

    # Get location name
    location_name = coverage_area.display_name or "Route"
    gpx_content = build_gpx_from_coords(
        route_data["coordinates"],
        name=f"Optimal Route - {location_name}",
    )

    safe_filename = "".join(
        c if c.isalnum() or c in "-_" else "_" for c in location_name[:50]
    )
    filename = f"optimal_route_{safe_filename}.gpx"

    return Response(
        content=gpx_content,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/api/coverage/areas/{area_id}/optimal-route")
async def delete_optimal_route(area_id: PydanticObjectId):
    """Delete saved optimal route for a coverage area."""
    coverage_area = await _get_coverage_area(area_id)

    if not coverage_area:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    # Unset optimal_route field
    coverage_area.optimal_route = None
    await coverage_area.save()

    return {"status": "success", "message": "Optimal route deleted"}


@router.get("/api/coverage/areas/{area_id}/active-task")
async def get_active_route_task(area_id: str):
    """
    Check if there's an active or recent route generation task for this location.

    Returns the task_id and current progress if an active task is found,
    allowing the frontend to reconnect after page refresh.
    """
    # Find any active/pending task for this location
    # Sort by created_at descending to get the most recent task
    progress = await OptimalRouteProgress.find_one(
        {
            "location": area_id,
            "status": {"$in": ["queued", "running", "pending", "initializing"]},
        },
        sort=[("created_at", -1)],
    )

    if not progress:
        return {"active": False, "task_id": None}

    return {
        "active": True,
        "task_id": progress.task_id,
        "status": progress.status or "pending",
        "stage": progress.stage or "initializing",
        "progress": progress.progress or 0,
        "message": progress.message or "",
        "metrics": progress.metrics or {},
        "started_at": progress.started_at,
        "updated_at": progress.updated_at,
    }


@router.delete("/api/optimal-routes/{task_id}")
async def cancel_optimal_route_task(task_id: str):
    """
    Cancel an in-progress route generation task.

    Aborts the ARQ job and marks it as cancelled in the database.
    Also cancels any other active tasks for the same location.
    """
    from tasks.ops import abort_job

    # Check if task exists
    progress = await OptimalRouteProgress.find_one({"task_id": task_id})

    if not progress:
        raise HTTPException(status_code=404, detail="Task not found")

    location_id = progress.location
    current_status = progress.status or ""

    if current_status not in ("completed", "failed", "cancelled"):
        try:
            aborted = await abort_job(task_id)
            if aborted:
                logger.info("Requested ARQ abort for task %s", task_id)
        except Exception as e:
            logger.warning("Could not abort ARQ task %s: %s", task_id, e)

    # Cancel ALL active tasks for this location (not just this one)
    if location_id:
        active_statuses = ["queued", "running", "pending", "initializing"]
        active_tasks = await OptimalRouteProgress.find(
            {
                "location": location_id,
                "status": {"$in": active_statuses},
            },
        ).to_list()

        cancelled_count = 0
        for task in active_tasks:
            tid = task.task_id
            if tid:
                # Abort each ARQ job
                with contextlib.suppress(Exception):
                    await abort_job(tid)

                # Mark as cancelled
                task.status = "cancelled"
                task.stage = "cancelled"
                task.message = "Task cancelled by user"
                await task.save()
                cancelled_count += 1

        logger.info(
            "Cancelled %d active tasks for location %s",
            cancelled_count,
            location_id,
        )

    return {"status": "cancelled", "message": "All active tasks cancelled"}


@router.get("/api/optimal-routes/{task_id}/progress")
async def get_optimal_route_progress(task_id: str):
    """Get current progress for an optimal route generation task."""
    progress = await OptimalRouteProgress.find_one({"task_id": task_id})

    if not progress:
        raise HTTPException(status_code=404, detail="Task not found")

    return {
        "task_id": task_id,
        "location_id": progress.location,
        "status": progress.status or "pending",
        "stage": progress.stage or "initializing",
        "progress": progress.progress or 0,
        "message": progress.message or "",
        "metrics": progress.metrics or {},
        "error": progress.error,
        "started_at": progress.started_at,
        "updated_at": progress.updated_at,
        "completed_at": progress.completed_at,
    }


@router.get("/api/optimal-routes/{task_id}/progress/sse")
async def stream_optimal_route_progress(task_id: str):
    """Stream real-time progress updates via Server-Sent Events."""

    async def event_generator():
        last_progress = -1
        last_stage = None
        last_message = None
        last_metrics = None
        poll_count = 0
        max_polls = 1800  # 30 minutes at 1 second intervals

        while poll_count < max_polls:
            poll_count += 1

            try:
                progress = await OptimalRouteProgress.find_one(
                    {"task_id": task_id},
                )

                if not progress:
                    data = {
                        "status": "pending",
                        "stage": "waiting",
                        "progress": 0,
                        "message": "Waiting for task to start...",
                    }
                    yield f"data: {json.dumps(data)}\n\n"
                    await asyncio.sleep(1)
                    continue

                current_progress = progress.progress or 0
                current_stage = progress.stage or "initializing"
                current_status = progress.status or "running"
                current_message = progress.message or ""
                current_metrics = progress.metrics or {}

                if (
                    current_progress != last_progress
                    or current_stage != last_stage
                    or current_message != last_message
                    or current_metrics != last_metrics
                ):
                    last_progress = current_progress
                    last_stage = current_stage
                    last_message = current_message
                    last_metrics = current_metrics

                    data = {
                        "status": current_status,
                        "stage": current_stage,
                        "progress": current_progress,
                        "message": current_message,
                        "metrics": current_metrics,
                        "error": progress.error,
                        "started_at": (
                            progress.started_at.isoformat()
                            if progress.started_at
                            else None
                        ),
                        "updated_at": (
                            progress.updated_at.isoformat()
                            if progress.updated_at
                            else None
                        ),
                    }
                    yield f"data: {json.dumps(data)}\n\n"

                if current_status in ("completed", "failed", "error", "cancelled"):
                    final_data = {
                        "status": current_status,
                        "stage": current_stage,
                        "progress": current_progress,
                        "message": current_message,
                        "metrics": current_metrics,
                        "error": progress.error,
                        "completed_at": (
                            progress.completed_at.isoformat()
                            if progress.completed_at
                            else None
                        ),
                    }
                    yield f"data: {json.dumps(final_data)}\n\n"
                    break

            except Exception as e:
                logger.error("SSE progress error: %s", e, exc_info=True)
                error_data = {"error": str(e), "status": "failed"}
                yield f"data: {json.dumps(error_data)}\n\n"
                # If we hit a critical error, maybe we should break?
                # But temporary DB glitches might recover.
                await asyncio.sleep(1)

            await asyncio.sleep(1)

        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
            "Content-Encoding": "identity",  # Disable compression
            "Transfer-Encoding": "chunked",  # Use chunked transfer for streaming
        },
    )
