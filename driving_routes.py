import asyncio
import json
import logging
import math
import os
import uuid
from collections import defaultdict, deque
from typing import Any, Dict, List

import geojson as geojson_module
import httpx
import numpy as np
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from sklearn.cluster import KMeans

# Use db_manager directly for collections to avoid import order issues
from db import (
    find_one_with_retry,
    streets_collection,
    trips_collection,
    db_manager,
)
from live_tracking import get_active_trip
from models import LocationModel
from utils import haversine

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
        "source": "first",  # Start from the first coordinate
        "destination": "last",  # Can be 'any' or 'last'. 'last' makes it a round trip if only one destination.
        # For multiple, it tries to end at the last one in the list if possible.
        "roundtrip": "false",  # Explicitly false unless we want it to return to start
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
            "waypoints": trip.get(
                "waypoints", []
            ),  # waypoints are in optimized order
        }


@router.post("/api/driving-navigation/next-route")
async def get_next_driving_route(
    request: Request,
):
    """Calculates the route from the user's current position to the
    start of the nearest undriven street segment in the specified area using Mapbox
    Optimization API v1 (effectively for a single destination).
    """
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Target location data is required",
            )

        location_data_from_request = data["location"]
        if not isinstance(location_data_from_request, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location data must be a valid object.",
            )

        location = LocationModel(**location_data_from_request)
        location_name = location.display_name

        if not location_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location display name is required.",
            )

        # segment_id is optional; if provided, route directly to this segment
        target_segment_id = data.get("segment_id")
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
        else:
            active_trip_response = await get_active_trip()
            active_trip_data = None
            if (
                hasattr(active_trip_response, "trip")
                and active_trip_response.trip
            ):
                active_trip_data = active_trip_response.trip

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
            else:
                last_trip = await find_one_with_retry(
                    trips_collection, {}, sort=[("endTime", -1)]
                )
                if not last_trip:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Current position not provided, live location unavailable, and no previous trips found.",
                    )
                gps_data = last_trip.get("gps")
                if isinstance(gps_data, str):
                    gps_data = geojson_module.loads(gps_data)
                geom = gps_data or last_trip.get("geometry")
                if (
                    geom
                    and geom.get("type") == "LineString"
                    and len(geom.get("coordinates", [])) > 0
                ):
                    last_coord = geom["coordinates"][-1]
                    current_lon = float(last_coord[0])
                    current_lat = float(last_coord[1])
                    location_source = "last-trip-end"
                elif (
                    geom
                    and geom.get("type") == "Point"
                    and len(geom.get("coordinates", [])) == 2
                ):
                    last_coord = geom["coordinates"]
                    current_lon = float(last_coord[0])
                    current_lat = float(last_coord[1])
                    location_source = "last-trip-end-point"
                else:
                    raise ValueError(
                        "Invalid or empty geometry/gps in last trip"
                    )
    except Exception as e:
        logger.error(
            "Error getting position for next-route: %s", e, exc_info=True
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not determine current position: {e}",
        )

    target_street_for_route = None
    if target_segment_id:
        target_street_for_route = await streets_collection.find_one(
            {
                "properties.segment_id": target_segment_id,
                "properties.location": location_name,
            },
            {
                "geometry.coordinates": 1,
                "properties": 1,  # Fetch all properties
                "_id": 0,
            },
        )
        if not target_street_for_route:
            raise HTTPException(
                status_code=404,
                detail=f"Target segment {target_segment_id} not found in {location_name}.",
            )

        undriven_streets = [
            target_street_for_route
        ]  # Route to this specific street
    else:
        # Fetch all undriven streets if no specific segment_id is provided
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry.type": "LineString",
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {
                "geometry.coordinates": 1,
                "properties": 1,  # Fetch all properties
                "_id": 0,
            },
        )
        undriven_streets = await undriven_streets_cursor.to_list(length=None)

    if not undriven_streets:
        return JSONResponse(
            content={
                "status": "completed",
                "message": f"No undriven streets found in {location_name} matching criteria.",
                "route_geometry": None,
                "target_street": None,
            },
        )

    try:
        # Prepare points for Mapbox Optimization API (even if it's just one destination)
        destinations_with_info = []
        for street in undriven_streets:
            geometry = street.get("geometry", {})
            props = street.get("properties", {})

            start_node_coords_from_prop = props.get(
                "start_coords"
            )  # Check if pre-calculated
            start_node_coords = None

            if (
                start_node_coords_from_prop
                and isinstance(start_node_coords_from_prop, (list, tuple))
                and len(start_node_coords_from_prop) == 2
            ):
                start_node_coords = start_node_coords_from_prop
            elif (
                geometry.get("type") == "LineString"
                and geometry.get("coordinates")
                and len(geometry["coordinates"]) > 0
            ):
                start_node_coords = geometry["coordinates"][0]

            if (
                start_node_coords
                and isinstance(start_node_coords, (list, tuple))
                and len(start_node_coords) >= 2
            ):
                try:
                    lon, lat = (
                        float(start_node_coords[0]),
                        float(start_node_coords[1]),
                    )
                    destinations_with_info.append(
                        {
                            "coord": (lon, lat),
                            "street_info": props,  # Store all properties
                        }
                    )
                except (ValueError, TypeError):
                    logger.warning(
                        f"Skipping street due to invalid start_node_coords: {start_node_coords} for seg: {props.get('segment_id')}"
                    )
            else:
                logger.warning(
                    f"Street {props.get('segment_id')} has no valid start coordinates."
                )

        if not destinations_with_info:
            return JSONResponse(
                content={
                    "status": "completed",
                    "message": f"No valid undriven streets with coordinates found in {location_name} for routing.",
                    "route_geometry": None,
                    "target_street": None,
                },
            )

        # If not routing to a specific segment, sort by distance to find the nearest ones for optimization
        if not target_segment_id:
            current_pos_tuple = (current_lon, current_lat)
            destinations_with_info.sort(
                key=lambda p: haversine(
                    current_pos_tuple[0],
                    current_pos_tuple[1],
                    p["coord"][0],
                    p["coord"][1],
                )
            )

        # Select destinations for API (max 11 for Optimization API)
        # If target_segment_id was provided, destinations_with_info will contain only that one.
        api_destinations = [p["coord"] for p in destinations_with_info[:11]]
        api_street_infos = [
            p["street_info"] for p in destinations_with_info[:11]
        ]

        if (
            not api_destinations
        ):  # Should not happen if destinations_with_info was populated
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "No API destinations prepared.",
                }
            )

        optimization_result = await _get_mapbox_optimization_route(
            current_lon, current_lat, end_points=api_destinations
        )

        route_geometry = optimization_result["geometry"]
        route_duration_seconds = optimization_result["duration"]
        route_distance_meters = optimization_result["distance"]
        optimized_waypoints = optimization_result.get("waypoints", [])

        final_target_street_info = None
        final_target_street_start_coords = None

        if optimized_waypoints and len(optimized_waypoints) > 1:
            # First destination in the optimized route
            first_dest_wp = optimized_waypoints[1]
            original_idx = first_dest_wp.get(
                "waypoint_index"
            )  # Index in api_destinations

            if original_idx is not None and 0 <= original_idx < len(
                api_street_infos
            ):
                final_target_street_info = api_street_infos[original_idx]
                final_target_street_start_coords = api_destinations[
                    original_idx
                ]
            else:  # Fallback if waypoint_index is strange
                logger.warning(
                    f"Could not map optimized waypoint_index {original_idx}. Falling back to first API destination."
                )
                if api_street_infos:
                    final_target_street_info = api_street_infos[0]
                    final_target_street_start_coords = api_destinations[0]
        elif api_street_infos:  # Only one destination was sent, or optimization failed to return waypoints
            final_target_street_info = api_street_infos[0]
            final_target_street_start_coords = api_destinations[0]

        if final_target_street_info and final_target_street_start_coords:
            # Ensure 'start_coords' is in the properties for frontend consistency
            if (
                "start_coords" not in final_target_street_info
                or not final_target_street_info.get("start_coords")
            ):
                final_target_street_info["start_coords"] = list(
                    final_target_street_start_coords
                )

        return JSONResponse(
            content={
                "status": "success",
                "message": "Route calculated.",
                "route_geometry": route_geometry,
                "target_street": final_target_street_info,
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
    max_points_per_cluster: int = 11,  # Max destinations for Mapbox Optimization API (excluding start)
) -> list[list[dict]]:
    """Cluster segments into groups based on geographic proximity using KMeans."""
    if not segments:
        return []

    # Extract start_node coordinates for clustering
    # Ensure start_node is a tuple (lon, lat)
    segment_coords_for_clustering = []
    valid_segments_for_output = []  # Keep track of segments that have valid start_node

    for seg in segments:
        geom = seg.get("geometry", {})
        if (
            geom.get("type") == "LineString"
            and geom.get("coordinates")
            and len(geom["coordinates"]) > 0
        ):
            try:
                lon, lat = (
                    float(geom["coordinates"][0][0]),
                    float(geom["coordinates"][0][1]),
                )
                seg["start_node"] = (
                    lon,
                    lat,
                )  # Add/overwrite start_node for consistency
                segment_coords_for_clustering.append((lon, lat))
                valid_segments_for_output.append(seg)
            except (TypeError, ValueError, IndexError):
                logger.warning(
                    f"Segment {seg.get('properties', {}).get('segment_id')} has invalid start coordinates, skipping for clustering."
                )
        else:
            logger.warning(
                f"Segment {seg.get('properties', {}).get('segment_id')} has invalid geometry, skipping for clustering."
            )

    if not segment_coords_for_clustering:
        logger.warning(
            "No valid coordinates found in segments for clustering."
        )
        return []  # No valid segments to cluster

    coords_np = np.array(segment_coords_for_clustering)

    if coords_np.shape[0] <= max_points_per_cluster:
        # If fewer segments than max per cluster, just return them as a single cluster
        return [valid_segments_for_output] if valid_segments_for_output else []

    # Determine number of clusters
    # Ensure n_clusters is at least 1 and not more than the number of points
    n_clusters = min(
        max(1, coords_np.shape[0] // max_points_per_cluster),
        coords_np.shape[0],
    )

    try:
        kmeans = KMeans(
            n_clusters=n_clusters, random_state=0, n_init="auto"
        ).fit(coords_np)
    except ValueError as e:
        logger.warning(
            f"KMeans clustering failed: {e}. Falling back to chunking."
        )
        # Fallback: simple chunking if KMeans fails
        return [
            valid_segments_for_output[i : i + max_points_per_cluster]
            for i in range(
                0, len(valid_segments_for_output), max_points_per_cluster
            )
        ]

    labels = kmeans.labels_
    clustered_segments_dict = defaultdict(list)
    for i, label in enumerate(labels):
        clustered_segments_dict[label].append(valid_segments_for_output[i])

    # Further split large clusters if any exceed max_points_per_cluster
    final_clusters = []
    for cluster_label, segments_in_cluster in clustered_segments_dict.items():
        if len(segments_in_cluster) > max_points_per_cluster:
            # Sort by distance to cluster centroid before splitting? Or just chunk?
            # For simplicity, just chunking for now.
            for i in range(
                0, len(segments_in_cluster), max_points_per_cluster
            ):
                final_clusters.append(
                    segments_in_cluster[i : i + max_points_per_cluster]
                )
        elif segments_in_cluster:  # Ensure not empty
            final_clusters.append(segments_in_cluster)

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

        # Destinations for this cluster are the start_nodes of its segments
        cluster_destinations = [
            seg["start_node"]
            for seg in cluster_segments
            if seg.get("start_node")
        ]
        if not cluster_destinations:
            logger.warning(
                f"Cluster {i} has no valid destinations (start_nodes), skipping."
            )
            continue

        try:
            # Optimize within the cluster, starting from current_lon, current_lat
            cluster_opt_result = await _get_mapbox_optimization_route(
                current_lon, current_lat, end_points=cluster_destinations
            )

            if cluster_opt_result and cluster_opt_result.get("geometry"):
                all_geometries.append(cluster_opt_result["geometry"])
                total_duration += cluster_opt_result.get("duration", 0)
                total_distance += cluster_opt_result.get("distance", 0)

                # Update current_lon, current_lat to the end of this optimized cluster trip
                optimized_waypoints = cluster_opt_result.get("waypoints", [])
                if optimized_waypoints:
                    # The last waypoint in the optimized trip for *this cluster*
                    # Mapbox waypoints are [lon, lat]
                    last_waypoint_coords = optimized_waypoints[-1].get(
                        "location"
                    )
                    if last_waypoint_coords and len(last_waypoint_coords) == 2:
                        current_lon, current_lat = (
                            last_waypoint_coords[0],
                            last_waypoint_coords[1],
                        )
                    else:  # Fallback if location is missing in waypoint
                        logger.warning(
                            f"Waypoint for cluster {i} missing location, using geometry end."
                        )
                        if cluster_opt_result["geometry"].get("coordinates"):
                            last_coord_in_cluster_route = cluster_opt_result[
                                "geometry"
                            ]["coordinates"][-1]
                            current_lon, current_lat = (
                                last_coord_in_cluster_route[0],
                                last_coord_in_cluster_route[1],
                            )
                elif cluster_opt_result["geometry"].get(
                    "coordinates"
                ):  # Fallback if no waypoints
                    last_coord_in_cluster_route = cluster_opt_result[
                        "geometry"
                    ]["coordinates"][-1]
                    current_lon, current_lat = (
                        last_coord_in_cluster_route[0],
                        last_coord_in_cluster_route[1],
                    )

            # If not the last cluster, get directions to the start of the *next* cluster
            if i < len(clusters) - 1:
                next_cluster_segments = clusters[i + 1]
                if next_cluster_segments and next_cluster_segments[0].get(
                    "start_node"
                ):
                    next_cluster_start_lon, next_cluster_start_lat = (
                        next_cluster_segments[0]["start_node"]
                    )
                    try:
                        # Get directions from the *end* of the current cluster's route
                        # to the *start* of the next cluster's first segment
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

                            # Update current_lon, current_lat to the start of the next cluster
                            # This will be the starting point for the next _get_mapbox_optimization_route call
                            current_lon, current_lat = (
                                next_cluster_start_lon,
                                next_cluster_start_lat,
                            )

                    except HTTPException as e_dir:
                        logger.warning(
                            f"Could not get directions between cluster {i} and {i + 1}: {e_dir.detail}"
                        )

            await asyncio.sleep(0.2)  # Rate limiting for Mapbox APIs

        except HTTPException as e_opt:
            logger.warning(
                f"Optimization for cluster {i} failed: {e_opt.detail}. Skipping cluster."
            )
            continue
        except Exception as e_gen:
            logger.error(
                f"General error processing cluster {i}: {e_gen}", exc_info=True
            )
            continue

    combined_geometry = {
        "type": "GeometryCollection",
        "geometries": [
            g for g in all_geometries if g
        ],  # Filter out any None geometries
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

        location_data_from_request = data["location"]
        if not isinstance(location_data_from_request, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location data must be a valid object.",
            )
        location = LocationModel(**location_data_from_request)
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
            active_trip_response = await get_active_trip()
            active_trip_data = None
            if (
                hasattr(active_trip_response, "trip")
                and active_trip_response.trip
            ):
                active_trip_data = active_trip_response.trip

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
                geom = gps_data or last_trip.get("geometry")
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
                elif (
                    geom
                    and geom.get("type") == "Point"
                    and len(geom.get("coordinates", [])) == 2
                ):
                    last_coord_pair = geom["coordinates"]
                    current_lon, current_lat = (
                        float(last_coord_pair[0]),
                        float(last_coord_pair[1]),
                    )
                    location_source = "last-trip-end-point"
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
                "geometry.type": "LineString",  # Ensure only LineStrings
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {  # Projection
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

        # The _cluster_segments function will pre-process and add 'start_node'
        clusters = await _cluster_segments(
            undriven_streets_list, max_points_per_cluster=11
        )

        if not clusters:
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "Failed to cluster segments or no valid segments found.",
                }
            )

        logger.info(
            f"Coverage Route: Clustered {len(undriven_streets_list)} segments into {len(clusters)} clusters for {location_name}."
        )

        optimization_result = await _optimize_route_for_clusters(
            start_point, clusters
        )

        segments_covered_in_route = sum(
            len(c) for c in clusters
        )  # Count segments actually included in optimization
        message = f"Coverage route for {segments_covered_in_route} segments in {len(clusters)} clusters."

        logger.info(
            f"Coverage Route: Generated route for {location_name}. Segments: {segments_covered_in_route}, Duration: {optimization_result['duration']:.1f}s, Distance: {optimization_result['distance']:.1f}m"
        )
        return JSONResponse(
            content={
                "status": "success",
                "message": message,
                "route_geometry": optimization_result["geometry"],
                "total_duration_seconds": optimization_result["duration"],
                "total_distance_meters": optimization_result["distance"],
                "location_source": location_source,
                "clusters_count": len(
                    clusters
                ),  # Add cluster count for frontend
                "segments_in_route_count": segments_covered_in_route,  # Add segment count for frontend
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

        location_data_from_request = data["location"]
        if not isinstance(location_data_from_request, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location data must be a valid object.",
            )
        location_model = LocationModel(**location_data_from_request)
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
                "geometry.type": "LineString",
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
                if coords and len(coords) > 0 and len(coords[0]) >= 2:
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

        location_data_from_request = data["location"]
        if not isinstance(location_data_from_request, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location data must be a valid object.",
            )
        location_model = LocationModel(**location_data_from_request)
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
                "geometry.type": "LineString",
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
                if coords and len(coords) > 0 and len(coords[0]) >= 2:
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
            # Mapbox waypoints: first is origin, subsequent are destinations in optimized order.
            # waypoint_index refers to the index in the *input* destination_points list.
            # We skip the first waypoint as it's the origin.
            for wp in optimized_route_data["waypoints"][
                1:
            ]:  # Start from the first destination
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
                            "optimized_order_location": wp.get(
                                "location"
                            ),  # [lon, lat]
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


async def find_connected_undriven_clusters(
    streets: List[Dict[str, Any]],
    max_distance_between_segments: float = 0.05,  # 50 meters in km
) -> List[Dict[str, Any]]:
    """Find clusters of connected undriven street segments.

    Two segments are considered connected if their endpoints are within max_distance_between_segments.
    """
    if not streets:
        return []

    adjacency = defaultdict(set)
    segment_data_map = {}  # Store full street data by segment_id

    valid_segments_for_graph = []
    for i, street in enumerate(streets):
        props = street.get("properties", {})
        segment_id = props.get("segment_id")
        if (
            not segment_id
        ):  # Generate a temp ID if missing, though segment_id should exist
            segment_id = f"temp_id_{i}_{uuid.uuid4().hex[:6]}"
            props["segment_id"] = segment_id  # Add it back for consistency
            street["properties"] = props

        geom = street.get("geometry", {})

        if geom.get("type") == "LineString" and geom.get("coordinates"):
            coords = geom["coordinates"]
            if len(coords) >= 2:
                try:
                    start_point = tuple(map(float, coords[0]))
                    end_point = tuple(map(float, coords[-1]))
                    segment_data_map[segment_id] = {
                        "original_doc": street,
                        "start_point": start_point,
                        "end_point": end_point,
                    }
                    valid_segments_for_graph.append(segment_id)
                except (TypeError, ValueError, IndexError) as coord_err:
                    logger.debug(
                        f"Segment {segment_id} has invalid coordinate format {coords[0]} or {coords[-1]}: {coord_err}, skipping for graph."
                    )
            else:
                logger.debug(
                    f"Segment {segment_id} has insufficient coordinates ({len(coords)}), skipping for graph."
                )
        else:
            logger.debug(
                f"Segment {segment_id} has invalid geometry type '{geom.get('type')}' or no coordinates, skipping for graph."
            )

    for i, seg_id1 in enumerate(valid_segments_for_graph):
        data1 = segment_data_map[seg_id1]
        for j in range(i + 1, len(valid_segments_for_graph)):
            seg_id2 = valid_segments_for_graph[j]
            data2 = segment_data_map[seg_id2]

            distances = [
                haversine(
                    data1["start_point"][0],
                    data1["start_point"][1],
                    data2["start_point"][0],
                    data2["start_point"][1],
                    unit="km",
                ),
                haversine(
                    data1["start_point"][0],
                    data1["start_point"][1],
                    data2["end_point"][0],
                    data2["end_point"][1],
                    unit="km",
                ),
                haversine(
                    data1["end_point"][0],
                    data1["end_point"][1],
                    data2["start_point"][0],
                    data2["start_point"][1],
                    unit="km",
                ),
                haversine(
                    data1["end_point"][0],
                    data1["end_point"][1],
                    data2["end_point"][0],
                    data2["end_point"][1],
                    unit="km",
                ),
            ]

            if min(distances) <= max_distance_between_segments:
                adjacency[seg_id1].add(seg_id2)
                adjacency[seg_id2].add(seg_id1)

    visited_bfs = set()
    clusters = []

    for seg_id_start_node in valid_segments_for_graph:
        if seg_id_start_node not in visited_bfs:
            cluster_segment_ids_bfs = []
            queue = deque([seg_id_start_node])
            visited_bfs.add(seg_id_start_node)

            current_cluster_all_coords_bfs = []

            while queue:
                current_seg_id_bfs = queue.popleft()
                cluster_segment_ids_bfs.append(current_seg_id_bfs)

                geom_bfs = segment_data_map[current_seg_id_bfs][
                    "original_doc"
                ].get("geometry", {})
                if geom_bfs.get("coordinates"):
                    current_cluster_all_coords_bfs.extend(
                        geom_bfs["coordinates"]
                    )

                for neighbor_seg_id_bfs in adjacency[current_seg_id_bfs]:
                    if neighbor_seg_id_bfs not in visited_bfs:
                        visited_bfs.add(neighbor_seg_id_bfs)
                        queue.append(neighbor_seg_id_bfs)

            if not cluster_segment_ids_bfs:
                continue

            total_length_bfs = sum(
                segment_data_map[sid]["original_doc"]
                .get("properties", {})
                .get("segment_length", 0)
                for sid in cluster_segment_ids_bfs
            )

            centroid_lon_bfs, centroid_lat_bfs = 0.0, 0.0
            compactness_bfs = 0.1  # Default low compactness

            if current_cluster_all_coords_bfs:
                num_coords = len(current_cluster_all_coords_bfs)
                if num_coords > 0:
                    centroid_lon_bfs = (
                        sum(c[0] for c in current_cluster_all_coords_bfs)
                        / num_coords
                    )
                    centroid_lat_bfs = (
                        sum(c[1] for c in current_cluster_all_coords_bfs)
                        / num_coords
                    )

                    distances_from_centroid_bfs = [
                        haversine(
                            centroid_lon_bfs,
                            centroid_lat_bfs,
                            c[0],
                            c[1],
                            unit="km",
                        )
                        for c in current_cluster_all_coords_bfs
                    ]
                    if distances_from_centroid_bfs:
                        avg_distance_from_centroid_bfs = sum(
                            distances_from_centroid_bfs
                        ) / len(distances_from_centroid_bfs)
                        compactness_bfs = (
                            1.0 / (1.0 + avg_distance_from_centroid_bfs)
                            if avg_distance_from_centroid_bfs >= 0
                            else 0.1
                        )

            clusters.append(
                {
                    "segment_ids": cluster_segment_ids_bfs,
                    "segments": [
                        segment_data_map[sid]["original_doc"]
                        for sid in cluster_segment_ids_bfs
                    ],
                    "total_length": total_length_bfs,
                    "segment_count": len(cluster_segment_ids_bfs),
                    "centroid": [centroid_lon_bfs, centroid_lat_bfs],
                    "compactness": compactness_bfs,
                }
            )

    return clusters


@router.get("/api/driving-navigation/suggest-next-street/{location_id}")
async def suggest_next_efficient_street(
    location_id: str,
    current_lat: float = Query(..., description="Current latitude"),
    current_lon: float = Query(..., description="Current longitude"),
    top_n: int = Query(
        3, description="Number of top clusters to return", ge=1, le=10
    ),
    min_cluster_size: int = Query(
        1, description="Minimum segments in a cluster", ge=1
    ),
):
    """Suggest the most efficient undriven street clusters."""
    logger.info(
        f"Finding efficient undriven clusters for location {location_id} from ({current_lat}, {current_lon})"
    )

    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(
            status_code=400, detail="Invalid location_id format"
        )

    coverage_doc = await find_one_with_retry(
        db_manager.db["coverage_metadata"],
        {"_id": obj_location_id},
        {"location.display_name": 1},
    )

    if not coverage_doc or not coverage_doc.get("location", {}).get(
        "display_name"
    ):
        raise HTTPException(
            status_code=404,
            detail=f"Coverage area with ID '{location_id}' not found",
        )

    location_name = coverage_doc["location"]["display_name"]

    undriven_streets_cursor = streets_collection.find(
        {
            "properties.location": location_name,
            "properties.driven": False,
            "properties.undriveable": {"$ne": True},
            "geometry.type": "LineString",
            "geometry.coordinates": {"$exists": True, "$not": {"$size": 0}},
        },
        {
            "properties.segment_id": 1,
            "properties.street_name": 1,
            "properties.segment_length": 1,
            "geometry": 1,
            "_id": 0,
        },
    )
    undriven_streets = await undriven_streets_cursor.to_list(length=None)

    if not undriven_streets:
        return JSONResponse(
            content={
                "status": "no_streets",
                "message": f"No undriven streets found in {location_name}",
                "suggested_clusters": [],
            }
        )

    clusters = await find_connected_undriven_clusters(undriven_streets)
    viable_clusters = [
        c for c in clusters if c["segment_count"] >= min_cluster_size
    ]

    if not viable_clusters:  # Fallback if no clusters meet min_cluster_size (especially if min_cluster_size > 1)
        logger.info(
            f"No clusters of size >= {min_cluster_size} found. Considering individual segments as clusters."
        )
        viable_clusters = []
        for street in undriven_streets:  # Create "clusters" of size 1
            geom = street.get("geometry", {})
            props = street.get("properties", {})
            seg_id = props.get("segment_id")
            if (
                geom.get("type") == "LineString"
                and geom.get("coordinates")
                and len(geom["coordinates"]) > 0
                and seg_id
            ):
                viable_clusters.append(
                    {
                        "segments": [street],
                        "segment_ids": [seg_id],
                        "total_length": props.get("segment_length", 0),
                        "segment_count": 1,
                        "centroid": geom["coordinates"][0],
                        "compactness": 1.0,
                    }
                )

    scored_clusters = []
    current_pos = (current_lon, current_lat)

    for cluster in viable_clusters:
        if (
            not cluster.get("centroid")
            or not isinstance(cluster["centroid"], list)
            or len(cluster["centroid"]) != 2
        ):
            logger.warning(
                f"Cluster missing valid centroid, skipping: {cluster.get('segment_ids')}"
            )
            continue

        distance_km = haversine(
            current_pos[0],
            current_pos[1],
            cluster["centroid"][0],
            cluster["centroid"][1],
            unit="km",
        )

        score = (
            (cluster.get("total_length", 0) / 1000.0)
            * math.log(cluster.get("segment_count", 0) + 1)
            * cluster.get("compactness", 0.1)  # Use default if missing
        ) / (distance_km + 0.1)

        nearest_segment_in_cluster = None
        min_dist_to_segment_start = float("inf")

        for segment in cluster.get("segments", []):
            geom = segment.get("geometry", {})
            if (
                geom.get("type") == "LineString"
                and geom.get("coordinates")
                and len(geom["coordinates"]) > 0
            ):
                start_point = geom["coordinates"][0]
                if isinstance(start_point, list) and len(start_point) == 2:
                    dist = haversine(
                        current_pos[0],
                        current_pos[1],
                        start_point[0],
                        start_point[1],
                        unit="km",
                    )
                    if dist < min_dist_to_segment_start:
                        min_dist_to_segment_start = dist
                        nearest_segment_in_cluster = segment

        if nearest_segment_in_cluster:
            nearest_props = nearest_segment_in_cluster.get("properties", {})
            nearest_geom = nearest_segment_in_cluster.get("geometry", {})
            start_coords = (
                nearest_geom.get("coordinates", [[0, 0]])[0]
                if nearest_geom.get("coordinates")
                else [0, 0]
            )

            scored_clusters.append(
                {
                    "cluster_id": str(uuid.uuid4()),
                    "segment_count": cluster["segment_count"],
                    "total_length_m": cluster["total_length"],
                    "distance_to_cluster_m": distance_km * 1000,
                    "compactness": cluster["compactness"],
                    "efficiency_score": score,
                    "centroid": cluster["centroid"],
                    "nearest_segment": {
                        "segment_id": nearest_props.get("segment_id"),
                        "street_name": nearest_props.get(
                            "street_name", "Unnamed Street"
                        ),
                        "start_coords": start_coords,
                    },
                    "segments": [
                        {
                            "segment_id": seg.get("properties", {}).get(
                                "segment_id"
                            ),
                            "street_name": seg.get("properties", {}).get(
                                "street_name", "Unnamed"
                            ),
                            "geometry": seg.get("geometry"),
                            "segment_length": seg.get("properties", {}).get(
                                "segment_length", 0
                            ),
                        }
                        for seg in cluster.get("segments", [])
                    ],
                }
            )

    if not scored_clusters:
        return JSONResponse(
            content={
                "status": "no_clusters",
                "message": "No viable street clusters found after scoring.",
                "suggested_clusters": [],
            }
        )

    scored_clusters.sort(key=lambda x: x["efficiency_score"], reverse=True)
    top_clusters = scored_clusters[:top_n]

    logger.info(
        f"Top {len(top_clusters)} efficient clusters for {location_name}: "
        f"{[(c['segment_count'], round(c['efficiency_score'], 2)) for c in top_clusters]}"
    )

    return JSONResponse(
        content={
            "status": "success",
            "message": f"Found {len(top_clusters)} efficient street clusters",
            "location_name": location_name,
            "current_position": {"lat": current_lat, "lon": current_lon},
            "suggested_clusters": top_clusters,
            "total_undriven_streets": len(undriven_streets),
            "total_clusters_found": len(clusters),
        }
    )
