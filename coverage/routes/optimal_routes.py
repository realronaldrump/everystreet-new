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

from db import CoverageMetadata, OptimalRouteProgress

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/coverage_areas/{location_id}/generate-optimal-route")
async def start_optimal_route_generation(
    location_id: PydanticObjectId,
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
    from tasks import generate_optimal_route_task

    coverage_doc = await CoverageMetadata.get(location_id)

    if not coverage_doc:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    if coverage_doc.status == "processing":
        raise HTTPException(
            status_code=400,
            detail="Coverage area is still being processed. Wait for completion.",
        )

    task = generate_optimal_route_task.delay(
        location_id=str(location_id),
        start_lon=start_lon,
        start_lat=start_lat,
        manual_run=True,
    )

    # Create initial progress document so SSE can track queued state
    # before worker picks up the task
    progress = OptimalRouteProgress(
        location=str(location_id),
        task_id=task.id,
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
        task.id,
        location_id,
    )

    return {"task_id": task.id, "status": "started"}


@router.get("/api/optimal-routes/worker-status")
async def get_worker_status():
    """Check if Celery workers are connected and accepting tasks."""
    from celery_app import app as celery_app

    try:
        # Get active workers using Celery's inspect API
        inspector = celery_app.control.inspect()

        # Ping workers (with short timeout)
        ping_result = inspector.ping()

        if not ping_result:
            return {
                "status": "no_workers",
                "message": "No Celery workers are responding. The worker may be offline.",
                "workers": [],
                "recommendation": "Check that the Celery worker is running on the mini PC",
            }

        # Get more details about active workers
        active = inspector.active() or {}
        registered = inspector.registered() or {}

        worker_info = []
        for worker_name in ping_result:
            worker_info.append(
                {
                    "name": worker_name,
                    "active_tasks": len(active.get(worker_name, [])),
                    "registered_tasks": len(registered.get(worker_name, [])),
                },
            )

        return {
            "status": "ok",
            "message": f"{len(worker_info)} worker(s) connected",
            "workers": worker_info,
        }

    except Exception as e:
        logger.exception("Failed to check worker status: %s", e)
        return {
            "status": "error",
            "message": f"Failed to check worker status: {e}",
            "workers": [],
        }


@router.get("/api/coverage_areas/{location_id}/optimal-route")
async def get_optimal_route(location_id: PydanticObjectId):
    """Retrieve the generated optimal route for a coverage area."""
    coverage_doc = await CoverageMetadata.get(location_id)

    if not coverage_doc:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    # Get route from the model - check several possible locations
    route = None
    if hasattr(coverage_doc, "optimal_route") and coverage_doc.optimal_route:
        route = coverage_doc.optimal_route
    elif coverage_doc.location and coverage_doc.location.get("optimal_route_data"):
        route = coverage_doc.location.get("optimal_route_data")

    if not route:
        raise HTTPException(
            status_code=404,
            detail="No optimal route generated yet. Use POST to generate one.",
        )

    # Prepare route data (handle dict or Pydantic model)
    route_data = route if isinstance(route, dict) else route.model_dump(by_alias=True)

    return {
        "status": "success",
        "location_name": (
            coverage_doc.location.get("display_name") if coverage_doc.location else None
        ),
        **route_data,
    }


@router.get("/api/coverage_areas/{location_id}/optimal-route/gpx")
async def export_optimal_route_gpx(location_id: PydanticObjectId):
    """Export optimal route as GPX file for navigation apps."""
    from export_helpers import build_gpx_from_coords

    coverage_doc = await CoverageMetadata.get(location_id)

    if not coverage_doc:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    # Get route from the model
    route = None
    if hasattr(coverage_doc, "optimal_route") and coverage_doc.optimal_route:
        route = coverage_doc.optimal_route
    elif coverage_doc.location and coverage_doc.location.get("optimal_route_data"):
        route = coverage_doc.location.get("optimal_route_data")

    if route and not route.get("coordinates") and route.get("route_coordinates"):
        route["coordinates"] = route["route_coordinates"]
    if not route or not route.get("coordinates"):
        raise HTTPException(
            status_code=404,
            detail="No optimal route available. Generate one first.",
        )

    location_name = (
        coverage_doc.location.get("display_name", "Route")
        if coverage_doc.location
        else "Route"
    )
    gpx_content = build_gpx_from_coords(
        route["coordinates"],
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


@router.delete("/api/coverage_areas/{location_id}/optimal-route")
async def delete_optimal_route(location_id: PydanticObjectId):
    """Delete saved optimal route for a coverage area."""
    coverage_doc = await CoverageMetadata.get(location_id)

    if not coverage_doc:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    # Unset optimal_route field
    if hasattr(coverage_doc, "optimal_route"):
        coverage_doc.optimal_route = None
        await coverage_doc.save()

    return {"status": "success", "message": "Optimal route deleted"}


@router.get("/api/coverage_areas/{location_id}/active-task")
async def get_active_route_task(location_id: str):
    """
    Check if there's an active or recent route generation task for this location.

    Returns the task_id and current progress if an active task is found, allowing the
    frontend to reconnect after page refresh.
    """
    # Find any active/pending task for this location
    # Sort by created_at descending to get the most recent task
    progress = await OptimalRouteProgress.find_one(
        {
            "location": location_id,
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

    Revokes the Celery task and marks it as cancelled in the database. Also cancels any
    other active tasks for the same location.
    """
    from celery_app import app as celery_app

    # Check if task exists
    progress = await OptimalRouteProgress.find_one({"task_id": task_id})

    if not progress:
        raise HTTPException(status_code=404, detail="Task not found")

    location_id = progress.location
    current_status = progress.status or ""

    if current_status not in ("completed", "failed", "cancelled"):
        # Revoke the Celery task
        try:
            celery_app.control.revoke(task_id, terminate=True, signal="SIGTERM")
            logger.info("Revoked Celery task %s", task_id)
        except Exception as e:
            logger.warning("Could not revoke Celery task %s: %s", task_id, e)

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
                # Revoke each Celery task
                with contextlib.suppress(Exception):
                    celery_app.control.revoke(tid, terminate=True, signal="SIGTERM")

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
