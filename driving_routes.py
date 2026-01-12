import logging
import math
from collections import defaultdict
from typing import Annotated, Any

import httpx
from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from config import get_mapbox_token
from coverage.models import CoverageArea, CoverageState, Street
from db.models import Trip
from live_tracking import get_active_trip

logger = logging.getLogger(__name__)
router = APIRouter()


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
        return await get_current_position(request_data)

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

