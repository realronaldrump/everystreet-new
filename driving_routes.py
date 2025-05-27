import asyncio
import json
import logging
import os
import uuid
from collections import defaultdict
from typing import Any

import geojson as geojson_module
import httpx
import numpy as np
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sklearn.cluster import KMeans

from db import (
    find_one_with_retry,
    streets_collection,
    trips_collection,
)  # Assuming db_manager and collections are accessible
from live_tracking import get_active_trip
from models import LocationModel
from utils import haversine  # Assuming haversine is in utils

logger = logging.getLogger(__name__)
router = APIRouter()

MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")


async def _get_mapbox_optimization_route(
    start_lon: float,
    start_lat: float,
    end_points: list[tuple] | None = None,
) -> dict[str, Any]:
    """Calls Mapbox Optimization API v1 to get an optimized route for multiple
    points.
    """
    mapbox_token = MAPBOX_ACCESS_TOKEN
    if not mapbox_token:
        logger.error("Mapbox API token not configured.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Mapbox API token not configured.",
        )

    if not end_points:
        logger.error("No end points provided for optimization route.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No end points provided for optimization route.",
        )

    if (
        len(end_points) > 11
    ):  # Mapbox Optimization API v1 limit (start + 11 waypoints = 12 total)
        logger.warning(
            "Too many end points for Mapbox Optimization API v1 (max 11 destinations + start). Limiting to first 11.",
        )
        end_points = end_points[:11]

    coords = [f"{start_lon},{start_lat}"]
    for lon, lat in end_points:
        coords.append(f"{lon},{lat}")
    coords_str = ";".join(coords)

    url = f"https://api.mapbox.com/optimized-trips/v1/mapbox/driving/{coords_str}"
    params = {
        "access_token": mapbox_token,
        "geometries": "geojson",
        "steps": "false",
        "overview": "full",
        "source": "first",
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(url, params=params)

        if response.status_code != 200:
            logger.error(
                "Mapbox Optimization API error: %s - %s",
                response.status_code,
                response.text,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Mapbox Optimization API error: {response.status_code} - {response.text}",
            )

        data = response.json()
        if data.get("code") != "Ok" or not data.get("trips"):
            logger.error(
                "Mapbox Optimization API returned no valid trips: %s",
                data,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Mapbox Optimization API returned no valid trips: {data.get('message', 'Unknown reason')}",
            )

        trip = data["trips"][0]
        geometry = trip.get("geometry", {})
        duration = trip.get("duration", 0)
        distance = trip.get("distance", 0)

        return {
            "geometry": geometry,
            "duration": duration,
            "distance": distance,
            "waypoints": trip.get("waypoints", []),
        }


@router.post("/api/driving-navigation/next-route")
async def get_next_driving_route(
    request: Request,
):
    """Calculates the route from the user's current position to the
    start of the nearest undriven street segment in the specified area using Mapbox
    Optimization API v1.
    """
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Target location data is required",
            )

        location = LocationModel(**data["location"])
        location_name = location.display_name

        if not location_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location display name is required.",
            )

        current_position = data.get("current_position")

    except (ValueError, TypeError, json.JSONDecodeError) as e:
        logger.error("Error parsing request data for next-route: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid request format: {e!s}",
        )

    current_lat: float
    current_lon: float
    location_source: str

    try:
        if (
            current_position
            and isinstance(current_position, dict)
            and "lat" in current_position
            and "lon" in current_position
        ):
            current_lat = float(current_position["lat"])
            current_lon = float(current_position["lon"])
            location_source = "client-provided"
            logger.info(
                "Using client-provided location: Lat=%s, Lon=%s",
                current_lat,
                current_lon,
            )
        else:
            logger.info(
                "No position provided in request, falling back to live tracking data",
            )
            active_trip_data = await get_active_trip()
            if (
                active_trip_data
                and isinstance(active_trip_data, dict)
                and active_trip_data.get("coordinates")
                and len(active_trip_data["coordinates"]) > 0
            ):
                latest_coord_point = active_trip_data["coordinates"][-1]
                current_lat = latest_coord_point["lat"]
                current_lon = latest_coord_point["lon"]
                location_source = "live-tracking"
                logger.info(
                    "Using live tracking location: Lat=%s, Lon=%s",
                    current_lat,
                    current_lon,
                )
            else:
                logger.info(
                    "Live tracking unavailable, falling back to last trip end location",
                )
                last_trip = await find_one_with_retry(
                    trips_collection, {}, sort=[("endTime", -1)]
                )
                if not last_trip:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Current position not provided, live location unavailable, and no previous trips found.",
                    )
                try:
                    gps_data = last_trip.get("gps")
                    if isinstance(gps_data, str):
                        gps_data = geojson_module.loads(gps_data)
                    geom = last_trip.get("geometry") or gps_data
                    if (
                        geom
                        and geom.get("type") == "LineString"
                        and len(geom.get("coordinates", [])) > 0
                    ):
                        last_coord = geom["coordinates"][-1]
                        current_lon = float(last_coord[0])
                        current_lat = float(last_coord[1])
                        location_source = "last-trip-end"
                        logger.info(
                            "Using last trip end location: Lat=%s, Lon=%s (Trip ID: %s)",
                            current_lat,
                            current_lon,
                            last_trip.get("transactionId", "N/A"),
                        )
                    else:
                        raise ValueError(
                            "Invalid or empty geometry/gps in last trip"
                        )
                except (
                    json.JSONDecodeError,
                    ValueError,
                    TypeError,
                    IndexError,
                ) as e:
                    logger.error(
                        "Failed to extract end location from last trip %s: %s",
                        last_trip.get("transactionId", "N/A"),
                        e,
                    )
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="Failed to determine starting location from last trip.",
                    )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Error getting position for next-route: %s", e, exc_info=True
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not determine current position: {e}",
        )

    try:
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {
                "geometry.coordinates": 1,
                "properties.segment_id": 1,
                "properties.street_name": 1,
                "_id": 0,
                "geometry.type": 1,
            },
        )
        undriven_streets = await undriven_streets_cursor.to_list(length=None)

        if not undriven_streets:
            return JSONResponse(
                content={
                    "status": "completed",
                    "message": f"No undriven streets found in {location_name}.",
                    "route_geometry": None,
                    "target_street": None,
                },
            )
        logger.info(
            "Found %d undriven segments in %s. Starting optimization with Mapbox API v1.",
            len(undriven_streets),
            location_name,
        )
    except Exception as e:
        logger.error(
            "Error fetching undriven streets for %s (next-route): %s",
            location_name,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error fetching undriven streets: {e}",
        )

    try:
        end_points_with_street_info = []
        for street in undriven_streets:
            geometry = street.get("geometry", {})
            if geometry.get("type") == "LineString" and geometry.get(
                "coordinates"
            ):
                start_node = geometry["coordinates"][0]
                if (
                    isinstance(start_node, (list, tuple))
                    and len(start_node) >= 2
                ):
                    end_points_with_street_info.append(
                        {
                            "coord": (
                                float(start_node[0]),
                                float(start_node[1]),
                            ),
                            "street_info": street.get("properties", {}),
                        }
                    )
        if not end_points_with_street_info:
            return JSONResponse(
                content={
                    "status": "completed",
                    "message": f"No valid undriven streets with coordinates found in {location_name} for routing.",
                    "route_geometry": None,
                    "target_street": None,
                },
            )

        current_pos_tuple = (current_lon, current_lat)
        end_points_with_street_info.sort(
            key=lambda p: haversine(
                current_pos_tuple[0],
                current_pos_tuple[1],
                p["coord"][0],
                p["coord"][1],
            )
        )
        destinations_for_api = [
            p["coord"] for p in end_points_with_street_info[:11]
        ]
        optimization_result = await _get_mapbox_optimization_route(
            current_lon, current_lat, end_points=destinations_for_api
        )
        route_geometry = optimization_result["geometry"]
        route_duration_seconds = optimization_result["duration"]
        route_distance_meters = optimization_result["distance"]
        optimized_waypoints = optimization_result.get("waypoints", [])
        target_street_info = None
        if len(optimized_waypoints) > 1:
            first_optimized_destination_waypoint = optimized_waypoints[1]
            original_destination_index = (
                first_optimized_destination_waypoint.get("waypoint_index")
            )
            if (
                original_destination_index is not None
                and original_destination_index
                < len(end_points_with_street_info)
            ):
                target_street_info = end_points_with_street_info[
                    original_destination_index
                ]["street_info"]
        return JSONResponse(
            content={
                "status": "success",
                "message": "Route calculated using Mapbox Optimization API v1.",
                "route_geometry": route_geometry,
                "target_street": target_street_info,
                "route_duration_seconds": route_duration_seconds,
                "route_distance_meters": route_distance_meters,
                "location_source": location_source,
            },
        )
    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error("Error calculating next-route: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to calculate route: {e}",
        )


