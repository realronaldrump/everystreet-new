import json
import logging
import math
import uuid
from collections import defaultdict, deque
from typing import Any

import httpx
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from config import get_mapbox_token
from db import db_manager, find_one_with_retry, streets_collection, trips_collection
from geometry_service import GeometryService
from live_tracking import get_active_trip
from models import LocationModel

logger = logging.getLogger(__name__)
router = APIRouter()


async def _get_mapbox_optimization_route(
    start_lon: float,
    start_lat: float,
    end_points: list[tuple] | None = None,
) -> dict[str, Any]:
    """Calls Mapbox Optimization API v1 to get an optimized route for multiple points."""
    mapbox_token = get_mapbox_token()
    if not mapbox_token:
        raise HTTPException(status_code=500, detail="Mapbox API token not configured.")
    if not end_points:
        # Optimization API needs at least one destination
        raise HTTPException(
            status_code=400, detail="No end points provided for optimization."
        )

    if len(end_points) > 11:
        logger.warning(
            "Too many points for Mapbox Optimization v1 (max 11), limiting to first 11."
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
            logger.error(
                "Mapbox Optimization API HTTP error: %s - %s",
                e.response.status_code,
                e.response.text,
            )
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"Mapbox Optimization API error: {e.response.text}",
            )
        except httpx.RequestError as e:
            logger.error("Mapbox Optimization API request error: %s", e)
            raise HTTPException(
                status_code=503, detail=f"Could not connect to Mapbox API: {e}"
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
            }
        except httpx.HTTPStatusError as e:
            logger.error(
                "Mapbox Directions API HTTP error: %s - %s",
                e.response.status_code,
                e.response.text,
            )
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"Mapbox API error: {e.response.text}",
            )
        except httpx.RequestError as e:
            logger.error("Mapbox Directions API request error: %s", e)
            raise HTTPException(
                status_code=503, detail=f"Could not connect to Mapbox API: {e}"
            )


async def get_current_position(request_data: dict) -> tuple[float, float, str]:
    """Determines the current position from request, live tracking, or last trip."""
    current_position = request_data.get("current_position")
    if current_position and "lat" in current_position and "lon" in current_position:
        return (
            float(current_position["lat"]),
            float(current_position["lon"]),
            "client-provided",
        )

    active_trip_response = await get_active_trip()
    if hasattr(active_trip_response, "trip") and active_trip_response.trip:
        trip = active_trip_response.trip
        if trip.get("coordinates") and len(trip["coordinates"]) > 0:
            latest_coord = trip["coordinates"][-1]
            return latest_coord["lat"], latest_coord["lon"], "live-tracking"

    last_trip = await find_one_with_retry(trips_collection, {}, sort=[("endTime", -1)])
    if not last_trip:
        raise HTTPException(
            status_code=404,
            detail="Current position not provided and no trip history found.",
        )

    gps_data = last_trip.get("gps")

    if gps_data and gps_data.get("coordinates"):
        if gps_data.get("type") == "LineString":
            lon, lat = gps_data["coordinates"][-1]
            return lat, lon, "last-trip-end"
        elif gps_data.get("type") == "MultiLineString":
            # Use the last coordinate of the last line segment
            if gps_data["coordinates"] and len(gps_data["coordinates"]) > 0:
                last_segment = gps_data["coordinates"][-1]
                if last_segment:
                    lon, lat = last_segment[-1]
                    return lat, lon, "last-trip-end-multi"
        elif gps_data.get("type") == "Point":
            lon, lat = gps_data["coordinates"]
            return lat, lon, "last-trip-end-point"

    raise HTTPException(
        status_code=404,  # Changed from 500 to 404 as this is "not found" state
        detail="Could not determine current position from last trip history.",
    )


