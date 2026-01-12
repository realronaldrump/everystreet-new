import logging
import math
from collections import defaultdict
from typing import Annotated, Any

import httpx
from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

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


async def _resolve_coverage_area(location: dict[str, Any] | None) -> CoverageArea:
    if not isinstance(location, dict):
        raise HTTPException(status_code=400, detail="Missing location data.")

    location_id = location.get("id") or location.get("_id")
    display_name = location.get("display_name") or location.get("location")

    area = None
    if location_id:
        try:
            area = await CoverageArea.get(PydanticObjectId(location_id))
        except Exception:
            area = None

    if not area and display_name:
        area = await CoverageArea.find_one({"display_name": display_name})

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


def _segment_midpoint_coords(geometry: dict[str, Any] | None) -> tuple[float, float] | None:
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
            }
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
                }
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
                    "segment_id": nearest_segment.get("segment_id")
                    if nearest_segment
                    else None,
                    "street_name": nearest_segment.get("street_name")
                    if nearest_segment
                    else None,
                    "geometry": nearest_segment.get("geometry") if nearest_segment else None,
                },
            }
        )

    return clusters


async def _get_mapbox_optimization_route(
    start_lon: float,
    start_lat: float,
    end_points: list[tuple] | None = None,
) -> dict[str, Any]:
    """Calls Mapbox Optimization API v1 to get an optimized route for multiple
    points.
    """
    mapbox_token = get_mapbox_token()
    if not mapbox_token:
        raise HTTPException(status_code=500, detail="Mapbox API token not configured.")
    if not end_points:
        raise HTTPException(
            status_code=400,
            detail="No end points provided for optimization.",
        )

    if len(end_points) > 11:
        logger.warning(
            "Too many points for Mapbox Optimization v1 (max 11), limiting to first 11.",
        )
        end_points = end_points[:11]

    coords = [f"{start_lon},{start_lat}"] + [f"{lon},{lat}" for lon, lat in end_points]
    coords_str = ";".join(coords)
    url = f"https://api.mapbox.com/optimized-trips/v1/mapbox/driving/{coords_str}"
    params = {
        "access_token": mapbox_token,
        "geometries": "geojson",
        "steps": "false",
        "overview": "full",
        "source": "first",
        "roundtrip": "false",
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=30.0)
            response.raise_for_status()
            data = response.json()
            if data.get("code") != "Ok" or not data.get("trips"):
                raise HTTPException(
                    status_code=500,
                    detail=f"Mapbox Optimization API error: {data.get('message', 'This request is not supported')}",
                )

            trip = data["trips"][0]
            return {
                "geometry": trip.get("geometry", {}),
                "duration": trip.get("duration", 0),
                "distance": trip.get("distance", 0),
                "waypoints": trip.get("waypoints", []),
            }
        except httpx.HTTPStatusError as e:
            logger.exception(
                "Mapbox Optimization API HTTP error: %s - %s",
                e.response.status_code,
                e.response.text,
            )
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"Mapbox Optimization API error: {e.response.text}",
            )
        except httpx.RequestError as e:
            logger.exception("Mapbox Optimization API request error: %s", e)
            raise HTTPException(
                status_code=503,
                detail=f"Could not connect to Mapbox API: {e}",
            )


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


async def get_current_position(request_data: dict) -> tuple[float, float, str]:
    """Determines the current position from request, live tracking, or last trip."""
    current_position = request_data.get("current_position")
    if current_position and "lat" in current_position and "lon" in current_position:
        return (
            float(current_position["lat"]),
            float(current_position["lon"]),
            "current-position",
        )

    try:
        active_trip_response = await get_active_trip()
        if hasattr(active_trip_response, "trip"):
            trip = active_trip_response.trip
            position = _extract_position_from_gps_data(trip.get("gps", {}))
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

    gps_data = last_trip[0].get("gps", {})
    position = _extract_position_from_gps_data(gps_data)
    if position:
        return position

    raise HTTPException(
        status_code=404,
        detail="Could not determine current position from last trip history.",
    )


