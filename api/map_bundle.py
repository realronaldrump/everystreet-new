"""High-volume map bundle endpoints for native clients."""

from __future__ import annotations

import hashlib
import math
from datetime import UTC, datetime
from typing import Annotated, Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel
from starlette.responses import Response

from core.date_utils import ensure_utc
from core.spatial import GeometryService, extract_line_sequences
from core.trip_query_spec import TripQuerySpec
from db.models import CoverageArea, CoverageState, Street, Trip
from trips.presentation import trip_to_dict

router = APIRouter(prefix="/api/map", tags=["map-bundles"])

_POLYLINE6_SCALE = 1_000_000
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
    start_location: str | None = None
    destination: str | None = None
    bbox: list[float]
    geom: EncodedGeometryLOD


class TripMapBundleResponse(BaseModel):
    revision: str
    generated_at: datetime
    bbox: list[float]
    trip_count: int
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


def _canonical_etag(value: str) -> str:
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()  # nosec B324
    return f'"{digest}"'


def _extract_if_none_match(request: Request) -> str | None:
    value = request.headers.get("if-none-match")
    if not value:
        return None
    return value.strip()


def _line_from_geometry(geometry: dict[str, Any] | None) -> list[list[float]]:
    lines = extract_line_sequences(geometry)
    if not lines:
        return []
    if len(lines) == 1:
        return lines[0]

    # MultiLineString is uncommon in this dataset; flatten into one continuous list.
    merged: list[list[float]] = []
    for line in lines:
        if not line:
            continue
        if not merged:
            merged.extend(line)
            continue
        if merged[-1] != line[0]:
            merged.append(line[0])
        merged.extend(line[1:])
    return merged


def _bbox_for_coords(coords: list[list[float]]) -> list[float]:
    lons = [point[0] for point in coords]
    lats = [point[1] for point in coords]
    return [min(lons), min(lats), max(lons), max(lats)]


def _merge_bboxes(bboxes: list[list[float]]) -> list[float]:
    if not bboxes:
        return [0.0, 0.0, 0.0, 0.0]
    return [
        min(b[0] for b in bboxes),
        min(b[1] for b in bboxes),
        max(b[2] for b in bboxes),
        max(b[3] for b in bboxes),
    ]


def _quantize(value: float) -> int:
    return round(value * _POLYLINE6_SCALE)


def encode_polyline6(coords: list[list[float]]) -> str:
    if not coords:
        return ""

    output: list[str] = []
    prev_lat = 0
    prev_lon = 0

    for lon, lat in coords:
        lat_i = _quantize(lat)
        lon_i = _quantize(lon)

        output.append(_encode_polyline_delta(lat_i - prev_lat))
        output.append(_encode_polyline_delta(lon_i - prev_lon))

        prev_lat = lat_i
        prev_lon = lon_i

    return "".join(output)


def _encode_polyline_delta(value: int) -> str:
    value = ~(value << 1) if value < 0 else (value << 1)
    chunks: list[str] = []
    while value >= 0x20:
        chunks.append(chr((0x20 | (value & 0x1F)) + 63))
        value >>= 5
    chunks.append(chr(value + 63))
    return "".join(chunks)


def simplify_line_meters(coords: list[list[float]], tolerance_m: float) -> list[list[float]]:
    if tolerance_m <= 0 or len(coords) <= 2:
        return coords

    origin_lon, origin_lat = coords[0]
    origin_lat_rad = math.radians(origin_lat)

    xy = [_project_to_local_xy(lon, lat, origin_lon, origin_lat, origin_lat_rad) for lon, lat in coords]

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


def _coverage_revision_source(
    area: CoverageArea,
    status_filter: str,
    segment_count: int,
    max_state_ts: datetime | None,
) -> str:
    area_stamp = ensure_utc(area.last_synced).isoformat() if area.last_synced else "none"
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
    imei: Annotated[str | None, Query(description="Optional vehicle IMEI filter")] = None,
):
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

    trips = await Trip.find(query).sort(-Trip.endTime).to_list()

    max_updated: datetime | None = None
    for trip in trips:
        ts = ensure_utc(trip.lastUpdate or trip.endTime or trip.startTime)
        if ts and (max_updated is None or ts > max_updated):
            max_updated = ts

    revision = hashlib.sha1(  # nosec B324
        _trip_revision_source(
            start_date=start_date,
            end_date=end_date,
            imei=imei,
            trip_count=len(trips),
            max_updated=max_updated,
        ).encode("utf-8"),
    ).hexdigest()
    etag = f'"{revision}"'

    if _extract_if_none_match(request) == etag:
        return Response(status_code=304, headers={"ETag": etag})

    features: list[TripMapFeature] = []
    feature_bboxes: list[list[float]] = []

    for trip in trips:
        trip_dict = trip_to_dict(trip)
        geometry = GeometryService.parse_geojson(trip_dict.get("gps"))
        coords = _line_from_geometry(geometry)
        if len(coords) < 2:
            continue

        start_time = ensure_utc(trip.startTime)
        if start_time is None:
            continue

        bbox = _bbox_for_coords(coords)
        feature_bboxes.append(bbox)

        medium = simplify_line_meters(coords, tolerance_m=8.0)
        low = simplify_line_meters(coords, tolerance_m=30.0)

        features.append(
            TripMapFeature(
                id=str(trip.transactionId or trip.id),
                start_time=start_time,
                end_time=ensure_utc(trip.endTime),
                imei=str(trip.imei or ""),
                distance_miles=float(trip.distance) if trip.distance is not None else None,
                start_location=_resolve_location_string(trip_dict.get("startLocation")),
                destination=_resolve_location_string(trip_dict.get("destination")),
                bbox=bbox,
                geom=EncodedGeometryLOD(
                    full=encode_polyline6(coords),
                    medium=encode_polyline6(medium),
                    low=encode_polyline6(low),
                ),
            ),
        )

    payload = TripMapBundleResponse(
        revision=revision,
        generated_at=datetime.now(UTC),
        bbox=_merge_bboxes(feature_bboxes),
        trip_count=len(features),
        trips=features,
    )

    return Response(
        content=payload.model_dump_json(),
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=30"},
    )


@router.get("/coverage/areas/{area_id}/bundle", response_model=CoverageMapBundleResponse)
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
            segment_status = state_map.get(street.segment_id).status if street.segment_id in state_map else "undriven"
            if status_filter == "undriven" and segment_status != "undriven":
                continue

            coords = _line_from_geometry(street.geometry)
            if len(coords) < 2:
                continue

            bbox = _bbox_for_coords(coords)
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
                coords = _line_from_geometry(street.geometry)
                if len(coords) < 2:
                    continue

                bbox = _bbox_for_coords(coords)
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
        bbox=area.bounding_box if len(area.bounding_box) == 4 else _merge_bboxes(feature_bboxes),
        segment_count=len(features),
        segments=features,
    )

    return Response(
        content=bundle.model_dump_json(),
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=30"},
    )