@router.post("/api/driving-navigation/next-route")
async def get_next_driving_route(request: Request):
    """
    Calculates a route to the nearest undriven street or a specific target segment.

    This now correctly uses the Directions API for simple A-to-B routing.
    """
    try:
        data = await request.json()
        location_data = data.get("location")
        if not location_data:
            return JSONResponse(
                status_code=400, content={"detail": "Target location data is required."}
            )

        location = LocationModel(**location_data)
        location_name = location.display_name
        target_segment_id = data.get("segment_id")

        # Get position - catch ANY error from here to ensure JSON response
        try:
            current_lat, current_lon, location_source = await get_current_position(data)
        except HTTPException as e:
            # Re-raise HTTP exceptions to be caught by outer block
            raise e
        except Exception as e:
            logger.error("Error determining position: %s", e, exc_info=True)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to determine current position: {str(e)}",
            )

        # Validate coordinates are valid numbers
        if not all(math.isfinite(v) for v in [current_lat, current_lon]):
            return JSONResponse(
                status_code=400,
                content={
                    "detail": "Invalid position: coordinates contain NaN or infinite values."
                },
            )

    except (ValueError, TypeError, json.JSONDecodeError) as e:
        return JSONResponse(
            status_code=400, content={"detail": f"Invalid request format: {e!s}"}
        )
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"detail": e.detail})
    except Exception as e:
        logger.error("Unexpected error in next-route init: %s", e, exc_info=True)
        return JSONResponse(
            status_code=500, content={"detail": f"Internal server error: {str(e)}"}
        )

    # Proceed to route calculation
    try:
        target_street = None
        if target_segment_id:
            target_street = await streets_collection.find_one(
                {
                    "properties.segment_id": target_segment_id,
                    "properties.location": location_name,
                },
                {"geometry.coordinates": 1, "properties": 1, "_id": 0},
            )
            if not target_street:
                raise HTTPException(
                    status_code=404,
                    detail=f"Target segment {target_segment_id} not found.",
                )
        else:
            # Find nearest undriven street using geospatial index ($near)
            near_query = {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry": {
                    "$near": {
                        "$geometry": {
                            "type": "Point",
                            "coordinates": [current_lon, current_lat],
                        }
                    }
                },
            }
            target_street = await streets_collection.find_one(
                near_query,
                {"geometry": 1, "properties": 1, "_id": 0},
            )

            if not target_street:
                return JSONResponse(
                    content={
                        "status": "completed",
                        "message": f"No undriven streets found in {location_name}.",
                    }
                )

        if not target_street or not target_street.get("geometry", {}).get(
            "coordinates"
        ):
            # This can happen if we found a street but it has no coords (rare)
            raise HTTPException(
                status_code=404, detail="Could not find a valid target street."
            )

        # Check for geometry type safety - although we query for it, data integrity is key
        geom_type = target_street.get("geometry", {}).get("type")
        if geom_type != "LineString":
            # If we somehow got a MultiLineString or bad data
            logging.warning("Found non-LineString geometry: %s", geom_type)
            # Basic fallback: try to get first line if it's MultiLineString
            coords = target_street["geometry"]["coordinates"]
            if geom_type == "MultiLineString" and coords and len(coords) > 0:
                start_coords = coords[0][0]
            elif geom_type == "LineString" and coords:
                start_coords = coords[0]
            else:
                raise HTTPException(
                    status_code=500, detail=f"Unsupported geometry type: {geom_type}"
                )
        else:
            start_coords = target_street["geometry"]["coordinates"][0]

        route_result = await _get_mapbox_directions_route(
            current_lon, current_lat, start_coords[0], start_coords[1]
        )

        target_street["properties"]["start_coords"] = start_coords
        return JSONResponse(
            content={
                "status": "success",
                "message": "Route to nearest street calculated.",
                "route_geometry": route_result["geometry"],
                "target_street": target_street["properties"],
                "route_duration_seconds": route_result["duration"],
                "route_distance_meters": route_result["distance"],
                "location_source": location_source,
            }
        )

    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error("Error calculating next-route: %s", e, exc_info=True)
        return JSONResponse(
            status_code=500, content={"detail": f"Failed to calculate route: {str(e)}"}
        )


@router.post("/api/mapbox/directions")
async def get_mapbox_directions(request: Request):
    """Proxy endpoint for Mapbox Directions API."""
    try:
        data = await request.json()
        start_lon, start_lat = data.get("start_lon"), data.get("start_lat")
        end_lon, end_lat = data.get("end_lon"), data.get("end_lat")
        if None in [start_lon, start_lat, end_lon, end_lat]:
            raise HTTPException(status_code=400, detail="Missing required coordinates.")

        route_details = await _get_mapbox_directions_route(
            float(start_lon), float(start_lat), float(end_lon), float(end_lat)
        )
        return JSONResponse(content=route_details)
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error("Error getting Mapbox directions: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"Failed to get Mapbox directions: {e}"
        )


async def find_connected_undriven_clusters(
    streets: list[dict[str, Any]], max_distance_km: float = 0.05
) -> list[dict[str, Any]]:
    """Finds clusters of connected undriven street segments using a graph-based approach."""
    if not streets:
        return []

    adjacency = defaultdict(set)
    segment_map = {
        s["properties"]["segment_id"]: s
        for s in streets
        if s.get("properties", {}).get("segment_id")
    }

    for i, street1 in enumerate(streets):
        props1 = street1.get("properties", {})
        geom1 = street1.get("geometry", {})
        id1 = props1.get("segment_id")
        if (
            not id1
            or geom1.get("type") != "LineString"
            or len(geom1.get("coordinates", [])) < 2
        ):
            continue

        start1 = tuple(geom1["coordinates"][0])
        end1 = tuple(geom1["coordinates"][-1])

        for j in range(i + 1, len(streets)):
            props2 = streets[j].get("properties", {})
            geom2 = streets[j].get("geometry", {})
            id2 = props2.get("segment_id")
            if (
                not id2
                or geom2.get("type") != "LineString"
                or len(geom2.get("coordinates", [])) < 2
            ):
                continue

            start2 = tuple(geom2["coordinates"][0])
            end2 = tuple(geom2["coordinates"][-1])

            distances = [
                GeometryService.haversine_distance(
                    start1[0], start1[1], start2[0], start2[1], unit="km"
                ),
                GeometryService.haversine_distance(
                    start1[0], start1[1], end2[0], end2[1], unit="km"
                ),
                GeometryService.haversine_distance(
                    end1[0], end1[1], start2[0], start2[1], unit="km"
                ),
                GeometryService.haversine_distance(
                    end1[0], end1[1], end2[0], end2[1], unit="km"
                ),
            ]
            if min(distances) <= max_distance_km:
                adjacency[id1].add(id2)
                adjacency[id2].add(id1)

    visited = set()
    clusters = []
    for seg_id in segment_map:
        if seg_id not in visited:
            cluster_ids = []
            q = deque([seg_id])
            visited.add(seg_id)
            while q:
                curr_id = q.popleft()
                cluster_ids.append(curr_id)
                for neighbor_id in adjacency[curr_id]:
                    if neighbor_id not in visited:
                        visited.add(neighbor_id)
                        q.append(neighbor_id)

            cluster_segments = [segment_map[cid] for cid in cluster_ids]
            all_coords = [
                coord
                for seg in cluster_segments
                for coord in seg["geometry"]["coordinates"]
            ]
            if not all_coords:
                continue

            centroid_lon = sum(c[0] for c in all_coords) / len(all_coords)
            centroid_lat = sum(c[1] for c in all_coords) / len(all_coords)

            clusters.append(
                {
                    "segments": cluster_segments,
                    "total_length": sum(
                        s["properties"].get("segment_length", 0)
                        for s in cluster_segments
                    ),
                    "segment_count": len(cluster_segments),
                    "centroid": [centroid_lon, centroid_lat],
                }
            )
    return clusters


