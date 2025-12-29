import asyncio
import json
import logging
import math
import os
import uuid
from collections import defaultdict, deque
from typing import Any

import httpx
import numpy as np
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sklearn.cluster import KMeans

from config import MAPBOX_ACCESS_TOKEN
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
    if not MAPBOX_ACCESS_TOKEN:
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
        "access_token": MAPBOX_ACCESS_TOKEN,
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
    if not MAPBOX_ACCESS_TOKEN:
        raise HTTPException(status_code=500, detail="Mapbox API token not configured.")

    coords_str = f"{start_lon},{start_lat};{end_lon},{end_lat}"
    url = f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords_str}"
    params = {
        "access_token": MAPBOX_ACCESS_TOKEN,
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

    if (
        gps_data
        and gps_data.get("type") == "LineString"
        and gps_data.get("coordinates")
    ):
        lon, lat = gps_data["coordinates"][-1]
        return lat, lon, "last-trip-end"
    if gps_data and gps_data.get("type") == "Point" and gps_data.get("coordinates"):
        lon, lat = gps_data["coordinates"]
        return lat, lon, "last-trip-end-point"

    raise HTTPException(
        status_code=500,
        detail="Could not determine current position from last trip's geometry.",
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
            raise HTTPException(
                status_code=400, detail="Target location data is required."
            )

        location = LocationModel(**location_data)
        location_name = location.display_name
        target_segment_id = data.get("segment_id")
        current_lat, current_lon, location_source = await get_current_position(data)

        # Validate coordinates are valid numbers
        if not all(math.isfinite(v) for v in [current_lat, current_lon]):
            raise HTTPException(
                status_code=400,
                detail="Invalid position: coordinates contain NaN or infinite values.",
            )

    except (ValueError, TypeError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid request format: {e!s}")
    except HTTPException as e:
        raise e

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
                {"geometry.coordinates": 1, "properties": 1, "_id": 0},
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
            raise HTTPException(
                status_code=404, detail="Could not find a valid target street."
            )

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
        raise HTTPException(status_code=500, detail=f"Failed to calculate route: {e}")


async def _cluster_segments(
    segments: list[dict], max_points_per_cluster: int = 11
) -> list[list[dict]]:
    """Cluster segments into groups based on geographic proximity using KMeans."""
    if not segments:
        return []

    segment_coords = []
    valid_segments = []
    for seg in segments:
        coords = seg.get("geometry", {}).get("coordinates")
        if coords and len(coords) > 0:
            lon, lat = float(coords[0][0]), float(coords[0][1])
            seg["start_node"] = (lon, lat)
            segment_coords.append((lon, lat))
            valid_segments.append(seg)

    if not valid_segments:
        return []

    if len(valid_segments) <= max_points_per_cluster:
        return [valid_segments]

    coords_np = np.array(segment_coords)
    n_clusters = min(
        max(1, len(valid_segments) // max_points_per_cluster), len(valid_segments)
    )

    try:
        kmeans = KMeans(n_clusters=n_clusters, random_state=0, n_init="auto").fit(
            coords_np
        )
        labels = kmeans.labels_
    except ValueError:
        return [
            valid_segments[i : i + max_points_per_cluster]
            for i in range(0, len(valid_segments), max_points_per_cluster)
        ]

    clustered_segments_dict = defaultdict(list)
    for i, label in enumerate(labels):
        clustered_segments_dict[label].append(valid_segments[i])

    final_clusters = []
    for segments_in_cluster in clustered_segments_dict.values():
        if len(segments_in_cluster) > max_points_per_cluster:
            for i in range(0, len(segments_in_cluster), max_points_per_cluster):
                final_clusters.append(
                    segments_in_cluster[i : i + max_points_per_cluster]
                )
        elif segments_in_cluster:
            final_clusters.append(segments_in_cluster)

    return final_clusters


async def _optimize_route_for_clusters(
    start_point: tuple[float, float], clusters: list[list[dict]]
) -> dict[str, Any]:
    """
    Optimizes a route through multiple clusters of street segments.

    This version correctly handles clusters of size 1.
    """
    if not clusters:
        raise HTTPException(
            status_code=400, detail="No clusters for route optimization."
        )

    total_duration, total_distance = 0.0, 0.0
    all_geometries = []
    current_lon, current_lat = start_point

    # Sort clusters by distance from the start point to determine the first cluster
    clusters.sort(
        key=lambda c: GeometryService.haversine_distance(
            start_point[0], start_point[1], c[0]["start_node"][0], c[0]["start_node"][1]
        )
    )

    for _i, cluster_segments in enumerate(clusters):
        if not cluster_segments:
            continue

        # Find the nearest point in the current cluster to the current position
        nearest_point_in_cluster = min(
            (seg["start_node"] for seg in cluster_segments),
            key=lambda p: GeometryService.haversine_distance(
                current_lon, current_lat, p[0], p[1]
            ),
        )

        # 1. Get a simple route to the nearest point of the cluster
        connection_result = await _get_mapbox_directions_route(
            current_lon,
            current_lat,
            nearest_point_in_cluster[0],
            nearest_point_in_cluster[1],
        )
        all_geometries.append(connection_result["geometry"])
        total_duration += connection_result["duration"]
        total_distance += connection_result["distance"]

        # 2. Optimize the route *within* the cluster
        cluster_destinations = [seg["start_node"] for seg in cluster_segments]

        # If there's more than one point, optimize. Otherwise, we're already at the single point.
        if len(cluster_destinations) > 1:
            # The start for the optimization is the point we just routed to
            optimization_start_lon, optimization_start_lat = nearest_point_in_cluster
            # The destinations for optimization are all other points in the cluster
            optimization_end_points = [
                p for p in cluster_destinations if p != nearest_point_in_cluster
            ]

            cluster_opt_result = await _get_mapbox_optimization_route(
                optimization_start_lon,
                optimization_start_lat,
                end_points=optimization_end_points,
            )
            all_geometries.append(cluster_opt_result["geometry"])
            total_duration += cluster_opt_result["duration"]
            total_distance += cluster_opt_result["distance"]

            # Update current position to the end of this cluster's optimized route
            last_waypoint_coords = cluster_opt_result["waypoints"][-1]["location"]
            current_lon, current_lat = last_waypoint_coords[0], last_waypoint_coords[1]
        else:
            # If the cluster has only one point, our new position is that point
            current_lon, current_lat = nearest_point_in_cluster

        await asyncio.sleep(0.2)  # Rate limiting

    return {
        "geometry": {"type": "GeometryCollection", "geometries": all_geometries},
        "duration": total_duration,
        "distance": total_distance,
    }


@router.post("/api/driving-navigation/coverage-route")
async def get_coverage_driving_route(request: Request):
    """Calculates an optimized route to cover multiple undriven street segments."""
    try:
        data = await request.json()
        location_data = data.get("location")
        if not location_data:
            raise HTTPException(
                status_code=400, detail="Target location data is required."
            )

        location = LocationModel(**location_data)
        location_name = location.display_name
        current_lat, current_lon, location_source = await get_current_position(data)

        # Validate coordinates are valid numbers
        if not all(math.isfinite(v) for v in [current_lat, current_lon]):
            raise HTTPException(
                status_code=400,
                detail="Invalid position: coordinates contain NaN or infinite values.",
            )

        start_point = (current_lon, current_lat)

    except (ValueError, TypeError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid request format: {e!s}")
    except HTTPException as e:
        raise e

    try:
        # Pull only a limited set of nearest segments to minimize memory
        max_candidates = int(os.getenv("COVERAGE_MAX_NEAR_SEGMENTS", "60"))
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
        undriven_streets_cursor = streets_collection.find(
            near_query,
            {"geometry": 1, "properties": 1, "_id": 0},
        ).limit(max_candidates)
        undriven_streets_list = await undriven_streets_cursor.to_list(
            length=max_candidates
        )

        if not undriven_streets_list:
            return JSONResponse(
                content={
                    "status": "completed",
                    "message": f"No undriven streets in {location_name}.",
                }
            )

        clusters = await _cluster_segments(
            undriven_streets_list, max_points_per_cluster=11
        )
        if not clusters:
            return JSONResponse(
                content={"status": "error", "message": "Failed to cluster segments."}
            )

        optimization_result = await _optimize_route_for_clusters(start_point, clusters)

        segments_in_route = sum(len(c) for c in clusters)
        message = f"Coverage route for {segments_in_route} segments across {len(clusters)} clusters."

        return JSONResponse(
            content={
                "status": "success",
                "message": message,
                "route_geometry": optimization_result["geometry"],
                "total_duration_seconds": optimization_result["duration"],
                "total_distance_meters": optimization_result["distance"],
                "location_source": location_source,
                "clusters_count": len(clusters),
                "segments_in_route_count": segments_in_route,
            }
        )
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error("Error generating coverage route: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"Failed to generate coverage route: {e}"
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