async def _get_mapbox_directions_route(
    start_lon: float,
    start_lat: float,
    end_lon: float,
    end_lat: float,
) -> dict[str, Any]:
    """Calls Mapbox Directions API to get a route between two points."""
    mapbox_token = MAPBOX_ACCESS_TOKEN
    if not mapbox_token:
        logger.error("Mapbox API token not configured.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Mapbox API token not configured.",
        )

    coords_str = f"{start_lon},{start_lat};{end_lon},{end_lat}"
    directions_url = (
        f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords_str}"
    )
    params = {
        "access_token": mapbox_token,
        "geometries": "geojson",
        "overview": "full",
        "steps": "false",
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(directions_url, params=params)

        if response.status_code != 200:
            logger.error(
                "Mapbox Directions API error: %s - %s",
                response.status_code,
                response.text,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Mapbox Directions API error: {response.status_code} - {response.text}",
            )

        route_data = response.json()
        if not route_data.get("routes") or len(route_data["routes"]) == 0:
            logger.warning(
                "Mapbox API returned no routes for %s,%s -> %s,%s. Response: %s",
                start_lon,
                start_lat,
                end_lon,
                end_lat,
                route_data,
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No route found by Mapbox Directions API. Message: {route_data.get('message', 'Unknown reason')}",
            )

        route = route_data["routes"][0]
        geometry = route["geometry"]
        duration = route.get("duration", 0)
        distance = route.get("distance", 0)

        logger.debug(
            "Mapbox Route Received: Duration=%.1fs, Distance=%.1fm",
            duration,
            distance,
        )
        return {
            "geometry": geometry,
            "duration": duration,
            "distance": distance,
        }


async def _cluster_segments(
    segments: list[dict],
    max_points_per_cluster: int = 11,
) -> list[list[dict]]:
    """Cluster segments into groups based on geographic proximity."""
    if not segments:
        return []
    if len(segments) <= max_points_per_cluster:
        return [segments]

    coords = np.array(
        [
            (seg["start_node"][0], seg["start_node"][1])
            for seg in segments
            if seg.get("start_node")
        ],
    )

    if coords.shape[0] == 0:
        return []

    n_clusters = min(
        max(1, coords.shape[0] // max_points_per_cluster), coords.shape[0]
    )

    try:
        kmeans = KMeans(
            n_clusters=n_clusters, random_state=0, n_init="auto"
        ).fit(coords)
    except ValueError as e:
        logger.warning(
            f"KMeans clustering failed: {e}. Falling back to simpler clustering."
        )
        if coords.shape[0] <= max_points_per_cluster:
            return [segments]
        return [
            segments[i : i + max_points_per_cluster]
            for i in range(0, len(segments), max_points_per_cluster)
        ]

    labels = kmeans.labels_
    clusters_dict = defaultdict(list)
    valid_segment_idx = 0
    for i, seg in enumerate(segments):
        if seg.get("start_node"):
            clusters_dict[labels[valid_segment_idx]].append(seg)
            valid_segment_idx += 1

    clusters = [
        cluster_list for cluster_list in clusters_dict.values() if cluster_list
    ]
    final_clusters = []
    for cluster in clusters:
        if len(cluster) > max_points_per_cluster:
            for i in range(0, len(cluster), max_points_per_cluster):
                final_clusters.append(cluster[i : i + max_points_per_cluster])
        elif cluster:
            final_clusters.append(cluster)
    return final_clusters


async def _optimize_route_for_clusters(
    start_point: tuple[float, float], clusters: list[list[dict]]
) -> dict[str, Any]:
    """Optimize route for multiple clusters, connecting them with directions."""
    if not clusters:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No clusters provided for route optimization.",
        )

    total_duration = 0.0
    total_distance = 0.0
    all_geometries = []
    current_lon, current_lat = start_point

    for i, cluster_segments in enumerate(clusters):
        if not cluster_segments:
            continue

        cluster_destinations = [
            seg["start_node"]
            for seg in cluster_segments
            if seg.get("start_node")
        ]
        if not cluster_destinations:
            logger.warning(f"Cluster {i} has no valid destinations, skipping.")
            continue

        try:
            cluster_opt_result = await _get_mapbox_optimization_route(
                current_lon, current_lat, end_points=cluster_destinations
            )
            if cluster_opt_result and cluster_opt_result.get("geometry"):
                all_geometries.append(cluster_opt_result["geometry"])
                total_duration += cluster_opt_result.get("duration", 0)
                total_distance += cluster_opt_result.get("distance", 0)
                if cluster_opt_result["geometry"].get("coordinates"):
                    last_coord_in_cluster_route = cluster_opt_result[
                        "geometry"
                    ]["coordinates"][-1]
                    current_lon, current_lat = (
                        last_coord_in_cluster_route[0],
                        last_coord_in_cluster_route[1],
                    )
                else:
                    optimized_waypoints = cluster_opt_result.get(
                        "waypoints", []
                    )
                    if optimized_waypoints:
                        last_waypoint_in_cluster = optimized_waypoints[-1]
                        current_lon, current_lat = (
                            last_waypoint_in_cluster.get(
                                "location", [current_lon, current_lat]
                            )
                        )
            if i < len(clusters) - 1:
                next_cluster_segments = clusters[i + 1]
                if next_cluster_segments and next_cluster_segments[0].get(
                    "start_node"
                ):
                    next_cluster_start_lon, next_cluster_start_lat = (
                        next_cluster_segments[0]["start_node"]
                    )
                    try:
                        connection_result = await _get_mapbox_directions_route(
                            current_lon,
                            current_lat,
                            next_cluster_start_lon,
                            next_cluster_start_lat,
                        )
                        if connection_result and connection_result.get(
                            "geometry"
                        ):
                            all_geometries.append(
                                connection_result["geometry"]
                            )
                            total_duration += connection_result.get(
                                "duration", 0
                            )
                            total_distance += connection_result.get(
                                "distance", 0
                            )
                            current_lon, current_lat = (
                                next_cluster_start_lon,
                                next_cluster_start_lat,
                            )
                    except HTTPException as e_dir:
                        logger.warning(
                            f"Could not get directions between cluster {i} and {i + 1}: {e_dir.detail}"
                        )
            await asyncio.sleep(0.2)
        except HTTPException as e_opt:
            logger.warning(
                f"Optimization for cluster {i} failed: {e_opt.detail}. Skipping cluster."
            )
            continue

    combined_geometry = {
        "type": "GeometryCollection",
        "geometries": all_geometries,
    }
    return {
        "geometry": combined_geometry,
        "duration": total_duration,
        "distance": total_distance,
    }


@router.post("/api/driving-navigation/coverage-route")
async def get_coverage_driving_route(
    request: Request,
):
    """Calculates an optimized route to cover multiple undriven street segments."""
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Target location data is required",
            )
        location = LocationModel(**data["location"])
        location_name = location.display_name
        if not location_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location display name is required.",
            )
        current_position_data = data.get("current_position")
    except (ValueError, TypeError, json.JSONDecodeError) as e:
        logger.error("Error parsing request data for coverage-route: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid request format: {e!s}",
        )

    current_lat: float
    current_lon: float
    location_source: str
    start_point: tuple[float, float]

    try:
        if (
            current_position_data
            and isinstance(current_position_data, dict)
            and "lat" in current_position_data
            and "lon" in current_position_data
        ):
            current_lat = float(current_position_data["lat"])
            current_lon = float(current_position_data["lon"])
            location_source = "client-provided"
        else:
            active_trip_data = await get_active_trip()
            if (
                active_trip_data
                and isinstance(active_trip_data, dict)
                and active_trip_data.get("coordinates")
                and len(active_trip_data["coordinates"]) > 0
            ):
                latest_coord = active_trip_data["coordinates"][-1]
                current_lat, current_lon = (
                    latest_coord["lat"],
                    latest_coord["lon"],
                )
                location_source = "live-tracking"
            else:
                last_trip = await find_one_with_retry(
                    trips_collection, {}, sort=[("endTime", -1)]
                )
                if not last_trip:
                    raise HTTPException(
                        status_code=404,
                        detail="Cannot determine start: No current_position, live tracking, or previous trips.",
                    )
                gps_data = last_trip.get("gps")
                if isinstance(gps_data, str):
                    gps_data = geojson_module.loads(gps_data)
                geom = last_trip.get("geometry") or gps_data
                if (
                    geom
                    and geom.get("type") == "LineString"
                    and len(geom.get("coordinates", [])) > 0
                ):
                    last_coord_pair = geom["coordinates"][-1]
                    current_lon, current_lat = (
                        float(last_coord_pair[0]),
                        float(last_coord_pair[1]),
                    )
                    location_source = "last-trip-end"
                else:
                    raise ValueError(
                        "Invalid geometry in last trip for start point."
                    )
        start_point = (current_lon, current_lat)
        logger.info(
            f"Coverage Route: Start point set to ({current_lon}, {current_lat}) via {location_source}"
        )
    except Exception as e:
        logger.error(
            "Coverage Route: Error getting start position: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Could not determine current position: {e}",
        )

    try:
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {
                "geometry": 1,
                "properties.segment_id": 1,
                "properties.street_name": 1,
                "_id": 0,
            },
        )
        undriven_streets_list = await undriven_streets_cursor.to_list(
            length=None
        )
        if not undriven_streets_list:
            return JSONResponse(
                content={
                    "status": "completed",
                    "message": f"No undriven streets in {location_name}.",
                }
            )
        valid_segments = []
        for street_doc in undriven_streets_list:
            geom = street_doc.get("geometry")
            props = street_doc.get("properties", {})
            if (
                geom
                and geom.get("type") == "LineString"
                and len(geom.get("coordinates", [])) >= 1
            ):
                coords = geom["coordinates"]
                try:
                    start_node_lonlat = (
                        float(coords[0][0]),
                        float(coords[0][1]),
                    )
                    valid_segments.append(
                        {
                            "id": props.get("segment_id", str(uuid.uuid4())),
                            "name": props.get("street_name"),
                            "geometry": geom,
                            "start_node": start_node_lonlat,
                        }
                    )
                except (TypeError, ValueError, IndexError) as e_coord:
                    logger.warning(
                        f"Skipping segment {props.get('segment_id')} due to coordinate error: {e_coord}"
                    )
        if not valid_segments:
            return JSONResponse(
                content={
                    "status": "error",
                    "message": f"No processable undriven streets in {location_name}.",
                }
            )
        logger.info(
            f"Coverage Route: Processing {len(valid_segments)} valid undriven segments for {location_name}."
        )
    except Exception as e:
        logger.error(
            f"Coverage Route: Error fetching/processing streets for {location_name}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"Error preparing segments: {e}"
        )

    try:
        clusters = await _cluster_segments(
            valid_segments, max_points_per_cluster=11
        )
        if not clusters:
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "Failed to cluster segments.",
                }
            )
        logger.info(
            f"Coverage Route: Clustered {len(valid_segments)} segments into {len(clusters)} clusters."
        )
        optimization_result = await _optimize_route_for_clusters(
            start_point, clusters
        )
        segments_covered = sum(len(c) for c in clusters)
        message = f"Coverage route for {segments_covered} segments in {len(clusters)} clusters."
        logger.info(
            f"Coverage Route: Generated route for {location_name}. Segments: {segments_covered}, Duration: {optimization_result['duration']:.1f}s, Distance: {optimization_result['distance']:.1f}m"
        )
        return JSONResponse(
            content={
                "status": "success",
                "message": message,
                "route_geometry": optimization_result["geometry"],
                "total_duration_seconds": optimization_result["duration"],
                "total_distance_meters": optimization_result["distance"],
                "location_source": location_source,
            }
        )
    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(
            f"Coverage Route: Error generating optimized route: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to generate coverage route: {e}"
        )