@router.get("/api/driving-navigation/suggest-next-street/{location_id}")
async def suggest_next_efficient_street(
    location_id: str,
    current_lat: float = Query(...),
    current_lon: float = Query(...),
    top_n: int = Query(3, ge=1, le=10),
    min_cluster_size: int = Query(1, ge=1),
):
    """Suggests the most efficient undriven street clusters based on connectivity, length, and proximity."""
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    coverage_doc = await find_one_with_retry(
        db_manager.db["coverage_metadata"], {"_id": obj_location_id}
    )
    if not coverage_doc:
        raise HTTPException(
            status_code=404, detail=f"Coverage area with ID '{location_id}' not found"
        )

    location_name = coverage_doc.get("location", {}).get("display_name")
    if not location_name:
        raise HTTPException(
            status_code=500, detail="Coverage area is missing display name."
        )

    undriven_streets_cursor = streets_collection.find(
        {
            "properties.location": location_name,
            "properties.driven": False,
            "properties.undriveable": {"$ne": True},
            "geometry.type": "LineString",
            "geometry.coordinates": {"$exists": True, "$not": {"$size": 0}},
        }
    )
    undriven_streets = await undriven_streets_cursor.to_list(length=None)

    if not undriven_streets:
        return JSONResponse(
            content={
                "status": "no_streets",
                "message": f"No undriven streets found in {location_name}.",
            }
        )

    clusters = await find_connected_undriven_clusters(undriven_streets)
    viable_clusters = [c for c in clusters if c["segment_count"] >= min_cluster_size]

    if not viable_clusters:
        return JSONResponse(
            content={
                "status": "no_clusters",
                "message": f"No connected street clusters of size >= {min_cluster_size} found.",
            }
        )

    scored_clusters = []
    for cluster in viable_clusters:
        distance_km = GeometryService.haversine_distance(
            current_lon,
            current_lat,
            cluster["centroid"][0],
            cluster["centroid"][1],
            unit="km",
        )
        score = (
            (cluster["total_length"] / 1000.0)
            * math.log(cluster["segment_count"] + 1)
            / (distance_km + 0.1)
        )

        nearest_segment = min(
            cluster["segments"],
            key=lambda s: GeometryService.haversine_distance(
                current_lon,
                current_lat,
                s["geometry"]["coordinates"][0][0],
                s["geometry"]["coordinates"][0][1],
            ),
        )

        scored_clusters.append(
            {
                "cluster_id": str(uuid.uuid4()),
                "segment_count": cluster["segment_count"],
                "total_length_m": cluster["total_length"],
                "distance_to_cluster_m": distance_km * 1000,
                "efficiency_score": score,
                "centroid": cluster["centroid"],
                "nearest_segment": {
                    "segment_id": nearest_segment["properties"]["segment_id"],
                    "street_name": nearest_segment["properties"].get(
                        "street_name", "Unnamed Street"
                    ),
                    "start_coords": nearest_segment["geometry"]["coordinates"][0],
                },
                "segments": [
                    {
                        "segment_id": s["properties"]["segment_id"],
                        "street_name": s["properties"].get("street_name", "Unnamed"),
                        "geometry": s["geometry"],
                        "segment_length": s["properties"].get("segment_length", 0),
                    }
                    for s in cluster["segments"]
                ],
            }
        )

    scored_clusters.sort(key=lambda x: x["efficiency_score"], reverse=True)

    return JSONResponse(
        content={
            "status": "success",
            "message": f"Found {len(scored_clusters)} efficient street clusters",
            "suggested_clusters": scored_clusters[:top_n],
        }
    )
