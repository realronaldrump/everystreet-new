"""The durable result of Route Generation, independent of job retention."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from fastapi import HTTPException

from db.models import CoverageArea, GeneratedRoute, Job


async def update_route_progress(task_id: str, **fields) -> None:
    fields["updated_at"] = datetime.now(UTC)
    result = await Job.get_pymongo_collection().update_one(
        {
            "job_type": "optimal_route",
            "task_id": task_id,
            "status": {"$nin": ["cancelled", "completed"]},
        },
        {"$set": fields},
    )
    if result.matched_count != 1:
        raise asyncio.CancelledError("Route generation cancelled")


def serialize_route(route: GeneratedRoute, area: CoverageArea) -> dict[str, Any]:
    return {
        **route.result,
        "route_id": str(route.id),
        "area_id": str(route.area_id),
        "area_version": route.area_version,
        "kind": route.kind,
        "selected_segment_ids": route.segment_ids,
        "start_coords": route.start_coords,
        "generated_at": route.created_at.isoformat(),
        "location_name": area.display_name,
        "coverage_changed": route.journal_revision != area.journal_revision,
    }


async def get_generated_route(route_id: PydanticObjectId) -> dict[str, Any]:
    route = await GeneratedRoute.get(route_id)
    if route is None:
        raise HTTPException(
            status_code=404,
            detail="This route no longer exists. Choose or generate a route in Route Planner.",
        )
    area = await CoverageArea.get(route.area_id)
    if area is None:
        raise HTTPException(
            status_code=404, detail="The route's coverage area no longer exists."
        )
    if area.area_version != route.area_version or area.status != "ready":
        raise HTTPException(
            status_code=409,
            detail="The coverage area's streets changed. Generate a new route in Route Planner.",
        )
    return serialize_route(route, area)


async def complete_generated_route(
    *,
    task_id: str,
    area_id: PydanticObjectId,
    area_version: int,
    journal_revision: int,
    segment_ids: set[str] | None,
    start_coords: tuple[float, float] | None,
    result: dict[str, Any],
) -> dict[str, Any]:
    """Save the result, area pointer and completion atomically, or publish no success."""
    client = GeneratedRoute.get_pymongo_collection().database.client

    async def commit(session):
        area = await CoverageArea.get(area_id, session=session)
        if area is None or area.area_version != area_version or area.status != "ready":
            raise ValueError(
                "Coverage area changed during route generation. Generate a new route."
            )
        job = await Job.find_one(
            {"job_type": "optimal_route", "task_id": task_id}, session=session
        )
        if job is not None and job.status == "cancelled":
            raise asyncio.CancelledError("Route generation cancelled")
        if job is None or job.status == "failed":
            raise ValueError("Route generation was cancelled or is no longer active")
        route = await GeneratedRoute.find_one({"task_id": task_id}, session=session)
        if route is None:
            route = GeneratedRoute(
                task_id=task_id,
                area_id=area_id,
                area_version=area_version,
                journal_revision=journal_revision,
                kind="cluster" if segment_ids is not None else "full_area",
                segment_ids=sorted(segment_ids or []),
                start_coords=list(start_coords) if start_coords else None,
                result=result,
            )
            await route.insert(session=session)
            if segment_ids is None:
                await CoverageArea.get_pymongo_collection().update_one(
                    {"_id": area_id, "area_version": area_version},
                    {
                        "$set": {
                            "optimal_route_id": route.id,
                            "optimal_route_generated_at": route.created_at,
                        }
                    },
                    session=session,
                )
        now = datetime.now(UTC)
        await Job.get_pymongo_collection().update_one(
            {"_id": job.id},
            {
                "$set": {
                    "status": "completed",
                    "stage": "completed",
                    "progress": 100.0,
                    "message": "Route generation complete!",
                    "result": {"route_id": str(route.id)},
                    "completed_at": now,
                    "updated_at": now,
                }
            },
            session=session,
        )
        return serialize_route(route, area)

    async with client.start_session() as session:
        return await session.with_transaction(commit)


async def delete_generated_route(route_id: PydanticObjectId) -> None:
    client = GeneratedRoute.get_pymongo_collection().database.client

    async def commit(session):
        route = await GeneratedRoute.get(route_id, session=session)
        if route is None:
            raise HTTPException(status_code=404, detail="Route not found")
        await CoverageArea.get_pymongo_collection().update_one(
            {"_id": route.area_id, "optimal_route_id": route_id},
            {"$set": {"optimal_route_id": None, "optimal_route_generated_at": None}},
            session=session,
        )
        await route.delete(session=session)

    async with client.start_session() as session:
        await session.with_transaction(commit)


async def enqueue_generated_route(
    area: CoverageArea,
    *,
    segment_ids: list[str] | None = None,
    start_lon: float | None = None,
    start_lat: float | None = None,
):
    from uuid import uuid4

    from core.jobs import create_job
    from tasks.ops import enqueue_task

    if area.status != "ready":
        raise HTTPException(
            status_code=409, detail="Coverage area is not ready for route generation."
        )
    if (start_lon is None) != (start_lat is None):
        raise HTTPException(
            status_code=422, detail="Provide both start longitude and latitude."
        )
    kind = "cluster" if segment_ids is not None else "full_area"
    task_id = str(uuid4())
    handle = await create_job(
        "optimal_route",
        task_id=task_id,
        area_id=area.id,
        location=str(area.id),
        status="queued",
        stage="queued",
        message="Route queued, waiting for worker...",
        spec={
            "kind": kind,
            "area_version": area.area_version,
            "segment_ids": segment_ids or [],
            "start_lon": start_lon,
            "start_lat": start_lat,
        },
    )
    try:
        await enqueue_task(
            "generate_optimal_route",
            location_id=str(area.id),
            start_lon=start_lon,
            start_lat=start_lat,
            segment_ids=segment_ids,
            manual_run=True,
            _job_id=task_id,
        )
    except Exception as exc:
        await handle.fail(str(exc), message="Route could not be queued. Try again.")
        raise
    return {"task_id": task_id, "status": "started"}