@router.post("/api/driving_routes/optimize")
async def optimize_driving_route(request: Request):
    """Generate optimal route from current position to multiple end points."""
    try:
        data = await request.json()
        end_points = data.get("end_points")

        current_position = data.get("current_position")
        if current_position and "lat" in current_position and "lon" in current_position:
            route = await _get_mapbox_optimization_route(
                float(current_position["lon"]),
                float(current_position["lat"]),
                end_points,
            )
            return JSONResponse(content=route)

        position = await get_current_position(data)
        lon, lat, _ = position
        route = await _get_mapbox_optimization_route(lon, lat, end_points)
        return JSONResponse(content=route)

    except Exception as e:
        logger.exception("Error optimizing driving route: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/driving_routes/route")
async def get_driving_route(request: Request):
    """Get a route between two points using Mapbox Directions API."""
    try:
        data = await request.json()
        start = data.get("start")
        end = data.get("end")

        if not start or not end:
            raise HTTPException(
                status_code=400,
                detail="Start and end points required.",
            )

        if not all(k in start for k in ["lat", "lon"]) or not all(
            k in end for k in ["lat", "lon"]
        ):
            raise HTTPException(
                status_code=400,
                detail="Start and end must have lat/lon coordinates.",
            )

        route = await _get_mapbox_directions_route(
            start["lon"],
            start["lat"],
            end["lon"],
            end["lat"],
        )
        return JSONResponse(content=route)

    except Exception as e:
        logger.exception("Error getting driving route: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/current_position")
async def get_current_position_endpoint(request: Request):
    """Get the current vehicle position."""
    try:
        position = await get_current_position(await request.json())
        if position:
            lat, lon, source = position
            return {"lat": lat, "lon": lon, "source": source}

        return JSONResponse(content={"position": None})
    except Exception as e:
        logger.exception("Error getting current position: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/driving-navigation/next-route")
async def get_next_driving_navigation_route(request: Request):
    """Find a route to the nearest undriven street (or a specific segment)."""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request payload.")

    area = await _resolve_coverage_area(data.get("location"))
    undriven_segments = await _load_undriven_segments(area)

    if not undriven_segments:
        return JSONResponse(
            content={
                "status": "completed",
                "message": f"All streets in {area.display_name} are driven.",
            }
        )

    current_position = data.get("current_position")
    current_lon = None
    current_lat = None
    location_source = None

    if isinstance(current_position, dict):
        pair = _normalize_coord_pair(
            [current_position.get("lon"), current_position.get("lat")]
        )
        if pair:
            current_lon, current_lat = pair
            location_source = "client-provided"

    if current_lon is None or current_lat is None:
        current_lat, current_lon, location_source = await get_current_position(data)

    location_source = _normalize_location_source(location_source)

    segment_id = data.get("segment_id")
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

    return JSONResponse(content=sanitize_for_json(response))


@router.get("/api/driving-navigation/suggest-next-street/{area_id}")
async def suggest_next_street(
    area_id: str,
    current_lat: float = Query(...),
    current_lon: float = Query(...),
    top_n: int = Query(3),
    min_cluster_size: int = Query(2),
):
    """Suggest efficient clusters of undriven streets."""
    try:
        area = await CoverageArea.get(PydanticObjectId(area_id))
    except Exception:
        area = await CoverageArea.find_one({"display_name": area_id})

    if not area:
        raise HTTPException(status_code=404, detail="Coverage area not found.")

    if not _normalize_coord_pair([current_lon, current_lat]):
        raise HTTPException(status_code=400, detail="Invalid current position.")

    undriven_segments = await _load_undriven_segments(area)
    if not undriven_segments:
        return JSONResponse(
            content={
                "status": "no_streets",
                "message": f"No undriven streets found in {area.display_name}.",
            }
        )

    prepared_segments = []
    for segment in undriven_segments:
        midpoint = _segment_midpoint_coords(segment.get("geometry"))
        if not midpoint:
            continue
        prepared_segments.append({**segment, "midpoint": midpoint})

    if not prepared_segments:
        return JSONResponse(
            content={
                "status": "no_streets",
                "message": f"No routable streets found in {area.display_name}.",
            }
        )

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
        return JSONResponse(
            content={
                "status": "no_clusters",
                "message": "No efficient clusters found.",
            }
        )

    clusters.sort(key=lambda cluster: cluster.get("efficiency_score", 0), reverse=True)
    return JSONResponse(
        content=sanitize_for_json(
            {
                "status": "success",
                "suggested_clusters": clusters[:top_n],
            }
        )
    )


