"""API routes for trip querying and filtering."""

import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from core.api import api_route
from core.casting import safe_float
from core.coverage_clip import (
    CoverageClipContext,
    CoverageClipError,
    apply_clip_prefilter,
    clip_geojson_lines,
    parse_clip_bool,
    resolve_coverage_clip_context,
)
from core.date_utils import parse_timestamp
from core.spatial import GeometryService
from core.trip_source_policy import enforce_bouncie_source
from db import build_query_from_request
from db.models import CoverageArea, Trip
from trips.presentation import (
    build_trip_feature_properties,
    count_line_points,
    trip_to_dict,
)
from trips.services import TripCostService, TripQueryService
from trips.services.trip_ingest_issue_service import TripIngestIssueService


def _safe_int(value, default: int = 0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_bool_query_value(value: str | None) -> bool:
    return parse_clip_bool(value)


async def _resolve_coverage_clip_context(request: Request) -> CoverageClipContext:
    clip_requested = _parse_bool_query_value(request.query_params.get("clip_to_coverage"))
    area_id = str(request.query_params.get("coverage_area_id") or "").strip()
    area = None
    if clip_requested and not area_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="coverage_area_id is required when clip_to_coverage is true.",
        )

    if clip_requested:
        try:
            area = await CoverageArea.get(area_id)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid coverage_area_id: {area_id}",
            ) from exc

        if area is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Coverage area not found: {area_id}",
            )

    try:
        return resolve_coverage_clip_context(
            clip_requested=clip_requested,
            area=area,
            area_id=area_id or None,
        )
    except CoverageClipError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/matched_trips", tags=["Trips API"])
async def get_matched_trips(request: Request):
    """
    Stream matched trips as GeoJSON.

    Returns trips that have matchedGps data, using the matched geometry
    as the primary geometry for each feature.
    """
    query = await build_query_from_request(request)

    coverage_clip = await _resolve_coverage_clip_context(request)

    # Only include trips with matched GPS data
    query["matchedGps"] = {"$ne": None}
    # Exclude invalid trips
    query["invalid"] = {"$ne": True}
    query = enforce_bouncie_source(query)
    query = apply_clip_prefilter(query, coverage_clip, geometry_field="gps")

    trip_cursor = Trip.find(query).sort(-Trip.endTime)

    # Pre-fetch gas prices for cost calculation
    price_map = await TripCostService.get_fillup_price_map()

    async def stream():
        yield '{"type":"FeatureCollection","features":['
        first = True
        try:
            async for trip in trip_cursor:
                try:
                    trip_dict = trip_to_dict(trip)

                    matched_geom = GeometryService.parse_geojson(
                        trip_dict.get("matchedGps"),
                    )
                    # Skip trips without valid matched geometry
                    if not matched_geom or not matched_geom.get("coordinates"):
                        continue

                    num_points = count_line_points(matched_geom)
                    coverage_distance_miles = None
                    if coverage_clip.enabled:
                        clipped_geom, coverage_distance_miles = clip_geojson_lines(
                            matched_geom,
                            coverage_clip,
                        )
                        if clipped_geom is None:
                            continue
                        matched_geom = clipped_geom

                    props = build_trip_feature_properties(
                        trip_dict,
                        estimated_cost=TripCostService.calculate_trip_cost(
                            trip_dict,
                            price_map,
                        ),
                        points_recorded=num_points,
                        include_matched_at=True,
                        coverage_distance_miles=coverage_distance_miles,
                    )
                    feature = GeometryService.feature_from_geometry(matched_geom, props)
                    # Use default=str to handle any non-serializable types
                    chunk = json.dumps(feature, separators=(",", ":"), default=str)
                    if not first:
                        yield ","
                    yield chunk
                    first = False
                except Exception:
                    logger.exception("Error processing matched trip")
                    continue
        except Exception:
            logger.exception("Error in matched trips stream")
        finally:
            yield "]}"

    return StreamingResponse(stream(), media_type="application/geo+json")


