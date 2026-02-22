"""API routes for recurring route templates and build jobs."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from beanie import PydanticObjectId
from fastapi import APIRouter, Body, HTTPException, Query, status

from core.api import api_route
from core.jobs import JobHandle, create_job, find_job
from core.spatial import GeometryService
from core.trip_source_policy import enforce_bouncie_source
from db.aggregation_utils import get_mongo_tz_expr
from db.models import Job, Place, RecurringRoute, Trip
from recurring_routes.models import (
    BuildRecurringRoutesRequest,
    PatchRecurringRouteRequest,
)
from recurring_routes.services.place_pair_analysis import analyze_place_pair
from recurring_routes.services.service import (
    build_place_link,
    coerce_place_id,
    compute_trips_per_week,
    extract_location_label,
    find_place_id_for_point,
    normalize_hex_color,
    resolve_places_by_ids,
    serialize_route_detail_with_place_links,
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


def _route_place_id(route: RecurringRoute, *field_names: str) -> str | None:
    for field in field_names:
        place_id = coerce_place_id(getattr(route, field, None))
        if place_id:
            return place_id
    return None


async def _resolve_raw_route_geometry(route: RecurringRoute) -> dict[str, Any] | None:
    """Resolve route geometry strictly from raw trip GPS data."""
    rep_trip_id = str(route.representative_trip_id or "").strip()
    trip: Trip | None = None

    if rep_trip_id:
        trip = await Trip.find_one(
            enforce_bouncie_source(
                {
                    "transactionId": rep_trip_id,
                    "invalid": {"$ne": True},
                },
            ),
        )

    if trip is None and route.id:
        trip = (
            await Trip.find(
                enforce_bouncie_source(
                    {
                        "recurringRouteId": route.id,
                        "invalid": {"$ne": True},
                        "gps": {"$ne": None},
                    },
                ),
            )
            .sort("-startTime")
            .limit(1)
            .first_or_none()
        )

    if trip is None:
        return None

    trip_data = trip.model_dump()
    return GeometryService.parse_geojson(trip_data.get("gps"))


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
    route_docs = [r async for r in cursor]

    needs_centroid_lookup = any(
        (
            _route_place_id(route, "start_place_id", "startPlaceId") is None
            and isinstance(route.start_centroid, list)
            and bool(route.start_centroid)
        )
        or (
            _route_place_id(route, "end_place_id", "endPlaceId") is None
            and isinstance(route.end_centroid, list)
            and bool(route.end_centroid)
        )
        for route in route_docs
    )
    all_places: list[Place] = (
        await Place.find_all().to_list() if needs_centroid_lookup else []
    )

    resolved_place_ids: list[tuple[str | None, str | None]] = []
    place_ids: set[str] = set()
    for route in route_docs:
        start_place_id = _route_place_id(route, "start_place_id", "startPlaceId")
        end_place_id = _route_place_id(route, "end_place_id", "endPlaceId")

        if (
            not start_place_id
            and all_places
            and isinstance(route.start_centroid, list)
            and route.start_centroid
        ):
            start_place_id = find_place_id_for_point(route.start_centroid, all_places)
        if (
            not end_place_id
            and all_places
            and isinstance(route.end_centroid, list)
            and route.end_centroid
        ):
            end_place_id = find_place_id_for_point(route.end_centroid, all_places)

        if start_place_id:
            place_ids.add(start_place_id)
        if end_place_id:
            place_ids.add(end_place_id)
        resolved_place_ids.append((start_place_id, end_place_id))

    places_by_id = await resolve_places_by_ids(place_ids)
    routes: list[dict[str, Any]] = []
    for route, (start_place_id, end_place_id) in zip(
        route_docs,
        resolved_place_ids,
        strict=False,
    ):
        item = serialize_route_summary(route)
        start_link = build_place_link(
            start_place_id,
            places_by_id=places_by_id,
            default_label=route.start_label,
        )
        end_link = build_place_link(
            end_place_id,
            places_by_id=places_by_id,
            default_label=route.end_label,
        )
        if start_link:
            item["start_label"] = start_link.get("label") or item.get("start_label")
        if end_link:
            item["end_label"] = end_link.get("label") or item.get("end_label")
        item["start_place_id"] = start_place_id
        item["end_place_id"] = end_place_id
        item["place_links"] = {"start": start_link, "end": end_link}
        routes.append(item)

    total = await RecurringRoute.find(query).count()
    return {"total": total, "routes": routes}


@router.get("/api/recurring_routes/place_pair_analysis", response_model=dict[str, Any])
@api_route(logger)
async def get_place_pair_analysis(
    start_place_id: Annotated[str, Query(min_length=1)],
    end_place_id: Annotated[str, Query(min_length=1)],
    include_reverse: bool = False,
    timeframe: Annotated[str, Query(pattern="^(90d|all)$")] = "all",
    limit: Annotated[int, Query(ge=1, le=500)] = 500,
):
    """Analyze trips between two places, optionally including reverse direction."""
    try:
        return await analyze_place_pair(
            start_place_id=start_place_id,
            end_place_id=end_place_id,
            include_reverse=bool(include_reverse),
            timeframe=timeframe,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


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

    route_data = await serialize_route_detail_with_place_links(route)
    route_data["geometry"] = await _resolve_raw_route_geometry(route)

    return {
        "status": "success",
        "route": route_data,
    }


@router.get("/api/recurring_routes/{route_id}/trips", response_model=dict[str, Any])
@api_route(logger)
async def list_trips_for_route(
    route_id: str,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    include_geometry: bool = False,
):
    """List trips assigned to a route template."""
    try:
        oid = PydanticObjectId(route_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid route id") from exc

    route = await RecurringRoute.get(oid)
    if not route:
        raise HTTPException(status_code=404, detail="Route not found")

    query = enforce_bouncie_source({"recurringRouteId": oid, "invalid": {"$ne": True}})
    trips_cursor = Trip.find(query).sort("-startTime").skip(offset).limit(limit)

    raw_trips: list[dict[str, Any]] = []
    place_ids: set[str] = set()
    async for trip in trips_cursor:
        data = trip.model_dump()
        raw_trips.append(data)

        start_place_id = coerce_place_id(data.get("startPlaceId"))
        destination_place_id = coerce_place_id(data.get("destinationPlaceId"))
        if start_place_id:
            place_ids.add(start_place_id)
        if destination_place_id:
            place_ids.add(destination_place_id)

    places_by_id = await resolve_places_by_ids(place_ids)
    trips = []
    for data in raw_trips:
        start_place_id = coerce_place_id(data.get("startPlaceId"))
        destination_place_id = coerce_place_id(data.get("destinationPlaceId"))
        start_label = extract_location_label(data.get("startLocation"))
        destination_label = str(
            data.get("destinationPlaceName") or "",
        ).strip() or extract_location_label(data.get("destination"))

        start_link = build_place_link(
            start_place_id,
            places_by_id=places_by_id,
            default_label=start_label,
        )
        destination_link = build_place_link(
            destination_place_id,
            places_by_id=places_by_id,
            default_label=destination_label,
        )

        trip_data = {
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
            "startPlaceId": start_place_id,
            "destinationPlaceId": destination_place_id,
            "startPlaceLabel": start_link.get("label") if start_link else start_label,
            "destinationPlaceLabel": (
                destination_link.get("label") if destination_link else destination_label
            ),
            "place_links": {
                "start": start_link,
                "end": destination_link,
            },
        }
        if include_geometry:
            trip_data["gps"] = data.get("gps")
        trips.append(trip_data)

    total = await Trip.find(query).count()
    return {
        "total": total,
        "trips": trips,
        "route": {"id": route_id, "name": route.name, "auto_name": route.auto_name},
    }


@router.get("/api/recurring_routes/{route_id}/analytics", response_model=dict[str, Any])
@api_route(logger)
async def get_route_analytics(route_id: str):
    """Return time-of-day, day-of-week, and temporal trend analytics for a route."""
    try:
        oid = PydanticObjectId(route_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid route id") from exc

    route = await RecurringRoute.get(oid)
    if not route:
        raise HTTPException(status_code=404, detail="Route not found")

    trips_coll = Trip.get_pymongo_collection()
    tz_expr = get_mongo_tz_expr()

    # Aggregate time patterns from all trips on this route
    pipeline = [
        {
            "$match": enforce_bouncie_source(
                {"recurringRouteId": oid, "invalid": {"$ne": True}},
            ),
        },
        {
            "$project": {
                "startTime": 1,
                "endTime": 1,
                "distance": 1,
                "duration": 1,
                "fuelConsumed": 1,
                "maxSpeed": 1,
                "hour": {"$hour": {"date": "$startTime", "timezone": tz_expr}},
                "dayOfWeek": {
                    "$dayOfWeek": {"date": "$startTime", "timezone": tz_expr},
                },
                "yearMonth": {
                    "$dateToString": {
                        "format": "%Y-%m",
                        "date": "$startTime",
                        "timezone": tz_expr,
                    },
                },
            },
        },
        {
            "$facet": {
                "byHour": [
                    {
                        "$group": {
                            "_id": "$hour",
                            "count": {"$sum": 1},
                            "avgDistance": {"$avg": "$distance"},
                            "avgDuration": {"$avg": "$duration"},
                        },
                    },
                    {"$sort": {"_id": 1}},
                ],
                "byDayOfWeek": [
                    {
                        "$group": {
                            "_id": "$dayOfWeek",
                            "count": {"$sum": 1},
                            "avgDistance": {"$avg": "$distance"},
                            "avgDuration": {"$avg": "$duration"},
                        },
                    },
                    {"$sort": {"_id": 1}},
                ],
                "byMonth": [
                    {
                        "$group": {
                            "_id": "$yearMonth",
                            "count": {"$sum": 1},
                            "totalDistance": {"$sum": "$distance"},
                            "avgDistance": {"$avg": "$distance"},
                            "avgDuration": {"$avg": "$duration"},
                        },
                    },
                    {"$sort": {"_id": 1}},
                    {"$limit": 24},
                ],
                "tripTimeline": [
                    {"$sort": {"startTime": 1}},
                    {
                        "$project": {
                            "startTime": 1,
                            "distance": 1,
                            "duration": 1,
                            "maxSpeed": 1,
                        },
                    },
                ],
                "stats": [
                    {
                        "$group": {
                            "_id": None,
                            "totalTrips": {"$sum": 1},
                            "totalDistance": {"$sum": "$distance"},
                            "totalDuration": {"$sum": "$duration"},
                            "avgDistance": {"$avg": "$distance"},
                            "avgDuration": {"$avg": "$duration"},
                            "minDistance": {"$min": "$distance"},
                            "maxDistance": {"$max": "$distance"},
                            "minDuration": {"$min": "$duration"},
                            "maxDuration": {"$max": "$duration"},
                            "avgMaxSpeed": {"$avg": "$maxSpeed"},
                            "maxMaxSpeed": {"$max": "$maxSpeed"},
                            "totalFuel": {"$sum": "$fuelConsumed"},
                            "avgFuel": {"$avg": "$fuelConsumed"},
                            "firstTrip": {"$min": "$startTime"},
                            "lastTrip": {"$max": "$startTime"},
                        },
                    },
                ],
            },
        },
    ]

    results = await trips_coll.aggregate(pipeline).to_list(1)
    facets = results[0] if results else {}

    # Fill in all 24 hours
    hour_map = {h["_id"]: h for h in facets.get("byHour", [])}
    by_hour = []
    for h in range(24):
        entry = hour_map.get(h, {})
        by_hour.append(
            {
                "hour": h,
                "count": entry.get("count", 0),
                "avgDistance": entry.get("avgDistance"),
                "avgDuration": entry.get("avgDuration"),
            },
        )

    # Fill in all 7 days (MongoDB: 1=Sun, 2=Mon, ..., 7=Sat)
    day_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    dow_map = {d["_id"]: d for d in facets.get("byDayOfWeek", [])}
    by_day = []
    for d in range(1, 8):
        entry = dow_map.get(d, {})
        by_day.append(
            {
                "day": d,
                "dayName": day_names[d - 1],
                "count": entry.get("count", 0),
                "avgDistance": entry.get("avgDistance"),
                "avgDuration": entry.get("avgDuration"),
            },
        )

    # Process timeline data
    timeline = []
    for t in facets.get("tripTimeline", []):
        st = t.get("startTime")
        timeline.append(
            {
                "startTime": st.isoformat() if st else None,
                "distance": t.get("distance"),
                "duration": t.get("duration"),
                "maxSpeed": t.get("maxSpeed"),
            },
        )

    stats_source = facets.get("stats", [{}])[0] if facets.get("stats") else {}
    stats_raw = dict(stats_source) if isinstance(stats_source, dict) else {}
    stats_raw.pop("_id", None)
    first_trip_dt = stats_raw.get("firstTrip")
    last_trip_dt = stats_raw.get("lastTrip")
    # Serialize dates
    for key in ("firstTrip", "lastTrip"):
        val = stats_raw.get(key)
        if val:
            stats_raw[key] = val.isoformat() if hasattr(val, "isoformat") else str(val)

    # Compute trip frequency from Sunday-Saturday calendar weeks.
    first_trip = first_trip_dt if isinstance(first_trip_dt, datetime) else None
    last_trip = last_trip_dt if isinstance(last_trip_dt, datetime) else None
    trips_per_week = compute_trips_per_week(
        total_trips=stats_raw.get("totalTrips", 0),
        first_trip=first_trip,
        last_trip=last_trip,
    )

    return {
        "status": "success",
        "route_id": route_id,
        "byHour": by_hour,
        "byDayOfWeek": by_day,
        "byMonth": facets.get("byMonth", []),
        "timeline": timeline,
        "stats": stats_raw,
        "tripsPerWeek": trips_per_week,
    }


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
                raise HTTPException(
                    status_code=400,
                    detail="Invalid color format; expected #RRGGBB",
                )
            route.color = normalized

    if patch.get("is_pinned") is not None:
        route.is_pinned = bool(patch.get("is_pinned"))
    if patch.get("is_hidden") is not None:
        route.is_hidden = bool(patch.get("is_hidden"))

    route.updated_at = datetime.now(UTC)
    await route.save()

    return {
        "status": "success",
        "route": await serialize_route_detail_with_place_links(route),
    }


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
        return {
            "status": "already_running",
            "job_id": active.operation_id or active.task_id,
        }

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


@router.post(
    "/api/recurring_routes/jobs/{job_id}/cancel",
    response_model=dict[str, Any],
)
@api_route(logger)
async def cancel_recurring_routes_build(job_id: str):
    """Cancel a running recurring routes build job."""
    progress = await find_job("recurring_routes_build", operation_id=job_id)
    if not progress:
        raise HTTPException(status_code=404, detail="Job not found")

    stage = (progress.stage or "").lower()
    status_value = (progress.status or "").lower()
    if stage in {"cancelled", "completed", "failed", "error"} or status_value in {
        "cancelled",
        "completed",
        "failed",
    }:
        return {
            "status": "already_finished",
            "job": await get_recurring_routes_build(job_id),
        }

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
        logger.warning(
            "Failed to update task history for cancelled job %s: %s",
            job_id,
            exc,
        )

    return {
        "status": "cancelled",
        "aborted": aborted,
        "job": await get_recurring_routes_build(job_id),
    }
