"""
Route handlers for optimal route generation and management.

Handles generating, retrieving, and exporting optimal completion routes.
"""

import logging
from datetime import UTC, datetime
from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from core.streaming import sse_event_stream, sse_response
from db.models import CoverageArea, GeneratedRoute, Job
from routing.route_store import (
    delete_generated_route,
    enqueue_generated_route,
    get_generated_route,
)

logger = logging.getLogger(__name__)


async def _get_coverage_area(area_id: PydanticObjectId) -> CoverageArea | None:
    """Fetch a coverage area by ID."""
    return await CoverageArea.get(area_id)


router = APIRouter()


@router.post("/api/coverage/areas/{area_id}/optimal-route")
async def start_optimal_route_generation(
    area_id: PydanticObjectId,
    start_lon: Annotated[float | None, Query(ge=-180, le=180)] = None,
    start_lat: Annotated[float | None, Query(ge=-90, le=90)] = None,
):
    area = await _get_coverage_area(area_id)
    if area is None:
        raise HTTPException(status_code=404, detail="Coverage area not found")
    existing = await Job.find_one(
        {
            "job_type": "optimal_route",
            "area_id": area_id,
            "spec.kind": "full_area",
            "spec.start_lon": start_lon,
            "spec.start_lat": start_lat,
            "status": {"$in": ["queued", "running", "pending", "initializing"]},
        },
        sort=[("created_at", -1)],
    )
    if existing and existing.task_id:
        return {"task_id": existing.task_id, "status": "already_running"}
    return await enqueue_generated_route(area, start_lon=start_lon, start_lat=start_lat)


class ClusterRouteRequest(BaseModel):
    segment_ids: list[str] = Field(..., min_length=1, max_length=10000)
    start_lon: float | None = Field(default=None, ge=-180, le=180)
    start_lat: float | None = Field(default=None, ge=-90, le=90)


@router.post("/api/coverage/areas/{area_id}/cluster-route")
async def start_cluster_route_generation(
    area_id: PydanticObjectId, body: ClusterRouteRequest
):
    area = await _get_coverage_area(area_id)
    if area is None:
        raise HTTPException(status_code=404, detail="Coverage area not found")
    return await enqueue_generated_route(
        area,
        segment_ids=sorted(set(body.segment_ids)),
        start_lon=body.start_lon,
        start_lat=body.start_lat,
    )


@router.get("/api/optimal-routes/worker-status")
async def get_worker_status():
    """Check if ARQ workers are connected and accepting tasks."""
    from tasks.arq import get_arq_pool

    try:
        redis = await get_arq_pool()
        heartbeat = await redis.get("arq:worker:heartbeat")
    except Exception as e:
        logger.exception("Failed to check worker status")
        return {
            "status": "error",
            "message": f"Failed to check worker status: {e}",
            "workers": [],
        }
    else:
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


@router.get("/api/generated-routes/{route_id}")
async def get_route_by_id(route_id: PydanticObjectId):
    return await get_generated_route(route_id)


def _gpx_response(route: dict) -> Response:
    from street_coverage.gpx import build_gpx_from_coords

    content = build_gpx_from_coords(
        route["coordinates"], name=f"Coverage Route - {route['location_name']}"
    )
    return Response(
        content=content,
        media_type="application/gpx+xml",
        headers={
            "Content-Disposition": f'attachment; filename="coverage_route_{route["route_id"]}.gpx"'
        },
    )


@router.get("/api/generated-routes/{route_id}/gpx")
async def export_route_by_id(route_id: PydanticObjectId):
    return _gpx_response(await get_generated_route(route_id))


@router.delete("/api/generated-routes/{route_id}")
async def delete_route_by_id(route_id: PydanticObjectId):
    await delete_generated_route(route_id)
    return {"status": "success"}


@router.get("/api/coverage/areas/{area_id}/optimal-route")
async def get_optimal_route(area_id: PydanticObjectId):
    area = await _get_coverage_area(area_id)
    if area is None:
        raise HTTPException(status_code=404, detail="Coverage area not found")
    if area.optimal_route_id is None:
        raise HTTPException(
            status_code=404,
            detail="No optimal route generated yet. Use POST to generate one.",
        )
    return await get_generated_route(area.optimal_route_id)


