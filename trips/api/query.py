"""API routes for trip querying and filtering."""

import json
import logging
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from shapely.geometry import MultiLineString, MultiPolygon, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from core.api import api_route
from core.casting import safe_float
from core.date_utils import parse_timestamp
from core.spatial import GeometryService, geodesic_length_meters
from core.trip_source_policy import enforce_bouncie_source
from db import build_query_from_request
from db.models import CoverageArea, Trip
from trips.services import TripCostService, TripQueryService
from trips.services.trip_ingest_issue_service import TripIngestIssueService


def _safe_int(value, default: int = 0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _first_non_empty(*values):
    for value in values:
        if value not in (None, ""):
            return value
    return None


def _derive_timezone_fields(trip_dict: dict) -> tuple[str | None, str | None, str | None]:
    start_tz = _first_non_empty(trip_dict.get("startTimeZone"))
    end_tz = _first_non_empty(trip_dict.get("endTimeZone"))
    alias = _first_non_empty(start_tz, end_tz)
    return start_tz, end_tz, alias


def _parse_bool_query_value(value: str | None) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _coerce_geojson_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def _extract_polygon_geometries(value: Any) -> list[BaseGeometry]:
    geojson = _coerce_geojson_object(value)
    if not geojson:
        return []

    geo_type = str(geojson.get("type") or "").strip()
    if geo_type == "FeatureCollection":
        features = geojson.get("features")
        if not isinstance(features, list):
            return []
        geometries: list[BaseGeometry] = []
        for feature in features:
            geometries.extend(_extract_polygon_geometries(feature))
        return geometries

    if geo_type == "Feature":
        return _extract_polygon_geometries(geojson.get("geometry"))

    if geo_type not in {"Polygon", "MultiPolygon"}:
        return []

    try:
        parsed = shape(geojson)
    except Exception:
        logger.warning("Failed to parse coverage boundary geometry", exc_info=True)
        return []

    if parsed.is_empty:
        return []
    return [parsed]


def _extract_polygonal_geometry(geometry: BaseGeometry | None) -> BaseGeometry | None:
    if geometry is None or geometry.is_empty:
        return None

    if geometry.geom_type in {"Polygon", "MultiPolygon"}:
        return geometry

    if geometry.geom_type != "GeometryCollection":
        return None

    polygons: list[BaseGeometry] = []
    for part in geometry.geoms:
        polygon_part = _extract_polygonal_geometry(part)
        if polygon_part is None:
            continue
        if polygon_part.geom_type == "Polygon":
            polygons.append(polygon_part)
        elif polygon_part.geom_type == "MultiPolygon":
            polygons.extend(list(polygon_part.geoms))

    if not polygons:
        return None
    if len(polygons) == 1:
        return polygons[0]
    return MultiPolygon(polygons)


def _normalize_coverage_boundary_geometry(boundary: Any) -> BaseGeometry | None:
    geometries = _extract_polygon_geometries(boundary)
    if not geometries:
        return None

    merged: BaseGeometry
    if len(geometries) == 1:
        merged = geometries[0]
    else:
        merged = unary_union(geometries)

    polygonal = _extract_polygonal_geometry(merged)
    if polygonal is None:
        return None

    if polygonal.is_valid:
        return polygonal

    # Attempt a lightweight topology fix when rings self-intersect.
    try:
        fixed = polygonal.buffer(0)
    except Exception:
        return polygonal

    fixed_polygonal = _extract_polygonal_geometry(fixed)
    return fixed_polygonal if fixed_polygonal is not None else polygonal


def _coverage_bbox_polygon(coverage_geometry: BaseGeometry) -> dict[str, Any] | None:
    if coverage_geometry.is_empty:
        return None

    min_lon, min_lat, max_lon, max_lat = coverage_geometry.bounds
    if min_lon >= max_lon or min_lat >= max_lat:
        return None

    return {
        "type": "Polygon",
        "coordinates": [
            [
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ],
        ],
    }


def _extract_line_geometry(geometry: BaseGeometry | None) -> BaseGeometry | None:
    if geometry is None or geometry.is_empty:
        return None

    if geometry.geom_type in {"LineString", "MultiLineString"}:
        return geometry

    if geometry.geom_type != "GeometryCollection":
        return None

    parts: list[BaseGeometry] = []
    for part in geometry.geoms:
        line_part = _extract_line_geometry(part)
        if line_part is None:
            continue
        if line_part.geom_type == "LineString":
            parts.append(line_part)
        elif line_part.geom_type == "MultiLineString":
            parts.extend(list(line_part.geoms))

    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return MultiLineString([list(line.coords) for line in parts])


def _clip_lines_to_coverage(
    geometry: dict[str, Any] | None,
    coverage_geometry: BaseGeometry,
) -> tuple[dict[str, Any] | None, float | None]:
    parsed_geometry = GeometryService.parse_geojson(geometry)
    if not parsed_geometry:
        return None, None

    geom_type = str(parsed_geometry.get("type") or "").strip()
    if geom_type not in {"LineString", "MultiLineString"}:
        return None, None

    try:
        line_geometry = shape(parsed_geometry)
    except Exception:
        logger.warning("Failed to parse trip line geometry for clipping", exc_info=True)
        return None, None

    if line_geometry.is_empty:
        return None, None

    try:
        intersection = line_geometry.intersection(coverage_geometry)
    except Exception:
        logger.warning("Failed to intersect trip geometry with coverage area", exc_info=True)
        return None, None

    clipped_lines = _extract_line_geometry(intersection)
    if clipped_lines is None or clipped_lines.is_empty:
        return None, None

    try:
        coverage_miles = geodesic_length_meters(clipped_lines) / 1609.344
    except Exception:
        coverage_miles = None

    return mapping(clipped_lines), coverage_miles


def _count_line_points(geometry: dict[str, Any] | None) -> int:
    if not isinstance(geometry, dict):
        return 0

    geo_type = geometry.get("type")
    coords = geometry.get("coordinates")

    if geo_type == "LineString" and isinstance(coords, list):
        return len(coords)

    if geo_type == "MultiLineString" and isinstance(coords, list):
        return sum(len(line) for line in coords if isinstance(line, list))

    return 0


@dataclass(slots=True)
class _CoverageClipContext:
    active: bool = False
    area_id: str | None = None
    coverage_geometry: BaseGeometry | None = None
    prefilter_geometry: dict[str, Any] | None = None


async def _resolve_coverage_clip_context(request: Request) -> _CoverageClipContext:
    clip_requested = _parse_bool_query_value(request.query_params.get("clip_to_coverage"))
    area_id = str(request.query_params.get("coverage_area_id") or "").strip()
    context = _CoverageClipContext(area_id=area_id or None)

    if not clip_requested or not area_id:
        return context

    try:
        area = await CoverageArea.get(area_id)
    except Exception:
        logger.warning("Coverage clipping requested with invalid area id: %s", area_id)
        return context

    if area is None:
        logger.warning("Coverage clipping requested but area not found: %s", area_id)
        return context

    coverage_geometry = _normalize_coverage_boundary_geometry(getattr(area, "boundary", None))
    if coverage_geometry is None:
        logger.warning(
            "Coverage clipping requested but boundary is unusable for area %s",
            area_id,
        )
        return context

    context.active = True
    context.coverage_geometry = coverage_geometry
    context.prefilter_geometry = _coverage_bbox_polygon(coverage_geometry)
    return context


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
    if coverage_clip.active and coverage_clip.prefilter_geometry:
        query["gps"] = {"$geoIntersects": {"$geometry": coverage_clip.prefilter_geometry}}

    trip_cursor = Trip.find(query).sort(-Trip.endTime)

    # Pre-fetch gas prices for cost calculation
    price_map = await TripCostService.get_fillup_price_map()

    async def stream():
        yield '{"type":"FeatureCollection","features":['
        first = True
        try:
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
                    duration = (et - st).total_seconds() if st and et else None

                    matched_geom = GeometryService.parse_geojson(
                        trip_dict.get("matchedGps"),
                    )
                    # Skip trips without valid matched geometry
                    if not matched_geom or not matched_geom.get("coordinates"):
                        continue

                    num_points = _count_line_points(matched_geom)
                    coverage_distance_miles = None
                    if coverage_clip.active and coverage_clip.coverage_geometry is not None:
                        clipped_geom, coverage_distance_miles = _clip_lines_to_coverage(
                            matched_geom,
                            coverage_clip.coverage_geometry,
                        )
                        if clipped_geom is None:
                            continue
                        matched_geom = clipped_geom

                    matched_at = trip_dict.get("matched_at")
                    total_idle_duration = trip_dict.get("totalIdleDuration")
                    avg_speed = trip_dict.get("avgSpeed")
                    start_tz, end_tz, alias_tz = _derive_timezone_fields(trip_dict)
                    props = {
                        "transactionId": trip_dict.get("transactionId"),
                        "imei": trip_dict.get("imei"),
                        "startTime": st.isoformat() if st else None,
                        "endTime": et.isoformat() if et else None,
                        "duration": duration,
                        "distance": safe_float(trip_dict.get("distance"), 0),
                        "maxSpeed": safe_float(trip_dict.get("maxSpeed"), 0),
                        "startTimeZone": start_tz,
                        "endTimeZone": end_tz,
                        "timeZone": alias_tz,
                        "startLocation": trip_dict.get("startLocation"),
                        "destination": trip_dict.get("destination"),
                        "totalIdleDuration": total_idle_duration,
                        "fuelConsumed": safe_float(trip_dict.get("fuelConsumed"), 0),
                        "source": trip_dict.get("source"),
                        "hardBrakingCounts": trip_dict.get("hardBrakingCounts"),
                        "hardAccelerationCounts": trip_dict.get(
                            "hardAccelerationCounts",
                        ),
                        "startOdometer": trip_dict.get("startOdometer"),
                        "endOdometer": trip_dict.get("endOdometer"),
                        "avgSpeed": avg_speed,
                        "pointsRecorded": num_points,
                        "estimated_cost": TripCostService.calculate_trip_cost(
                            trip_dict,
                            price_map,
                        ),
                        "matchStatus": trip_dict.get("matchStatus"),
                        "matched_at": (
                            matched_at.isoformat()
                            if hasattr(matched_at, "isoformat")
                            else str(matched_at)
                            if matched_at
                            else None
                        ),
                    }
                    if coverage_clip.active and coverage_distance_miles is not None:
                        props["coverageDistance"] = coverage_distance_miles
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
    if coverage_clip.active and coverage_clip.prefilter_geometry:
        query["gps"] = {"$geoIntersects": {"$geometry": coverage_clip.prefilter_geometry}}
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
                    # Convert Beanie model to dict for processing
                    if hasattr(trip, "model_dump"):
                        trip_dict = trip.model_dump()
                    elif hasattr(trip, "dict"):
                        trip_dict = trip.dict()
                    else:
                        trip_dict = dict(trip)

                    st = parse_timestamp(trip_dict.get("startTime"))
                    et = parse_timestamp(trip_dict.get("endTime"))
                    duration = (et - st).total_seconds() if st and et else None

                    geom = GeometryService.parse_geojson(trip_dict.get("gps"))
                    matched_geom = GeometryService.parse_geojson(
                        trip_dict.get("matchedGps"),
                    )

                    # Use matched geometry as the main feature geometry if requested
                    final_geom = geom
                    if matched_only and matched_geom:
                        final_geom = matched_geom

                    num_points = _count_line_points(final_geom)
                    coverage_distance_miles = None

                    if coverage_clip.active and coverage_clip.coverage_geometry is not None:
                        clipped_geom, coverage_distance_miles = _clip_lines_to_coverage(
                            final_geom,
                            coverage_clip.coverage_geometry,
                        )
                        if clipped_geom is None:
                            continue
                        final_geom = clipped_geom

                    total_idle_duration = trip_dict.get("totalIdleDuration")
                    avg_speed = trip_dict.get("avgSpeed")
                    start_tz, end_tz, alias_tz = _derive_timezone_fields(trip_dict)

                    # Skip trips without valid geometry
                    if not final_geom or not final_geom.get("coordinates"):
                        logger.debug(
                            "Skipping trip %s: no valid geometry",
                            trip_dict.get("transactionId"),
                        )
                        continue

                    props = {
                        "transactionId": trip_dict.get("transactionId"),
                        "imei": trip_dict.get("imei"),
                        "startTime": st.isoformat() if st else None,
                        "endTime": et.isoformat() if et else None,
                        "duration": duration,
                        "distance": safe_float(trip_dict.get("distance"), 0),
                        "maxSpeed": safe_float(trip_dict.get("maxSpeed"), 0),
                        "startTimeZone": start_tz,
                        "endTimeZone": end_tz,
                        "timeZone": alias_tz,
                        "startLocation": trip_dict.get("startLocation"),
                        "destination": trip_dict.get("destination"),
                        "totalIdleDuration": total_idle_duration,
                        "fuelConsumed": safe_float(trip_dict.get("fuelConsumed"), 0),
                        "source": trip_dict.get("source"),
                        "hardBrakingCounts": trip_dict.get("hardBrakingCounts"),
                        "hardAccelerationCounts": trip_dict.get(
                            "hardAccelerationCounts",
                        ),
                        "startOdometer": trip_dict.get("startOdometer"),
                        "endOdometer": trip_dict.get("endOdometer"),
                        "avgSpeed": avg_speed,
                        "pointsRecorded": num_points,
                        "estimated_cost": TripCostService.calculate_trip_cost(
                            trip_dict,
                            price_map,
                        ),
                        "matchStatus": trip_dict.get("matchStatus"),
                    }
                    if coverage_clip.active and coverage_distance_miles is not None:
                        props["coverageDistance"] = coverage_distance_miles
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