@router.post("/api/mapbox/directions")
async def get_mapbox_directions(request: Request):
    """Proxy endpoint for Mapbox Directions API."""
    try:
        data = await request.json()
        start_lon = data.get("start_lon")
        start_lat = data.get("start_lat")
        end_lon = data.get("end_lon")
        end_lat = data.get("end_lat")

        if None in [start_lon, start_lat, end_lon, end_lat]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing required coordinates (start_lon, start_lat, end_lon, end_lat)",
            )

        route_details = await _get_mapbox_directions_route(
            float(start_lon), float(start_lat), float(end_lon), float(end_lat)
        )
        return JSONResponse(content=route_details)

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error("Error getting Mapbox directions: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get Mapbox directions: {str(e)}",
        )


@router.post("/api/driving-navigation/simple-route")
async def get_simple_driving_route(request: Request):
    """Finds nearby undriven streets and calculates basic routes."""
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=400, detail="Target location data is required"
            )
        location_model = LocationModel(**data["location"])
        location_name = location_model.display_name
        if not location_name:
            raise HTTPException(
                status_code=400, detail="Location display name is required."
            )
        user_loc_data = data.get("user_location")
        if (
            not user_loc_data
            or "lat" not in user_loc_data
            or "lon" not in user_loc_data
        ):
            raise HTTPException(
                status_code=400, detail="User location {lat, lon} is required"
            )
        user_lat, user_lon = (
            float(user_loc_data["lat"]),
            float(user_loc_data["lon"]),
        )
        limit = int(data.get("limit", 10))
    except (ValueError, TypeError, json.JSONDecodeError) as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid request format: {e}"
        )

    try:
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {"geometry": 1, "properties": 1, "_id": 0},
        )
        undriven_streets = await undriven_streets_cursor.to_list(length=None)
        if not undriven_streets:
            return JSONResponse(
                content={
                    "status": "success",
                    "message": f"No undriven streets in {location_name}.",
                    "streets": [],
                }
            )
        streets_with_distance = []
        for street_doc in undriven_streets:
            geom = street_doc.get("geometry", {})
            if geom.get("type") == "LineString" and geom.get("coordinates"):
                coords = geom["coordinates"]
                if coords and len(coords[0]) >= 2:
                    street_start_lon, street_start_lat = (
                        float(coords[0][0]),
                        float(coords[0][1]),
                    )
                    distance = haversine(
                        user_lon,
                        user_lat,
                        street_start_lon,
                        street_start_lat,
                        unit="miles",
                    )
                    streets_with_distance.append(
                        {
                            "street_properties": street_doc.get(
                                "properties", {}
                            ),
                            "street_geometry": geom,
                            "distance_to_start_miles": distance,
                            "start_coords_lonlat": (
                                street_start_lon,
                                street_start_lat,
                            ),
                        }
                    )
        streets_with_distance.sort(key=lambda x: x["distance_to_start_miles"])
        nearby_streets_data = streets_with_distance[:limit]
        return JSONResponse(
            content={
                "status": "success",
                "message": f"Found {len(nearby_streets_data)} nearby undriven streets.",
                "streets": [
                    {
                        "properties": s_data["street_properties"],
                        "geometry": s_data["street_geometry"],
                        "distance_to_start_miles": round(
                            s_data["distance_to_start_miles"], 2
                        ),
                        "start_coords_lonlat": s_data["start_coords_lonlat"],
                    }
                    for s_data in nearby_streets_data
                ],
                "user_location": {"lat": user_lat, "lon": user_lon},
            }
        )
    except Exception as e:
        logger.error(
            "Error finding nearby streets (simple-route): %s", e, exc_info=True
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to find nearby streets: {e}"
        )


