"""High-volume map bundle endpoints for native clients."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import UTC, datetime
from typing import Annotated, Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel
from starlette.responses import Response

from core.coverage_clip import (
    CoverageClipContext,
    CoverageClipError,
    apply_clip_prefilter,
    clip_geojson_lines,
    parse_clip_bool,
    resolve_coverage_clip_context,
)
from core.date_utils import ensure_utc
from core.redis import get_shared_redis
from core.serialization import serialize_utc_datetime
from core.spatial import GeometryService, flatten_line_coordinates
from core.trip_map_cache import TRIP_MAP_CACHE_PREFIX, get_trip_map_revision
from core.trip_query_spec import TripQuerySpec
from db.models import CoverageArea, CoverageState, Street, Trip
from trips.serialization import TripSerializer
from trips.services.trip_cost_service import TripCostService
from trips.services.trip_map_geometry import (
    TRIP_MAP_PATH_VERSION,
    bbox_for_coords,
    build_encoded_path_metadata,
    encode_polyline6,
    materialized_path_is_current,
    merge_bboxes,
)

router = APIRouter(prefix="/api/map", tags=["map-bundles"])

_EARTH_RADIUS_M = 6_371_000.0


class EncodedGeometryLOD(BaseModel):
    full: str
    medium: str
    low: str


class TripMapFeature(BaseModel):
    id: str
    start_time: datetime
    end_time: datetime | None = None
    imei: str
    distance_miles: float | None = None
    duration_seconds: float | None = None
    avg_speed: float | None = None
    max_speed: float | None = None
    estimated_cost: float | None = None
    coverage_distance_miles: float | None = None
    geometry_source: str
    bbox: list[float]
    point_count: int
    path: str | list[str]
    start_location: str | None = None
    destination: str | None = None


class TripMapSummary(BaseModel):
    total_distance_miles: float
    avg_distance_miles: float
    avg_speed: float
    max_speed: float
    avg_start_time: str
    avg_driving_time: str


class TripMapBundleResponse(BaseModel):
    revision: str
    generated_at: datetime
    bbox: list[float] | None = None
    trip_count: int
    summary: TripMapSummary
    trips: list[TripMapFeature]


class CoverageAreaSummary(BaseModel):
    id: str
    display_name: str
    coverage_percentage: float
    total_segments: int
    driven_segments: int


class CoverageMapFeature(BaseModel):
    id: str
    status: str
    name: str | None = None
    bbox: list[float]
    geom: EncodedGeometryLOD


class CoverageMapBundleResponse(BaseModel):
    revision: str
    generated_at: datetime
    area: CoverageAreaSummary
    bbox: list[float]
    segment_count: int
    segments: list[CoverageMapFeature]


def _extract_if_none_match(request: Request) -> str | None:
    value = request.headers.get("if-none-match")
    if not value:
        return None
    return value.strip()


def simplify_line_meters(
    coords: list[list[float]], tolerance_m: float
) -> list[list[float]]:
    if tolerance_m <= 0 or len(coords) <= 2:
        return coords

    origin_lon, origin_lat = coords[0]
    origin_lat_rad = math.radians(origin_lat)

    xy = [
        _project_to_local_xy(lon, lat, origin_lon, origin_lat, origin_lat_rad)
        for lon, lat in coords
    ]

    keep = {0, len(coords) - 1}
    _rdp_indices(xy, 0, len(coords) - 1, tolerance_m, keep)

    indices = sorted(keep)
    if len(indices) < 2:
        return [coords[0], coords[-1]]
    return [coords[index] for index in indices]


def _project_to_local_xy(
    lon: float,
    lat: float,
    origin_lon: float,
    origin_lat: float,
    origin_lat_rad: float,
) -> tuple[float, float]:
    lon_delta = math.radians(lon - origin_lon)
    lat_delta = math.radians(lat - origin_lat)
    x = lon_delta * math.cos(origin_lat_rad) * _EARTH_RADIUS_M
    y = lat_delta * _EARTH_RADIUS_M
    return x, y


def _rdp_indices(
    points: list[tuple[float, float]],
    start: int,
    end: int,
    tolerance: float,
    keep: set[int],
) -> None:
    if end <= start + 1:
        return

    x1, y1 = points[start]
    x2, y2 = points[end]

    max_distance = -1.0
    max_index = -1

    for idx in range(start + 1, end):
        distance = _distance_to_segment(points[idx], (x1, y1), (x2, y2))
        if distance > max_distance:
            max_distance = distance
            max_index = idx

    if max_distance > tolerance and max_index > start:
        keep.add(max_index)
        _rdp_indices(points, start, max_index, tolerance, keep)
        _rdp_indices(points, max_index, end, tolerance, keep)


def _distance_to_segment(
    point: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
) -> float:
    px, py = point
    x1, y1 = start
    x2, y2 = end

    dx = x2 - x1
    dy = y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)

    t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    proj_x = x1 + t * dx
    proj_y = y1 + t * dy
    return math.hypot(px - proj_x, py - proj_y)


def _resolve_location_string(value: Any) -> str | None:
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned if cleaned else None
    if isinstance(value, dict):
        for key in ("formatted_address", "formattedAddress", "address"):
            raw = value.get(key)
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
    return None


def _trip_revision_source(
    start_date: str,
    end_date: str,
    imei: str | None,
    trip_count: int,
    max_updated: datetime | None,
) -> str:
    stamp = ensure_utc(max_updated).isoformat() if max_updated else "none"
    return f"{start_date}|{end_date}|{imei or 'all'}|{trip_count}|{stamp}"


def _json_cache_key(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    return f"cache:{TRIP_MAP_CACHE_PREFIX}:{digest}"


async def _get_cached_body(cache_key: str) -> str | None:
    try:
        redis = await get_shared_redis()
        value = await redis.get(cache_key)
        if value is None:
            return None
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return str(value)
    except Exception:
        return None


async def _set_cached_body(cache_key: str, body: str) -> None:
    try:
        redis = await get_shared_redis()
        await redis.set(cache_key, body, ex=600)
    except Exception:
        return


def _duration_seconds(trip_doc: dict[str, Any]) -> float | None:
    duration = TripSerializer.calculate_duration_seconds(trip_doc)
    if duration is None:
        return None
    try:
        return float(duration)
    except (TypeError, ValueError):
        return None


def _format_duration_hms(seconds: float | None) -> str:
    if seconds is None or seconds <= 0:
        return "--:--"
    total = int(seconds)
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _format_avg_hour(hour_value: float | None) -> str:
    if hour_value is None:
        return "--:--"
    total_minutes = round(hour_value * 60) % (24 * 60)
    hours = total_minutes // 60
    minutes = total_minutes % 60
    suffix = "AM" if hours < 12 else "PM"
    hour_12 = hours % 12 or 12
    return f"{hour_12}:{minutes:02d} {suffix}"


async def _resolve_trip_coverage_clip_context(
    request: Request,
) -> CoverageClipContext:
    clip_requested = parse_clip_bool(request.query_params.get("clip_to_coverage"))
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


async def _query_has_missing_materialized_paths(
    query: dict[str, Any],
    *,
    path_field: str,
) -> bool:
    collection = Trip.get_pymongo_collection()
    missing_query = {
        "$and": [
            query,
            {
                "$or": [
                    {path_field: None},
                    {f"{path_field}.version": {"$ne": TRIP_MAP_PATH_VERSION}},
                ],
            },
        ],
    }
    doc = await collection.find_one(missing_query, projection={"_id": 1})
    return doc is not None


def _path_metadata_for_doc(
    trip_doc: dict[str, Any],
    *,
    path_field: str,
    geometry_field: str,
    coverage_clip: CoverageClipContext,
) -> tuple[dict[str, Any] | None, float | None]:
    coverage_distance_miles = None
    if coverage_clip.enabled:
        geometry = GeometryService.parse_geojson(trip_doc.get(geometry_field))
        if not geometry:
            return None, None
        geometry, coverage_distance_miles = clip_geojson_lines(
            geometry,
            coverage_clip,
        )
        if geometry is None:
            return None, None
        return (
            build_encoded_path_metadata(
                geometry,
                geometry_source=geometry_field,
            ),
            coverage_distance_miles,
        )

    materialized = trip_doc.get(path_field)
    if materialized_path_is_current(materialized, geometry_source=geometry_field):
        return materialized, None

    geometry = GeometryService.parse_geojson(trip_doc.get(geometry_field))
    if not geometry:
        return None, None
    return (
        build_encoded_path_metadata(geometry, geometry_source=geometry_field),
        None,
    )


def _build_trip_map_summary(features: list[dict[str, Any]]) -> dict[str, Any]:
    total_distance = 0.0
    total_full_distance = 0.0
    valid_full_distance_count = 0
    total_duration = 0.0
    valid_duration_count = 0
    total_start_hours = 0.0
    valid_start_count = 0
    max_speed = 0.0

    for feature in features:
        distance = feature.get("distance_miles")
        coverage_distance = feature.get("coverage_distance_miles")
        strict_distance = (
            coverage_distance if coverage_distance is not None else distance
        )
        if strict_distance is not None:
            total_distance += float(strict_distance)
        if distance is not None:
            total_full_distance += float(distance)
            valid_full_distance_count += 1

        duration = feature.get("duration_seconds")
        if duration is not None and float(duration) > 0:
            total_duration += float(duration)
            valid_duration_count += 1

        start_raw = feature.get("start_time")
        start_dt = ensure_utc(start_raw)
        if start_dt is not None:
            total_start_hours += start_dt.hour + start_dt.minute / 60
            valid_start_count += 1

        trip_max_speed = feature.get("max_speed")
        if trip_max_speed is not None:
            max_speed = max(max_speed, float(trip_max_speed))

    avg_distance = (
        total_full_distance / valid_full_distance_count
        if valid_full_distance_count
        else 0.0
    )
    avg_speed = (total_full_distance / total_duration) * 3600 if total_duration else 0.0
    avg_start_hour = (
        total_start_hours / valid_start_count if valid_start_count else None
    )
    avg_duration = (
        total_duration / valid_duration_count if valid_duration_count else None
    )

    return {
        "total_distance_miles": round(total_distance, 1),
        "avg_distance_miles": round(avg_distance, 1),
        "avg_speed": round(avg_speed, 1),
        "max_speed": round(max_speed, 0),
        "avg_start_time": _format_avg_hour(avg_start_hour),
        "avg_driving_time": _format_duration_hms(avg_duration),
    }


def _coverage_revision_source(
    area: CoverageArea,
    status_filter: str,
    segment_count: int,
    max_state_ts: datetime | None,
) -> str:
    area_stamp = (
        ensure_utc(area.last_synced).isoformat() if area.last_synced else "none"
    )
    state_stamp = ensure_utc(max_state_ts).isoformat() if max_state_ts else "none"
    return (
        f"{area.id}|{area.area_version}|{status_filter}|{segment_count}|"
        f"{area.driven_segments}|{area.undriveable_segments}|{area_stamp}|{state_stamp}"
    )


@router.get("/trips/bundle", response_model=TripMapBundleResponse)
async def get_trip_map_bundle(
    request: Request,
    start_date: Annotated[str, Query(description="Trip range start date (YYYY-MM-DD)")],
    end_date: Annotated[str, Query(description="Trip range end date (YYYY-MM-DD)")],
    imei: Annotated[
        str | None, Query(description="Optional vehicle IMEI filter")
    ] = None,
    mode: Annotated[
        str,
        Query(description="Trip geometry mode", pattern="^(display|matched)$"),
    ] = "display",
):
    mode = mode.strip().lower()
    geometry_field = "matchedGps" if mode == "matched" else "displayGps"
    path_field = "matchedMapPath" if mode == "matched" else "displayMapPath"

    query_spec = TripQuerySpec(
        start_date=start_date,
        end_date=end_date,
        imei=imei,
        include_invalid=False,
    )

    try:
        query = query_spec.to_mongo_query(
            require_complete_bounds=True,
            require_valid_range_if_provided=True,
            enforce_source=True,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    coverage_clip = await _resolve_trip_coverage_clip_context(request)

    query["invalid"] = {"$ne": True}
    query[geometry_field] = {"$ne": None}
    query = apply_clip_prefilter(
        query,
        coverage_clip,
        geometry_field=geometry_field,
    )

    revision_source = {
        "revision": await get_trip_map_revision(),
        "start_date": start_date,
        "end_date": end_date,
        "imei": imei or "",
        "mode": mode,
        "coverage_area_id": coverage_clip.area_id or "",
        "clip_to_coverage": coverage_clip.enabled,
        "path_version": TRIP_MAP_PATH_VERSION,
        "cost_version": 1,
    }
    revision = hashlib.sha1(  # nosec B324
        json.dumps(revision_source, sort_keys=True).encode("utf-8"),
    ).hexdigest()
    etag = f'"{revision}"'

    if _extract_if_none_match(request) == etag:
        return Response(
            status_code=304,
            headers={"ETag": etag, "Cache-Control": "private, max-age=30"},
        )

    cache_key = _json_cache_key(revision_source)
    cached_body = await _get_cached_body(cache_key)
    if cached_body is not None:
        return Response(
            content=cached_body,
            media_type="application/json",
            headers={"ETag": etag, "Cache-Control": "private, max-age=30"},
        )

    include_geometry = (
        coverage_clip.enabled
        or await _query_has_missing_materialized_paths(
            query,
            path_field=path_field,
        )
    )
    projection = {
        "_id": 1,
        "transactionId": 1,
        "startTime": 1,
        "endTime": 1,
        "startTimeZone": 1,
        "endTimeZone": 1,
        "imei": 1,
        "distance": 1,
        "duration": 1,
        "avgSpeed": 1,
        "maxSpeed": 1,
        "fuelConsumed": 1,
        "startLocation": 1,
        "destination": 1,
        path_field: 1,
    }
    if include_geometry:
        projection[geometry_field] = 1

    cursor = (
        Trip.get_pymongo_collection()
        .find(query, projection=projection)
        .sort("endTime", -1)
    )

    price_map = await TripCostService.get_fillup_price_map()
    features: list[dict[str, Any]] = []
    feature_bboxes: list[list[float]] = []

    async for trip_doc in cursor:
        path_metadata, coverage_distance_miles = _path_metadata_for_doc(
            trip_doc,
            path_field=path_field,
            geometry_field=geometry_field,
            coverage_clip=coverage_clip,
        )
        if not path_metadata:
            continue

        start_time = ensure_utc(trip_doc.get("startTime"))
        if start_time is None:
            continue

        bbox = path_metadata["bbox"]
        feature_bboxes.append(bbox)

        distance_miles = trip_doc.get("distance")
        duration_seconds = _duration_seconds(trip_doc)
        feature = {
            "id": str(trip_doc.get("transactionId") or trip_doc.get("_id")),
            "start_time": start_time,
            "end_time": ensure_utc(trip_doc.get("endTime")),
            "imei": str(trip_doc.get("imei") or ""),
            "distance_miles": (
                float(distance_miles) if distance_miles is not None else None
            ),
            "duration_seconds": duration_seconds,
            "avg_speed": (
                float(trip_doc["avgSpeed"])
                if trip_doc.get("avgSpeed") is not None
                else None
            ),
            "max_speed": (
                float(trip_doc["maxSpeed"])
                if trip_doc.get("maxSpeed") is not None
                else None
            ),
            "estimated_cost": TripCostService.calculate_trip_cost(
                trip_doc,
                price_map,
            ),
            "coverage_distance_miles": coverage_distance_miles,
            "geometry_source": path_metadata["geometry_source"],
            "bbox": bbox,
            "point_count": int(path_metadata.get("point_count") or 0),
            "path": path_metadata["path"],
            "start_location": _resolve_location_string(trip_doc.get("startLocation")),
            "destination": _resolve_location_string(trip_doc.get("destination")),
        }
        features.append(feature)

    payload = {
        "revision": revision,
        "generated_at": datetime.now(UTC),
        "bbox": merge_bboxes(feature_bboxes),
        "trip_count": len(features),
        "summary": _build_trip_map_summary(features),
        "trips": features,
    }

    body = json.dumps(payload, separators=(",", ":"), default=serialize_utc_datetime)
    await _set_cached_body(cache_key, body)

    return Response(
        content=body,
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=30"},
    )


@router.get(
    "/coverage/areas/{area_id}/bundle", response_model=CoverageMapBundleResponse
)
async def get_coverage_map_bundle(
    request: Request,
    area_id: PydanticObjectId,
    status_filter: Annotated[
        str,
        Query(
            alias="status",
            description="Coverage status filter",
            pattern="^(all|driven|undriven|undriveable)$",
        ),
    ] = "all",
):
    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    if area.status != "ready":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Area is not ready (status: {area.status})",
        )

    status_filter = status_filter.strip().lower()
    if status_filter not in {"all", "driven", "undriven", "undriveable"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid status filter",
        )

    states: list[Any] = []
    features: list[CoverageMapFeature] = []
    feature_bboxes: list[list[float]] = []

    if status_filter in {"all", "undriven"}:
        streets = (
            await Street.find(
                {
                    "area_id": area_id,
                    "area_version": area.area_version,
                },
            )
            .sort(Street.segment_id)
            .to_list()
        )

        states = await CoverageState.find(
            {
                "area_id": area_id,
                "status": {"$in": ["driven", "undriveable"]},
            },
        ).to_list()
        state_map = {state.segment_id: state for state in states}

        for street in streets:
            segment_status = (
                state_map.get(street.segment_id).status
                if street.segment_id in state_map
                else "undriven"
            )
            if status_filter == "undriven" and segment_status != "undriven":
                continue

            coords = flatten_line_coordinates(street.geometry)
            if len(coords) < 2:
                continue

            bbox = bbox_for_coords(coords)
            feature_bboxes.append(bbox)

            medium = simplify_line_meters(coords, tolerance_m=2.0)
            low = simplify_line_meters(coords, tolerance_m=8.0)

            features.append(
                CoverageMapFeature(
                    id=street.segment_id,
                    status=segment_status,
                    name=street.street_name,
                    bbox=bbox,
                    geom=EncodedGeometryLOD(
                        full=encode_polyline6(coords),
                        medium=encode_polyline6(medium),
                        low=encode_polyline6(low),
                    ),
                ),
            )
    else:
        states = await CoverageState.find(
            {
                "area_id": area_id,
                "status": status_filter,
            },
        ).to_list()

        if states:
            segment_ids = [state.segment_id for state in states]
            streets = await Street.find(
                {
                    "area_id": area_id,
                    "area_version": area.area_version,
                    "segment_id": {"$in": segment_ids},
                },
            ).to_list()

            for street in streets:
                coords = flatten_line_coordinates(street.geometry)
                if len(coords) < 2:
                    continue

                bbox = bbox_for_coords(coords)
                feature_bboxes.append(bbox)

                medium = simplify_line_meters(coords, tolerance_m=2.0)
                low = simplify_line_meters(coords, tolerance_m=8.0)

                features.append(
                    CoverageMapFeature(
                        id=street.segment_id,
                        status=status_filter,
                        name=street.street_name,
                        bbox=bbox,
                        geom=EncodedGeometryLOD(
                            full=encode_polyline6(coords),
                            medium=encode_polyline6(medium),
                            low=encode_polyline6(low),
                        ),
                    ),
                )

    max_state_ts: datetime | None = None
    for state in states:
        state_ts = ensure_utc(
            state.last_driven_at or state.first_driven_at or state.marked_at,
        )
        if state_ts and (max_state_ts is None or state_ts > max_state_ts):
            max_state_ts = state_ts

    revision = hashlib.sha1(  # nosec B324
        _coverage_revision_source(
            area=area,
            status_filter=status_filter,
            segment_count=len(features),
            max_state_ts=max_state_ts,
        ).encode("utf-8"),
    ).hexdigest()
    etag = f'"{revision}"'

    if _extract_if_none_match(request) == etag:
        return Response(status_code=304, headers={"ETag": etag})

    bundle = CoverageMapBundleResponse(
        revision=revision,
        generated_at=datetime.now(UTC),
        area=CoverageAreaSummary(
            id=str(area.id),
            display_name=area.display_name,
            coverage_percentage=area.coverage_percentage,
            total_segments=area.total_segments,
            driven_segments=area.driven_segments,
        ),
        bbox=area.bounding_box
        if len(area.bounding_box) == 4
        else merge_bboxes(feature_bboxes) or [0.0, 0.0, 0.0, 0.0],
        segment_count=len(features),
        segments=features,
    )

    return Response(
        content=bundle.model_dump_json(),
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=30"},
    )