def _find_clusters_in_graph(segment_map: dict, adjacency: dict) -> list[list[str]]:
    """Traverses the graph to find connected clusters."""
    visited = set()
    clusters = []

    for segment_id in segment_map:
        if segment_id in visited:
            continue

        cluster = []
        stack = [segment_id]

        while stack:
            current = stack.pop()
            if current in visited:
                continue

            visited.add(current)
            cluster.append(current)

            for neighbor in adjacency.get(current, []):
                if neighbor not in visited:
                    stack.append(neighbor)

        if cluster:
            clusters.append(cluster)

    return clusters


async def find_connected_undriven_clusters(
    location_id: str,
) -> list[dict[str, Any]]:
    """Finds connected clusters of undriven street segments."""
    try:
        obj_location_id = PydanticObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    new_area = await CoverageArea.get(obj_location_id)
    if not new_area:
        raise HTTPException(
            status_code=404,
            detail=f"Coverage area with ID '{location_id}' not found.",
        )

    segment_map = {}
    adjacency = defaultdict(list)

    # Get driven and undriveable segment IDs from CoverageState
    driven_segment_ids = set()
    undriveable_segment_ids = set()
    async for state in CoverageState.find(CoverageState.area_id == obj_location_id):
        if state.status == "driven":
            driven_segment_ids.add(state.segment_id)
        elif state.status == "undriveable":
            undriveable_segment_ids.add(state.segment_id)

    # Query undriven streets
    async for street in Street.find(
        Street.area_id == obj_location_id,
        Street.area_version == new_area.area_version,
    ):
        if street.segment_id in driven_segment_ids:
            continue
        if street.segment_id in undriveable_segment_ids:
            continue

        geom = street.geometry or {}
        coords = geom.get("coordinates", [])

        if not coords:
            continue

        segment_midpoint = _segment_midpoint(geom)
        segment_map[street.segment_id] = {
            "id": street.segment_id,
            "midpoint": segment_midpoint,
            "coords": coords,
        }

        if len(coords) >= 2:
            lon1, lat1 = coords[0]
            lon2, lat2 = coords[-1]
            segment_map[street.segment_id]["midpoint"] = (
                (lat1 + lat2) / 2,
                (lon1 + lon2) / 2,
            )

    for street in segment_map.values():
        for other in segment_map.values():
            if street["id"] == other["id"]:
                continue

            dist = _segment_distance(street, other)
            if dist < 50:
                adjacency[street["id"]].append(other["id"])

    clusters = _find_clusters_in_graph(segment_map, adjacency)
    return [
        {
            "cluster_id": i,
            "segments": cluster,
        }
        for i, cluster in enumerate(clusters)
    ]


def _segment_midpoint(geometry: dict) -> tuple[float, float]:
    """Calculate the midpoint of a segment geometry."""
    coords = geometry.get("coordinates", [])
    if len(coords) >= 2:
        lat1, lon1 = coords[0]
        lat2, lon2 = coords[-1]
        return (lat1 + lat2) / 2, (lon1 + lon2) / 2
    return 0.0, 0.0


def _segment_distance(seg1: dict, seg2: dict) -> float:
    """Calculate distance between two segments using midpoints."""
    lat1, lon1 = seg1.get("midpoint", (0.0, 0.0))
    lat2, lon2 = seg2.get("midpoint", (0.0, 0.0))
    return math.sqrt((lat2 - lat1) ** 2 + (lon2 - lon1) ** 2)


@router.get("/api/driving_routes/find_clusters")
async def find_clusters_endpoint(location_id: Annotated[str, Query()]):
    """Find connected clusters of undriven street segments."""
    try:
        clusters = await find_connected_undriven_clusters(location_id)
        return JSONResponse(content={"clusters": clusters})
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error finding clusters: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
