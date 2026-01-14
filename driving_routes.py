import logging
import math
from collections import defaultdict
from typing import Annotated, Any

import httpx
from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from config import get_mapbox_token
from coverage.constants import MILES_TO_METERS
from coverage.models import CoverageArea, CoverageState, Street
from db.models import Trip
from geometry_service import GeometryService
from live_tracking import get_active_trip

logger = logging.getLogger(__name__)
router = APIRouter()

CLUSTER_DISTANCE_M = 120.0
MIN_GRID_SCALE = 0.01


class CoverageLocation(BaseModel):
    id: PydanticObjectId | None = Field(
        default=None,
        validation_alias=AliasChoices("id", "_id"),
    )
    display_name: str | None = None
    location: str | None = None

    model_config = ConfigDict(extra="allow")


class DrivingNavigationRequest(BaseModel):
    location: CoverageLocation | None = None
    current_position: dict[str, Any] | None = None
    segment_id: str | None = None

    model_config = ConfigDict(extra="allow")


def sanitize_for_json(obj: Any) -> Any:
    """Recursively replaces NaN and Infinite floats with None for JSON compliance."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_for_json(v) for v in obj]
    return obj


def get_safe_float(val: Any, default: float = 0.0) -> float:
    """Safe float conversion handling NaN/Inf."""
    try:
        f = float(val)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _normalize_location_source(source: str | None) -> str:
    if source == "current-position":
        return "client-provided"
    return source or "unknown"


async def _resolve_coverage_area(
    location: CoverageLocation | None,
) -> CoverageArea:
    if location is None:
        raise HTTPException(status_code=400, detail="Missing location data.")

    if location.id is None:
        raise HTTPException(status_code=400, detail="Missing location id.")

    area = await CoverageArea.get(location.id)
    if not area:
        raise HTTPException(status_code=404, detail="Coverage area not found.")

    return area


def _normalize_coord_pair(coord: Any) -> list[float] | None:
    is_valid, pair = GeometryService.validate_coordinate_pair(coord)
    if not is_valid or not pair:
        return None
    return pair


def _extract_line_coords(geometry: dict[str, Any] | None) -> list[list[float]]:
    if not geometry:
        return []

    geom_type = geometry.get("type")
    coords = geometry.get("coordinates", [])

    if geom_type == "LineString":
        return coords if isinstance(coords, list) else []

    if geom_type == "MultiLineString":
        for line in coords:
            if line and isinstance(line, list) and len(line) >= 2:
                return line
        return []

    if geom_type == "Point":
        return [coords] if coords else []

    return []


def _segment_midpoint_coords(
    geometry: dict[str, Any] | None,
) -> tuple[float, float] | None:
    coords = _extract_line_coords(geometry)
    if not coords:
        return None

    if len(coords) == 1:
        pair = _normalize_coord_pair(coords[0])
        if not pair:
            return None
        return pair[0], pair[1]

    start = _normalize_coord_pair(coords[0])
    end = _normalize_coord_pair(coords[-1])
    if not start or not end:
        return None

    lon = (start[0] + end[0]) / 2.0
    lat = (start[1] + end[1]) / 2.0
    return lon, lat


def _estimate_linestring_length_m(geometry: dict[str, Any] | None) -> float:
    coords = _extract_line_coords(geometry)
    if len(coords) < 2:
        return 0.0

    length_m = 0.0
    prev = _normalize_coord_pair(coords[0])
    for coord in coords[1:]:
        cur = _normalize_coord_pair(coord)
        if not prev or not cur:
            prev = cur
            continue
        length_m += GeometryService.haversine_distance(
            prev[0],
            prev[1],
            cur[0],
            cur[1],
            unit="meters",
        )
        prev = cur
    return length_m


async def _load_undriven_segments(area: CoverageArea) -> list[dict[str, Any]]:
    driven_segment_ids = set()
    undriveable_segment_ids = set()
    async for state in CoverageState.find(CoverageState.area_id == area.id):
        if state.status == "driven":
            driven_segment_ids.add(state.segment_id)
        elif state.status == "undriveable":
            undriveable_segment_ids.add(state.segment_id)

    segments = []
    async for street in Street.find(
        Street.area_id == area.id,
        Street.area_version == area.area_version,
    ):
        if street.segment_id in driven_segment_ids:
            continue
        if street.segment_id in undriveable_segment_ids:
            continue

        segments.append(
            {
                "segment_id": street.segment_id,
                "street_name": street.street_name,
                "geometry": street.geometry or {},
                "length_m": get_safe_float(street.length_miles) * MILES_TO_METERS,
            },
        )

    return segments


def _find_nearest_segment(
    segments: list[dict[str, Any]],
    current_lon: float,
    current_lat: float,
) -> tuple[dict[str, Any] | None, tuple[float, float] | None]:
    best_segment = None
    best_midpoint = None
    best_distance = None

    for segment in segments:
        midpoint = _segment_midpoint_coords(segment.get("geometry"))
        if not midpoint:
            continue

        distance = GeometryService.haversine_distance(
            current_lon,
            current_lat,
            midpoint[0],
            midpoint[1],
            unit="meters",
        )

        if best_distance is None or distance < best_distance:
            best_distance = distance
            best_segment = segment
            best_midpoint = midpoint

    return best_segment, best_midpoint


def _cluster_segments(
    segments: list[dict[str, Any]],
    current_lon: float,
    current_lat: float,
    *,
    threshold_m: float,
    min_cluster_size: int,
) -> list[dict[str, Any]]:
    if not segments:
        return []

    lat_deg = threshold_m / 111320.0
    lon_scale = max(math.cos(math.radians(current_lat)), MIN_GRID_SCALE)
    lon_deg = threshold_m / (111320.0 * lon_scale)

    if lat_deg <= 0 or lon_deg <= 0:
        return []

    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for idx, segment in enumerate(segments):
        midpoint = segment.get("midpoint")
        if not midpoint:
            continue
        lon, lat = midpoint
        cell = (int(lon / lon_deg), int(lat / lat_deg))
        grid[cell].append(idx)

    parent = list(range(len(segments)))

    def find_root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        root_i = find_root(i)
        root_j = find_root(j)
        if root_i != root_j:
            parent[root_j] = root_i

    for idx, segment in enumerate(segments):
        midpoint = segment.get("midpoint")
        if not midpoint:
            continue
        lon, lat = midpoint
        cell = (int(lon / lon_deg), int(lat / lat_deg))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other_idx in grid.get((cell[0] + dx, cell[1] + dy), []):
                    if other_idx <= idx:
                        continue
                    other_midpoint = segments[other_idx].get("midpoint")
                    if not other_midpoint:
                        continue
                    distance = GeometryService.haversine_distance(
                        lon,
                        lat,
                        other_midpoint[0],
                        other_midpoint[1],
                        unit="meters",
                    )
                    if distance <= threshold_m:
                        union(idx, other_idx)

    groups: dict[int, list[int]] = defaultdict(list)
    for idx in range(len(segments)):
        groups[find_root(idx)].append(idx)

    clusters = []
    for indices in groups.values():
        if len(indices) < min_cluster_size:
            continue

        cluster_segments = []
        total_length_m = 0.0
        centroid_lon = 0.0
        centroid_lat = 0.0
        nearest_segment = None
        nearest_distance = None

        for idx in indices:
            segment = segments[idx]
            midpoint = segment.get("midpoint")
            if not midpoint:
                continue

            centroid_lon += midpoint[0]
            centroid_lat += midpoint[1]

            length_m = segment.get("length_m") or 0.0
            if length_m <= 0:
                length_m = _estimate_linestring_length_m(segment.get("geometry"))
            total_length_m += length_m

            distance = GeometryService.haversine_distance(
                current_lon,
                current_lat,
                midpoint[0],
                midpoint[1],
                unit="meters",
            )
            if nearest_distance is None or distance < nearest_distance:
                nearest_distance = distance
                nearest_segment = segment

            cluster_segments.append(
                {
                    "segment_id": segment.get("segment_id"),
                    "street_name": segment.get("street_name"),
                    "geometry": segment.get("geometry"),
                    "length_m": length_m,
                },
            )

        if not cluster_segments:
            continue

        centroid_lon /= len(cluster_segments)
        centroid_lat /= len(cluster_segments)

        distance_to_cluster_m = GeometryService.haversine_distance(
            current_lon,
            current_lat,
            centroid_lon,
            centroid_lat,
            unit="meters",
        )

        efficiency_score = total_length_m / max(distance_to_cluster_m, 1.0)

        clusters.append(
            {
                "cluster_id": len(clusters),
                "segment_count": len(cluster_segments),
                "segments": cluster_segments,
                "centroid": [centroid_lon, centroid_lat],
                "total_length_m": total_length_m,
                "distance_to_cluster_m": distance_to_cluster_m,
                "efficiency_score": efficiency_score,
                "nearest_segment": {
                    "segment_id": (
                        nearest_segment.get("segment_id") if nearest_segment else None
                    ),
                    "street_name": (
                        nearest_segment.get("street_name") if nearest_segment else None
                    ),
                    "geometry": (
                        nearest_segment.get("geometry") if nearest_segment else None
                    ),
                },
            },
        )

    return clusters


async def _get_mapbox_directions_route(
    start_lon: float,
    start_lat: float,
    end_lon: float,
    end_lat: float,
) -> dict[str, Any]:
    """Calls Mapbox Directions API to get a route between two points."""
    mapbox_token = get_mapbox_token()
    if not mapbox_token:
        raise HTTPException(status_code=500, detail="Mapbox API token not configured.")

    coords_str = f"{start_lon},{start_lat};{end_lon},{end_lat}"
    url = f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords_str}"
    params = {
        "access_token": mapbox_token,
        "geometries": "geojson",
        "overview": "full",
        "steps": "false",
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=20.0)
            response.raise_for_status()
            data = response.json()
            if not data.get("routes"):
                raise HTTPException(
                    status_code=404,
                    detail=f"No route found by Mapbox Directions API: {data.get('message', 'Unknown')}",
                )

            route = data["routes"][0]
            return {
                "geometry": route.get("geometry", {}),
                "duration": route.get("duration", 0),
                "distance": route.get("distance", 0),
                "waypoints": route.get("waypoints", []),
            }
        except httpx.HTTPStatusError as e:
            logger.exception(
                "Mapbox Directions API HTTP error: %s - %s",
                e.response.status_code,
                e.response.text,
            )
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"Mapbox Directions API error: {e.response.text}",
            )
        except httpx.RequestError as e:
            logger.exception("Mapbox Directions API request error: %s", e)
            raise HTTPException(
                status_code=503,
                detail=f"Could not connect to Mapbox API: {e}",
            )


def _extract_position_from_gps_data(gps_data: dict) -> tuple[float, float, str] | None:
    """Extracts (lat, lon, source) from trip GPS data."""
    if not gps_data or not gps_data.get("coordinates"):
        return None

    coords = gps_data["coordinates"]
    geom_type = gps_data.get("type")

    if geom_type == "LineString":
        if coords:
            lon, lat = coords[-1]
            return lat, lon, "last-trip-end"

    elif geom_type == "MultiLineString":
        if coords and len(coords) > 0:
            last_segment = coords[-1]
            if last_segment and len(last_segment) >= 2:
                lon, lat = last_segment[-1]
                return lat, lon, "last-trip-end-multi"

    elif geom_type == "Point":
        lon, lat = coords
        return lat, lon, "last-trip-end-point"

    return None


async def get_current_position(
    request_data: DrivingNavigationRequest | dict[str, Any],
) -> tuple[float, float, str]:
    """Determines the current position from request, live tracking, or last trip."""
    if isinstance(request_data, DrivingNavigationRequest):
        current_position = request_data.current_position
    else:
        current_position = request_data.get("current_position")
    if current_position and "lat" in current_position and "lon" in current_position:
        return (
            float(current_position["lat"]),
            float(current_position["lon"]),
            "current-position",
        )

    try:
        active_trip = await get_active_trip()
        if active_trip:
            active_trip_data = (
                active_trip.model_dump()
                if hasattr(active_trip, "model_dump")
                else dict(active_trip)
            )
            position = _extract_position_from_gps_data(
                active_trip_data.get("gps", {}),
            )
            if position:
                return position
    except Exception:
        pass

    last_trip = await Trip.find().sort(-Trip.endTime).limit(1).to_list()
    if not last_trip:
        raise HTTPException(
            status_code=404,
            detail="No trip history available to determine current position.",
        )

    last_trip_doc = last_trip[0]
    gps_data = getattr(last_trip_doc, "gps", None)
    if not isinstance(gps_data, dict):
        gps_data = {}
    position = _extract_position_from_gps_data(gps_data)
    if position:
        return position

    raise HTTPException(
        status_code=404,
        detail="Could not determine current position from last trip history.",
    )


@router.post("/api/driving-navigation/next-route")
async def get_next_driving_navigation_route(payload: DrivingNavigationRequest):
    """Find a route to the nearest undriven street (or a specific segment)."""
    area = await _resolve_coverage_area(payload.location)
    undriven_segments = await _load_undriven_segments(area)

    if not undriven_segments:
        return {
            "status": "completed",
            "message": f"All streets in {area.display_name} are driven.",
        }

    current_position = payload.current_position
    current_lon = None
    current_lat = None
    location_source = None

    if isinstance(current_position, dict):
        pair = _normalize_coord_pair(
            [current_position.get("lon"), current_position.get("lat")],
        )
        if pair:
            current_lon, current_lat = pair
            location_source = "client-provided"

    if current_lon is None or current_lat is None:
        current_lat, current_lon, location_source = await get_current_position(payload)

    location_source = _normalize_location_source(location_source)

    segment_id = payload.segment_id
    target_segment = None
    target_midpoint = None

    if segment_id:
        target_segment = next(
            (
                segment
                for segment in undriven_segments
                if segment.get("segment_id") == segment_id
            ),
            None,
        )
        if not target_segment:
            raise HTTPException(
                status_code=404,
                detail="Requested segment not found or already driven.",
            )
        target_midpoint = _segment_midpoint_coords(target_segment.get("geometry"))
        if not target_midpoint:
            raise HTTPException(
                status_code=404,
                detail="Target segment has no valid geometry.",
            )
    else:
        target_segment, target_midpoint = _find_nearest_segment(
            undriven_segments,
            current_lon,
            current_lat,
        )
        if not target_segment or not target_midpoint:
            raise HTTPException(
                status_code=404,
                detail="No routable undriven streets found.",
            )

    route = await _get_mapbox_directions_route(
        current_lon,
        current_lat,
        target_midpoint[0],
        target_midpoint[1],
    )

    response = {
        "status": "success",
        "route_geometry": route.get("geometry"),
        "route_duration_seconds": route.get("duration", 0),
        "route_distance_meters": route.get("distance", 0),
        "target_street": {
            "street_name": target_segment.get("street_name") or "Unnamed Street",
            "segment_id": target_segment.get("segment_id"),
        },
        "location_source": location_source,
    }

    return sanitize_for_json(response)


@router.get("/api/driving-navigation/suggest-next-street/{area_id}")
async def suggest_next_street(
    area_id: PydanticObjectId,
    current_lat: Annotated[float, Query()],
    current_lon: Annotated[float, Query()],
    top_n: Annotated[int, Query()] = 3,
    min_cluster_size: Annotated[int, Query()] = 2,
):
    """Suggest efficient clusters of undriven streets."""
    area = await CoverageArea.get(area_id)

    if not area:
        raise HTTPException(status_code=404, detail="Coverage area not found.")

    if not _normalize_coord_pair([current_lon, current_lat]):
        raise HTTPException(status_code=400, detail="Invalid current position.")

    undriven_segments = await _load_undriven_segments(area)
    if not undriven_segments:
        return {
            "status": "no_streets",
            "message": f"No undriven streets found in {area.display_name}.",
        }

    prepared_segments = []
    for segment in undriven_segments:
        midpoint = _segment_midpoint_coords(segment.get("geometry"))
        if not midpoint:
            continue
        prepared_segments.append({**segment, "midpoint": midpoint})

    if not prepared_segments:
        return {
            "status": "no_streets",
            "message": f"No routable streets found in {area.display_name}.",
        }

    top_n = max(top_n, 1)
    min_cluster_size = max(min_cluster_size, 1)

    clusters = _cluster_segments(
        prepared_segments,
        current_lon,
        current_lat,
        threshold_m=CLUSTER_DISTANCE_M,
        min_cluster_size=min_cluster_size,
    )

    if not clusters:
        return {
            "status": "no_clusters",
            "message": "No efficient clusters found.",
        }

    clusters.sort(key=lambda cluster: cluster.get("efficiency_score", 0), reverse=True)
    return sanitize_for_json(
        {
            "status": "success",
            "suggested_clusters": clusters[:top_n],
        },
    )