@router.get("/api/failed_trips", tags=["Trips API"])
async def get_failed_trips(request: Request):
    """
    Get trips that failed map matching.

    Returns trips with matchStatus starting with 'skipped:' or 'error:',
    or trips that have no matchedGps and have been processed.
    """
    limit = _safe_int(request.query_params.get("limit", 100), 100)
    limit = min(limit, 500)  # Cap at 500

    # Query for failed/skipped match status
    query = {
        "$and": [
            {"invalid": {"$ne": True}},
            {
                "$or": [
                    {"matchStatus": {"$regex": "^skipped:", "$options": "i"}},
                    {"matchStatus": {"$regex": "^error:", "$options": "i"}},
                    {"matchStatus": {"$regex": "no-valid-geometry", "$options": "i"}},
                ],
            },
        ],
    }
    query = enforce_bouncie_source(query)

    trip_cursor = Trip.find(query).sort(-Trip.endTime).limit(limit)

    trips = []
    total = await Trip.find(query).count()

    async for trip in trip_cursor:
        try:
            if hasattr(trip, "model_dump"):
                trip_dict = trip.model_dump()
            elif hasattr(trip, "dict"):
                trip_dict = trip.dict()
            else:
                trip_dict = dict(trip)

            st = parse_timestamp(trip_dict.get("startTime"))
            et = parse_timestamp(trip_dict.get("endTime"))

            trips.append(
                {
                    "transactionId": trip_dict.get("transactionId"),
                    "imei": trip_dict.get("imei"),
                    "startTime": st.isoformat() if st else None,
                    "endTime": et.isoformat() if et else None,
                    "distance": safe_float(trip_dict.get("distance"), 0),
                    "startLocation": trip_dict.get("startLocation"),
                    "destination": trip_dict.get("destination"),
                    "matchStatus": trip_dict.get("matchStatus"),
                },
            )
        except Exception:
            logger.exception("Error processing failed trip")
            continue

    return {"total": total, "trips": trips}


@router.get("/api/trips", tags=["Trips API"])
async def get_trips(request: Request):
    """Stream all trips as GeoJSON to improve performance."""
    query = await build_query_from_request(request)
    matched_only = request.query_params.get("matched_only", "false").lower() == "true"
    coverage_clip = await _resolve_coverage_clip_context(request)

    # Exclude invalid trips by default
    query["invalid"] = {"$ne": True}

    if matched_only:
        query["matchedGps"] = {"$ne": None}
    query = enforce_bouncie_source(query)
    query = apply_clip_prefilter(query, coverage_clip, geometry_field="gps")
    # Use Beanie cursor iteration
    trip_cursor = Trip.find(query).sort(-Trip.endTime)

    # Pre-fetch gas prices for cost calculation
    price_map = await TripCostService.get_fillup_price_map()

    async def stream():
        yield '{"type":"FeatureCollection","features":['
        first = True
        try:
            async for trip in trip_cursor:
                try:
                    trip_dict = trip_to_dict(trip)

                    geom = GeometryService.parse_geojson(trip_dict.get("gps"))
                    matched_geom = GeometryService.parse_geojson(
                        trip_dict.get("matchedGps"),
                    )

                    # Use matched geometry as the main feature geometry if requested
                    final_geom = geom
                    if matched_only and matched_geom:
                        final_geom = matched_geom

                    num_points = count_line_points(final_geom)
                    coverage_distance_miles = None

                    if coverage_clip.enabled:
                        clipped_geom, coverage_distance_miles = clip_geojson_lines(
                            final_geom,
                            coverage_clip,
                        )
                        if clipped_geom is None:
                            continue
                        final_geom = clipped_geom

                    # Skip trips without valid geometry
                    if not final_geom or not final_geom.get("coordinates"):
                        logger.debug(
                            "Skipping trip %s: no valid geometry",
                            trip_dict.get("transactionId"),
                        )
                        continue

                    props = build_trip_feature_properties(
                        trip_dict,
                        estimated_cost=TripCostService.calculate_trip_cost(
                            trip_dict,
                            price_map,
                        ),
                        points_recorded=num_points,
                        coverage_distance_miles=coverage_distance_miles,
                    )
                    feature = GeometryService.feature_from_geometry(final_geom, props)
                    # Use default=str to handle any non-serializable types
                    chunk = json.dumps(feature, separators=(",", ":"), default=str)
                    if not first:
                        yield ","
                    yield chunk
                    first = False
                except Exception:
                    logger.exception("Error processing trip")
                    continue
        except Exception:
            logger.exception("Error in trips stream")
        finally:
            yield "]}"

    return StreamingResponse(stream(), media_type="application/geo+json")


