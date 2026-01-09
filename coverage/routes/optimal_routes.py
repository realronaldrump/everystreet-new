"""Route handlers for optimal route generation and management.

Handles generating, retrieving, and exporting optimal completion routes.
"""

import asyncio
import json
import logging
from datetime import UTC, datetime

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse

from coverage.serializers import serialize_optimal_route
from db import db_manager, find_one_with_retry, update_one_with_retry

logger = logging.getLogger(__name__)
router = APIRouter()

coverage_metadata_collection = db_manager.db["coverage_metadata"]
optimal_route_progress_collection = db_manager.db["optimal_route_progress"]


@router.post("/api/coverage_areas/{location_id}/generate-optimal-route")
async def start_optimal_route_generation(
    location_id: str,
    start_lon: float = Query(None, description="Optional starting longitude"),
    start_lat: float = Query(None, description="Optional starting latitude"),
):
    """Start a background task to generate optimal completion route."""
    from tasks import generate_optimal_route_task

    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    coverage_doc = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {"location.display_name": 1, "status": 1},
    )

    if not coverage_doc:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    if coverage_doc.get("status") == "processing":
        raise HTTPException(
            status_code=400,
            detail="Coverage area is still being processed. Wait for completion.",
        )

    task = generate_optimal_route_task.delay(
        location_id=location_id,
        start_lon=start_lon,
        start_lat=start_lat,
        manual_run=True,
    )

    # Create initial progress document so SSE can track queued state
    # before worker picks up the task
    await update_one_with_retry(
        optimal_route_progress_collection,
        {"task_id": task.id},
        {
            "$set": {
                "task_id": task.id,
                "location_id": location_id,
                "status": "queued",
                "stage": "queued",
                "progress": 0,
                "message": "Task queued, waiting for worker...",
                "queued_at": datetime.now(UTC),
            }
        },
        upsert=True,
    )

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
                }
            )

        return {
            "status": "ok",
            "message": f"{len(worker_info)} worker(s) connected",
            "workers": worker_info,
        }

    except Exception as e:
        logger.error("Failed to check worker status: %s", e)
        return {
            "status": "error",
            "message": f"Failed to check worker status: {e}",
            "workers": [],
        }


@router.get("/api/coverage_areas/{location_id}/optimal-route")
async def get_optimal_route(location_id: str):
    """Retrieve the generated optimal route for a coverage area."""
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    coverage_doc = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {"optimal_route": 1, "location.display_name": 1},
    )

    if not coverage_doc:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    route = coverage_doc.get("optimal_route")
    if not route:
        route = coverage_doc.get("location", {}).get("optimal_route_data")
    if not route:
        raise HTTPException(
            status_code=404,
            detail="No optimal route generated yet. Use POST to generate one.",
        )

    route = serialize_optimal_route(route)

    return {
        "status": "success",
        "location_name": coverage_doc.get("location", {}).get("display_name"),
        **route,
    }


@router.get("/api/coverage_areas/{location_id}/optimal-route/gpx")
async def export_optimal_route_gpx(location_id: str):
    """Export optimal route as GPX file for navigation apps."""
    from export_helpers import build_gpx_from_coords

    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    coverage_doc = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {"optimal_route": 1, "location.display_name": 1},
    )

    if not coverage_doc:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    route = coverage_doc.get("optimal_route")
    if not route:
        route = coverage_doc.get("location", {}).get("optimal_route_data")
    if route and not route.get("coordinates") and route.get("route_coordinates"):
        route["coordinates"] = route["route_coordinates"]
    if not route or not route.get("coordinates"):
        raise HTTPException(
            status_code=404,
            detail="No optimal route available. Generate one first.",
        )

    location_name = coverage_doc.get("location", {}).get("display_name", "Route")
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
async def delete_optimal_route(location_id: str):
    """Delete the saved optimal route for a coverage area."""
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    result = await update_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {"$unset": {"optimal_route": 1}},
    )

    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Coverage area not found")

    return {"status": "success", "message": "Optimal route deleted"}


@router.get("/api/coverage_areas/{location_id}/active-task")
async def get_active_route_task(location_id: str):
    """Check if there's an active or recent route generation task for this location.

    Returns the task_id and current progress if an active task is found,
    allowing the frontend to reconnect after page refresh.
    """
    # Find any active/pending task for this location
    # Sort by queued_at descending to get the most recent task
    progress = await find_one_with_retry(
        optimal_route_progress_collection,
        {
            "location_id": location_id,
            "status": {"$in": ["queued", "running", "pending", "initializing"]},
        },
        sort=[("queued_at", -1)],
    )

    if not progress:
        return {"active": False, "task_id": None}

    return {
        "active": True,
        "task_id": progress.get("task_id"),
        "status": progress.get("status", "pending"),
        "stage": progress.get("stage", "initializing"),
        "progress": progress.get("progress", 0),
        "message": progress.get("message", ""),
        "metrics": progress.get("metrics", {}),
        "started_at": progress.get("started_at"),
        "updated_at": progress.get("updated_at"),
    }


