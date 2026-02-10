"""API routes for recurring route templates and build jobs."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from beanie import PydanticObjectId
from fastapi import APIRouter, Body, HTTPException, Query, status

from core.api import api_route
from core.jobs import JobHandle, create_job, find_job
from db.models import Job, RecurringRoute, Trip
from recurring_routes.models import BuildRecurringRoutesRequest, PatchRecurringRouteRequest
from recurring_routes.services.service import (
    normalize_hex_color,
    serialize_route_detail,
    serialize_route_summary,
)
from tasks.config import update_task_history_entry
from tasks.ops import abort_job, enqueue_task

logger = logging.getLogger(__name__)
router = APIRouter()

ACTIVE_JOB_STATUSES = {"queued", "pending", "running"}


def _route_query(
    *,
    q: str | None,
    min_trips: int,
    include_hidden: bool,
    imei: str | None,
) -> dict[str, Any]:
    query: dict[str, Any] = {"is_active": True}
    min_trips = max(1, int(min_trips))
    query["trip_count"] = {"$gte": min_trips}
    if not include_hidden:
        query["is_hidden"] = {"$ne": True}
    if imei:
        query["vehicle_imeis"] = str(imei).strip()

    if q:
        q = q.strip()
    if q:
        regex = {"$regex": q, "$options": "i"}
        query["$or"] = [
            {"name": regex},
            {"auto_name": regex},
            {"start_label": regex},
            {"end_label": regex},
        ]

    return query


@router.get("/api/recurring_routes", response_model=dict[str, Any])
@api_route(logger)
async def list_recurring_routes(
    q: str | None = None,
    min_trips: Annotated[int, Query(ge=1, le=50)] = 3,
    include_hidden: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    imei: str | None = None,
):
    """List recurring routes (route templates)."""
    query = _route_query(
        q=q,
        min_trips=min_trips,
        include_hidden=include_hidden,
        imei=imei,
    )

    cursor = (
        RecurringRoute.find(query)
        .sort([("is_pinned", -1), ("trip_count", -1), ("last_start_time", -1)])
        .skip(offset)
        .limit(limit)
    )
    routes = [serialize_route_summary(r) async for r in cursor]
    total = await RecurringRoute.find(query).count()
    return {"total": total, "routes": routes}


@router.get("/api/recurring_routes/{route_id}", response_model=dict[str, Any])
@api_route(logger)
async def get_recurring_route(route_id: str):
    """Get a single recurring route template."""
    try:
        oid = PydanticObjectId(route_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid route id") from exc

    route = await RecurringRoute.get(oid)
    if not route:
        raise HTTPException(status_code=404, detail="Route not found")

    return {"status": "success", "route": serialize_route_detail(route)}


@router.get("/api/recurring_routes/{route_id}/trips", response_model=dict[str, Any])
@api_route(logger)
async def list_trips_for_route(
    route_id: str,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """List trips assigned to a route template."""
    try:
        oid = PydanticObjectId(route_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid route id") from exc

    route = await RecurringRoute.get(oid)
    if not route:
        raise HTTPException(status_code=404, detail="Route not found")

    query = {"recurringRouteId": oid, "invalid": {"$ne": True}}
    trips_cursor = (
        Trip.find(query)
        .sort("-startTime")
        .skip(offset)
        .limit(limit)
    )

    trips = []
    async for trip in trips_cursor:
        data = trip.model_dump()
        trips.append(
            {
                "transactionId": data.get("transactionId"),
                "startTime": data.get("startTime"),
                "endTime": data.get("endTime"),
                "distance": data.get("distance"),
                "duration": data.get("duration"),
                "fuelConsumed": data.get("fuelConsumed"),
                "maxSpeed": data.get("maxSpeed"),
                "startLocation": data.get("startLocation"),
                "destination": data.get("destination"),
                "destinationPlaceName": data.get("destinationPlaceName"),
            },
        )

    total = await Trip.find(query).count()
    return {"total": total, "trips": trips, "route": {"id": route_id, "name": route.name, "auto_name": route.auto_name}}


@router.patch("/api/recurring_routes/{route_id}", response_model=dict[str, Any])
@api_route(logger)
async def patch_recurring_route(route_id: str, payload: PatchRecurringRouteRequest):
    """Update user-facing fields on a route template."""
    try:
        oid = PydanticObjectId(route_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid route id") from exc

    route = await RecurringRoute.get(oid)
    if not route:
        raise HTTPException(status_code=404, detail="Route not found")

    patch = payload.model_dump(exclude_unset=True)

    if "name" in patch:
        name = patch.get("name")
        if name is not None:
            cleaned = str(name).strip()
            route.name = cleaned or None
        else:
            route.name = None

    if "color" in patch:
        color_raw = patch.get("color")
        if color_raw is None:
            route.color = None
        else:
            normalized = normalize_hex_color(str(color_raw))
            if normalized is None:
                raise HTTPException(status_code=400, detail="Invalid color format; expected #RRGGBB")
            route.color = normalized

    if patch.get("is_pinned") is not None:
        route.is_pinned = bool(patch.get("is_pinned"))
    if patch.get("is_hidden") is not None:
        route.is_hidden = bool(patch.get("is_hidden"))

    route.updated_at = datetime.now(UTC)
    await route.save()

    return {"status": "success", "route": serialize_route_detail(route)}


async def _find_active_build_job() -> Job | None:
    cursor = Job.find(
        {
            "job_type": "recurring_routes_build",
            "status": {"$in": list(ACTIVE_JOB_STATUSES)},
        },
    ).sort("-created_at")
    return await cursor.first_or_none()


@router.post("/api/recurring_routes/jobs/build", response_model=dict[str, Any])
@api_route(logger)
async def start_recurring_routes_build(
    data: Annotated[dict[str, Any] | None, Body()] = None,
):
    """Start a background job to build recurring routes from stored trips."""
    active = await _find_active_build_job()
    if active and (active.operation_id or active.task_id):
        return {"status": "already_running", "job_id": active.operation_id or active.task_id}

    build_request = BuildRecurringRoutesRequest(**(data or {}))
    enqueue_result = await enqueue_task(
        "build_recurring_routes",
        build_request=build_request.model_dump(),
        manual_run=True,
    )
    job_id = enqueue_result.get("job_id")
    if not job_id:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to enqueue build job",
        )

    await create_job(
        "recurring_routes_build",
        operation_id=job_id,
        task_id=job_id,
        status="queued",
        stage="queued",
        progress=0.0,
        message="Task queued, waiting for worker...",
        started_at=datetime.now(UTC),
        metadata={"params": build_request.model_dump()},
    )

    return {"status": "queued", "job_id": job_id}


@router.get("/api/recurring_routes/jobs/{job_id}", response_model=dict[str, Any])
@api_route(logger)
async def get_recurring_routes_build(job_id: str):
    """Get progress for a recurring routes build job."""
    progress = await find_job("recurring_routes_build", operation_id=job_id)
    if not progress:
        raise HTTPException(status_code=404, detail="Job not found")

    return {
        "job_id": job_id,
        "stage": progress.stage or "unknown",
        "status": progress.status or "unknown",
        "progress": progress.progress or 0,
        "message": progress.message or "",
        "metrics": progress.metadata or {},
        "error": progress.error,
        "updated_at": progress.updated_at.isoformat() if progress.updated_at else None,
    }


@router.post("/api/recurring_routes/jobs/{job_id}/cancel", response_model=dict[str, Any])
@api_route(logger)
async def cancel_recurring_routes_build(job_id: str):
    """Cancel a running recurring routes build job."""
    progress = await find_job("recurring_routes_build", operation_id=job_id)
    if not progress:
        raise HTTPException(status_code=404, detail="Job not found")

    stage = (progress.stage or "").lower()
    status_value = (progress.status or "").lower()
    if stage in {"cancelled", "completed", "failed", "error"} or status_value in {"cancelled", "completed", "failed"}:
        return {"status": "already_finished", "job": await get_recurring_routes_build(job_id)}

    aborted = False
    try:
        aborted = await abort_job(job_id)
    except Exception as exc:
        logger.warning("Failed to abort job %s: %s", job_id, exc)

    now = datetime.now(UTC)
    await JobHandle(progress).update(
        status="cancelled",
        stage="cancelled",
        message="Cancelled by user",
        completed_at=now,
        metadata_patch={"cancelled": True},
    )

    try:
        await update_task_history_entry(
            job_id=job_id,
            task_name="build_recurring_routes",
            status="CANCELLED",
            manual_run=True,
            error="Cancelled by user",
            end_time=now,
        )
    except Exception as exc:
        logger.warning("Failed to update task history for cancelled job %s: %s", job_id, exc)

    return {"status": "cancelled", "aborted": aborted, "job": await get_recurring_routes_build(job_id)}