@router.post("/api/trips/datatable", tags=["Trips API"])
@api_route(logger)
async def get_trips_datatable(request: Request):
    """Get trips data formatted for DataTables server-side processing."""
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid JSON payload for trips datatable request.",
        ) from exc

    draw = _safe_int(body.get("draw"), 1)
    start = _safe_int(body.get("start"), 0)
    length = _safe_int(body.get("length"), 10)
    search_value = body.get("search", {}).get("value", "")
    order = body.get("order", []) or []
    columns = body.get("columns", []) or []
    filters = body.get("filters", {}) or {}
    start_date = body.get("start_date") or filters.get("start_date")
    end_date = body.get("end_date") or filters.get("end_date")

    # Fetch gas prices for cost calculation
    price_map = await TripCostService.get_fillup_price_map()

    return await TripQueryService.get_trips_datatable(
        draw=draw,
        start=start,
        length=length,
        search_value=search_value,
        order=order,
        columns=columns,
        filters=filters,
        start_date=start_date,
        end_date=end_date,
        price_map=price_map,
    )


@router.get("/api/trips/invalid", tags=["Trips API"])
@api_route(logger)
async def get_invalid_trips():
    """Get all invalid trips for review."""
    return await TripQueryService.get_invalid_trips()


@router.get("/api/trips/ingest-issues", tags=["Trips API"])
@api_route(logger)
async def list_trip_ingest_issues(
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    issue_type: Annotated[str | None, Query()] = None,
    include_resolved: Annotated[bool, Query()] = False,
    search: Annotated[str | None, Query()] = None,
):
    """List recent trip fetch/processing issues for review in Settings."""
    return await TripIngestIssueService.list_issues(
        page=page,
        limit=limit,
        issue_type=issue_type,
        include_resolved=include_resolved,
        search=search,
    )


@router.post("/api/trips/ingest-issues/{issue_id}/resolve", tags=["Trips API"])
@api_route(logger)
async def resolve_trip_ingest_issue(issue_id: str):
    """Mark a trip ingest issue as resolved/dismissed."""
    ok = await TripIngestIssueService.resolve_issue(issue_id)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Issue not found",
        )
    return {"status": "success"}


@router.delete("/api/trips/ingest-issues/{issue_id}", tags=["Trips API"])
@api_route(logger)
async def delete_trip_ingest_issue(issue_id: str):
    """Delete an ingest issue entry."""
    ok = await TripIngestIssueService.delete_issue(issue_id)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Issue not found",
        )
    return {"status": "success"}


@router.post("/api/trips/ingest-issues/bulk_resolve", tags=["Trips API"])
@api_route(logger)
async def bulk_resolve_trip_ingest_issues(request: Request):
    """Bulk resolve/dismiss matching ingest issues (does not delete trips)."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    issue_type = body.get("issue_type") or None
    search = body.get("search") or None

    resolved = await TripIngestIssueService.bulk_resolve(
        issue_type=issue_type,
        search=search,
    )
    return {"status": "success", "resolved": resolved}


@router.post("/api/trips/ingest-issues/bulk_delete", tags=["Trips API"])
@api_route(logger)
async def bulk_delete_trip_ingest_issues(request: Request):
    """Bulk delete matching ingest issue records (does not delete trips)."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    issue_type = body.get("issue_type") or None
    include_resolved = bool(body.get("include_resolved"))
    search = body.get("search") or None

    deleted = await TripIngestIssueService.bulk_delete(
        issue_type=issue_type,
        include_resolved=include_resolved,
        search=search,
    )
    return {"status": "success", "deleted": deleted}