@router.get("/api/coverage/areas/{area_id}/optimal-route/gpx")
async def export_optimal_route_gpx(area_id: PydanticObjectId):
    return _gpx_response(await get_optimal_route(area_id))


@router.delete("/api/coverage/areas/{area_id}/optimal-route")
async def delete_optimal_route(area_id: PydanticObjectId):
    area = await _get_coverage_area(area_id)
    if area is None:
        raise HTTPException(status_code=404, detail="Coverage area not found")
    if area.optimal_route_id:
        await delete_generated_route(area.optimal_route_id)
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
    progress = await Job.find_one(
        {
            "job_type": "optimal_route",
            "location": area_id,
            "spec.kind": "full_area",
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
        "kind": progress.spec.get("kind"),
        "started_at": progress.started_at,
        "updated_at": progress.updated_at,
    }


@router.delete("/api/optimal-routes/{task_id}")
async def cancel_optimal_route_task(task_id: str):
    from tasks.ops import abort_job

    job = await Job.find_one({"job_type": "optimal_route", "task_id": task_id})
    if job is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if job.status in {"completed", "failed", "cancelled"}:
        return {"status": job.status}
    now = datetime.now(UTC)
    result = await Job.get_pymongo_collection().update_one(
        {"_id": job.id, "status": {"$nin": ["completed", "failed", "cancelled"]}},
        {
            "$set": {
                "status": "cancelled",
                "stage": "cancelled",
                "message": "Task cancelled by user",
                "completed_at": now,
                "updated_at": now,
            }
        },
    )
    if result.modified_count:
        await abort_job(task_id)
    return {"status": "cancelled", "message": "Route generation cancelled"}


@router.get("/api/optimal-routes/{task_id}/result")
async def get_optimal_route_result(task_id: str):
    route = await GeneratedRoute.find_one({"task_id": task_id})
    if route is None:
        raise HTTPException(
            status_code=404, detail="No saved route result is available for this task."
        )
    return await get_generated_route(route.id)


@router.get("/api/optimal-routes/{task_id}/progress")
async def get_optimal_route_progress(task_id: str):
    """Get current progress for an optimal route generation task."""
    progress = await Job.find_one({"job_type": "optimal_route", "task_id": task_id})

    if not progress:
        raise HTTPException(status_code=404, detail="Task not found")

    return {
        "task_id": task_id,
        "location_id": progress.location
        or (str(progress.area_id) if progress.area_id else None),
        "status": progress.status or "pending",
        "stage": progress.stage or "initializing",
        "progress": progress.progress or 0,
        "message": progress.message or "",
        "metrics": progress.metrics or {},
        "error": progress.error,
        "started_at": progress.started_at,
        "updated_at": progress.updated_at,
        "completed_at": progress.completed_at,
        "route_id": (progress.result or {}).get("route_id"),
    }


@router.get("/api/optimal-routes/{task_id}/progress/sse")
async def stream_optimal_route_progress(task_id: str):
    """Stream real-time progress updates via Server-Sent Events."""

    async def fetch():
        progress = await Job.find_one(
            {"job_type": "optimal_route", "task_id": task_id},
        )
        if not progress:
            return {
                "status": "pending",
                "stage": "waiting",
                "progress": 0,
                "message": "Waiting for task to start...",
            }
        return {
            "status": progress.status or "running",
            "stage": progress.stage or "initializing",
            "progress": progress.progress or 0,
            "message": progress.message or "",
            "metrics": progress.metrics or {},
            "error": progress.error,
            "started_at": progress.started_at,
            "updated_at": progress.updated_at,
            "completed_at": progress.completed_at,
            "route_id": (progress.result or {}).get("route_id"),
        }

    return sse_response(
        sse_event_stream(
            fetch,
            poll_interval=1,
            max_polls=1800,
            keepalive_every=10,
        ),
        **{"X-Accel-Buffering": "no"},
    )