@router.delete("/api/optimal-routes/{task_id}")
async def cancel_optimal_route_task(task_id: str):
    """Cancel an in-progress route generation task.

    Revokes the Celery task and marks it as cancelled in the database.
    Also cancels any other active tasks for the same location.
    """
    from celery_app import app as celery_app

    # Check if task exists
    progress = await find_one_with_retry(
        optimal_route_progress_collection,
        {"task_id": task_id},
    )

    if not progress:
        raise HTTPException(status_code=404, detail="Task not found")

    location_id = progress.get("location_id")
    current_status = progress.get("status", "")

    if current_status in ("completed", "failed", "cancelled"):
        # Even if this task is done, cancel any other active tasks for this location
        pass
    else:
        # Revoke the Celery task
        try:
            celery_app.control.revoke(task_id, terminate=True, signal="SIGTERM")
            logger.info("Revoked Celery task %s", task_id)
        except Exception as e:
            logger.warning("Could not revoke Celery task %s: %s", task_id, e)

    # Cancel ALL active tasks for this location (not just this one)
    if location_id:
        active_statuses = ["queued", "running", "pending", "initializing"]
        active_tasks = optimal_route_progress_collection.find(
            {
                "location_id": location_id,
                "status": {"$in": active_statuses},
            }
        )

        cancelled_count = 0
        async for task in active_tasks:
            tid = task.get("task_id")
            if tid:
                # Revoke each Celery task
                import contextlib

                with contextlib.suppress(Exception):
                    celery_app.control.revoke(tid, terminate=True, signal="SIGTERM")

                # Mark as cancelled
                await update_one_with_retry(
                    optimal_route_progress_collection,
                    {"task_id": tid},
                    {
                        "$set": {
                            "status": "cancelled",
                            "stage": "cancelled",
                            "message": "Task cancelled by user",
                            "cancelled_at": datetime.now(UTC),
                        }
                    },
                )
                cancelled_count += 1

        logger.info(
            "Cancelled %d active tasks for location %s", cancelled_count, location_id
        )

    return {"status": "cancelled", "message": "All active tasks cancelled"}


@router.get("/api/optimal-routes/{task_id}/progress")
async def get_optimal_route_progress(task_id: str):
    """Get current progress for an optimal route generation task."""
    progress = await find_one_with_retry(
        optimal_route_progress_collection,
        {"task_id": task_id},
    )

    if not progress:
        raise HTTPException(status_code=404, detail="Task not found")

    return {
        "task_id": task_id,
        "location_id": progress.get("location_id"),
        "status": progress.get("status", "pending"),
        "stage": progress.get("stage", "initializing"),
        "progress": progress.get("progress", 0),
        "message": progress.get("message", ""),
        "metrics": progress.get("metrics", {}),
        "error": progress.get("error"),
        "started_at": progress.get("started_at"),
        "updated_at": progress.get("updated_at"),
        "completed_at": progress.get("completed_at"),
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
                progress = await find_one_with_retry(
                    optimal_route_progress_collection,
                    {"task_id": task_id},
                )

                if not progress:
                    data = {
                        "status": "pending",
                        "stage": "waiting",
                        "progress": 0,
                        "message": "Waiting for task to start...",
                    }
                    yield f"data: {json.dumps(data, default=str)}\n\n"
                    await asyncio.sleep(1)
                    continue

                current_progress = progress.get("progress", 0)
                current_stage = progress.get("stage")
                current_status = progress.get("status", "running")
                current_message = progress.get("message", "")
                current_metrics = progress.get("metrics", {}) or {}

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
                        "error": progress.get("error"),
                        "started_at": progress.get("started_at"),
                        "updated_at": progress.get("updated_at"),
                    }
                    yield f"data: {json.dumps(data, default=str)}\n\n"

                if current_status in ("completed", "failed", "error", "cancelled"):
                    final_data = {
                        "status": current_status,
                        "stage": current_stage,
                        "progress": current_progress,
                        "message": current_message,
                        "metrics": current_metrics,
                        "error": progress.get("error"),
                        "completed_at": progress.get("completed_at"),
                    }
                    yield f"data: {json.dumps(final_data, default=str)}\n\n"
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