@router.post("/api/driving-navigation/optimized-route")
async def get_optimized_multi_street_route(request: Request):
    """Create an optimized route visiting multiple undriven streets efficiently."""
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=400, detail="Target location data is required"
            )
        location_model = LocationModel(**data["location"])
        location_name = location_model.display_name
        if not location_name:
            raise HTTPException(
                status_code=400, detail="Location display name is required."
            )
        user_loc_data = data.get("user_location")
        if (
            not user_loc_data
            or "lat" not in user_loc_data
            or "lon" not in user_loc_data
        ):
            raise HTTPException(
                status_code=400, detail="User location {lat, lon} is required"
            )
        user_lat, user_lon = (
            float(user_loc_data["lat"]),
            float(user_loc_data["lon"]),
        )
        max_streets_to_optimize = min(int(data.get("max_streets", 5)), 11)
        max_distance_miles = float(data.get("max_distance_miles", 2.0))
    except (ValueError, TypeError, json.JSONDecodeError) as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid request format: {e}"
        )

    try:
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {"geometry": 1, "properties": 1, "_id": 0},
        )
        all_undriven_streets = await undriven_streets_cursor.to_list(
            length=None
        )
        if not all_undriven_streets:
            return JSONResponse(
                content={
                    "status": "no_streets",
                    "message": f"No undriven streets in {location_name}.",
                }
            )
        streets_in_radius = []
        for street_doc in all_undriven_streets:
            geom = street_doc.get("geometry", {})
            if geom.get("type") == "LineString" and geom.get("coordinates"):
                coords = geom["coordinates"]
                if coords and len(coords[0]) >= 2:
                    street_start_lon, street_start_lat = (
                        float(coords[0][0]),
                        float(coords[0][1]),
                    )
                    distance = haversine(
                        user_lon,
                        user_lat,
                        street_start_lon,
                        street_start_lat,
                        unit="miles",
                    )
                    if distance <= max_distance_miles:
                        streets_in_radius.append(
                            {
                                "properties": street_doc.get("properties", {}),
                                "geometry": geom,
                                "distance_to_start_miles": distance,
                                "start_coords_lonlat": (
                                    street_start_lon,
                                    street_start_lat,
                                ),
                            }
                        )
        if not streets_in_radius:
            return JSONResponse(
                content={
                    "status": "no_streets_in_radius",
                    "message": f"No undriven streets within {max_distance_miles} miles.",
                }
            )
        streets_in_radius.sort(key=lambda x: x["distance_to_start_miles"])
        selected_streets_for_route = streets_in_radius[
            :max_streets_to_optimize
        ]
        destination_points = [
            s_data["start_coords_lonlat"]
            for s_data in selected_streets_for_route
        ]
        if not destination_points:
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "No destination points from selected streets.",
                }
            )
        optimized_route_data = await _get_mapbox_optimization_route(
            user_lon, user_lat, end_points=destination_points
        )
        ordered_streets_info = []
        if "waypoints" in optimized_route_data:
            for wp in optimized_route_data["waypoints"]:
                if wp.get("waypoint_index") is not None and wp[
                    "waypoint_index"
                ] < len(selected_streets_for_route):
                    original_street_data = selected_streets_for_route[
                        wp["waypoint_index"]
                    ]
                    ordered_streets_info.append(
                        {
                            "properties": original_street_data["properties"],
                            "geometry": original_street_data["geometry"],
                            "distance_to_start_miles": round(
                                original_street_data[
                                    "distance_to_start_miles"
                                ],
                                2,
                            ),
                            "optimized_order_location": wp.get("location"),
                        }
                    )
        return JSONResponse(
            content={
                "status": "success",
                "message": f"Optimized route for {len(ordered_streets_info)} streets.",
                "route_geometry": optimized_route_data.get("geometry"),
                "route_duration_seconds": optimized_route_data.get("duration"),
                "route_distance_meters": optimized_route_data.get("distance"),
                "streets_in_optimized_order": ordered_streets_info,
                "user_location": {"lat": user_lat, "lon": user_lon},
            }
        )
    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(
            "Error creating optimized multi-street route: %s", e, exc_info=True
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to create optimized route: {e}"
        )
