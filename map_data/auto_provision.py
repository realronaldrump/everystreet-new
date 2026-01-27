"""
Automatic map data provisioning based on trip locations.

Provides hands-off map service configuration by:
1. Detecting which US states contain trip data
2. Automatically downloading and building map data for those states
3. Monitoring for new trips in unconfigured states
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
import os
from typing import Any

from db.aggregation import aggregate_to_list
from map_data.models import MapBuildProgress, MapServiceConfig
from map_data.us_states import get_state, list_states

logger = logging.getLogger(__name__)

# US State bounding boxes [min_lon, min_lat, max_lon, max_lat]
# These are approximate bounding boxes for quick point-in-state detection
US_STATE_BOUNDS: dict[str, tuple[float, float, float, float]] = {
    "AL": (-88.47, 30.22, -84.89, 35.01),
    "AK": (-179.15, 51.21, -129.98, 71.35),
    "AZ": (-114.81, 31.33, -109.05, 37.00),
    "AR": (-94.62, 33.00, -89.64, 36.50),
    "CA": (-124.41, 32.53, -114.13, 42.01),
    "CO": (-109.06, 36.99, -102.04, 41.00),
    "CT": (-73.73, 40.99, -71.79, 42.05),
    "DE": (-75.79, 38.45, -75.05, 39.84),
    "FL": (-87.63, 24.52, -80.03, 31.00),
    "GA": (-85.61, 30.36, -80.84, 35.00),
    "HI": (-160.24, 18.91, -154.81, 22.24),
    "ID": (-117.24, 41.99, -111.04, 49.00),
    "IL": (-91.51, 36.97, -87.50, 42.51),
    "IN": (-88.10, 37.77, -84.78, 41.76),
    "IA": (-96.64, 40.38, -90.14, 43.50),
    "KS": (-102.05, 36.99, -94.59, 40.00),
    "KY": (-89.57, 36.50, -81.96, 39.15),
    "LA": (-94.04, 28.93, -88.82, 33.02),
    "ME": (-71.08, 43.06, -66.95, 47.46),
    "MD": (-79.49, 37.91, -75.05, 39.72),
    "MA": (-73.51, 41.24, -69.93, 42.89),
    "MI": (-90.42, 41.70, -82.42, 48.19),
    "MN": (-97.24, 43.50, -89.49, 49.38),
    "MS": (-91.66, 30.17, -88.10, 35.00),
    "MO": (-95.77, 35.99, -89.10, 40.61),
    "MT": (-116.05, 44.36, -104.04, 49.00),
    "NE": (-104.05, 40.00, -95.31, 43.00),
    "NV": (-120.01, 35.00, -114.04, 42.00),
    "NH": (-72.56, 42.70, -70.71, 45.31),
    "NJ": (-75.56, 38.93, -73.89, 41.36),
    "NM": (-109.05, 31.33, -103.00, 37.00),
    "NY": (-79.76, 40.50, -71.86, 45.02),
    "NC": (-84.32, 33.84, -75.46, 36.59),
    "ND": (-104.05, 45.94, -96.55, 49.00),
    "OH": (-84.82, 38.40, -80.52, 42.00),
    "OK": (-103.00, 33.62, -94.43, 37.00),
    "OR": (-124.57, 41.99, -116.46, 46.29),
    "PA": (-80.52, 39.72, -74.69, 42.27),
    "RI": (-71.86, 41.15, -71.12, 42.02),
    "SC": (-83.35, 32.03, -78.54, 35.22),
    "SD": (-104.06, 42.48, -96.44, 45.95),
    "TN": (-90.31, 34.98, -81.65, 36.68),
    "TX": (-106.65, 25.84, -93.51, 36.50),
    "UT": (-114.05, 37.00, -109.04, 42.00),
    "VT": (-73.44, 42.73, -71.46, 45.02),
    "VA": (-83.68, 36.54, -75.24, 39.47),
    "WA": (-124.73, 45.54, -116.92, 49.00),
    "WV": (-82.64, 37.20, -77.72, 40.64),
    "WI": (-92.89, 42.49, -86.25, 47.08),
    "WY": (-111.05, 40.99, -104.05, 45.01),
}


def get_state_for_coordinate(lon: float, lat: float) -> str | None:
    """
    Determine which US state a coordinate falls within.

    Uses bounding box checks for fast approximate detection. Returns
    the first matching state code (e.g., 'CA') or None if not in any
    US state.
    """
    for state_code, (min_lon, min_lat, max_lon, max_lat) in US_STATE_BOUNDS.items():
        if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat:
            return state_code
    return None


def get_states_for_coordinate(lon: float, lat: float) -> set[str]:
    """
    Return all states whose bounding boxes include the coordinate.

    This is conservative (may include neighbor states near borders),
    but avoids missing coverage when bounding boxes overlap.
    """
    states: set[str] = set()
    for state_code, (min_lon, min_lat, max_lon, max_lat) in US_STATE_BOUNDS.items():
        if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat:
            states.add(state_code)
    return states


def get_states_for_coordinates(
    coordinates: list[tuple[float, float]],
) -> set[str]:
    """
    Get all US states that contain any of the given coordinates.

    Args:
        coordinates: List of (lon, lat) tuples

    Returns:
        Set of state codes (e.g., {'CA', 'NV', 'AZ'})
    """
    states = set()
    for lon, lat in coordinates:
        states.update(get_states_for_coordinate(lon, lat))
    return states


async def detect_trip_states() -> dict[str, Any]:
    """
    Detect which US states have trip data.

    Queries the trips collection and determines which states
    contain trip GPS data.

    Returns:
        Dictionary with detected states and trip counts
    """
    from db.models import Trip

    detected_states: dict[str, int] = {}
    sample_size = 0

    def _bump_state(lon: float, lat: float) -> None:
        for state in get_states_for_coordinate(lon, lat):
            detected_states[state] = detected_states.get(state, 0) + 1

    def _sample_gps_points(gps: dict[str, Any]) -> list[list[float]]:
        coords = gps.get("coordinates", [])
        geom_type = gps.get("type", "")
        if geom_type == "Point" and len(coords) >= 2:
            return [coords]
        if geom_type == "LineString" and coords:
            points = [coords[0]]
            if len(coords) > 2:
                points.append(coords[len(coords) // 2])
            if len(coords) > 1:
                points.append(coords[-1])
            return points
        return []

    sample_size_env = int(os.getenv("MAP_TRIP_STATE_SAMPLE_SIZE", "1000"))
    full_scan = os.getenv("MAP_COVERAGE_MODE", "trips").strip().lower() in {
        "trips",
        "auto",
    } or sample_size_env <= 0

    if full_scan:
        collection = Trip.get_pymongo_collection()
        cursor = collection.find(
            {"gps": {"$exists": True, "$ne": None}},
            {"gps": 1, "destinationGeoPoint": 1, "_id": 0},
        )
        async for trip_doc in cursor:
            gps = trip_doc.get("gps") or {}
            for point in _sample_gps_points(gps):
                if len(point) >= 2:
                    _bump_state(point[0], point[1])
                    sample_size += 1

            dest = trip_doc.get("destinationGeoPoint")
            if dest and "coordinates" in dest:
                coords = dest["coordinates"]
                if len(coords) >= 2:
                    _bump_state(coords[0], coords[1])
                    sample_size += 1
    else:
        # Get a sample of trips with GPS data
        pipeline = [
            {"$match": {"gps": {"$exists": True, "$ne": None}}},
            {"$sample": {"size": sample_size_env}},
            {"$project": {"gps": 1}},
        ]

        trip_results = await aggregate_to_list(Trip, pipeline)
        for trip_doc in trip_results:
            gps = trip_doc.get("gps") or {}
            for point in _sample_gps_points(gps):
                if len(point) >= 2:
                    _bump_state(point[0], point[1])
                    sample_size += 1

        # Also check distinct destination states from geocoded trips
        dest_pipeline = [
            {
                "$match": {
                    "destinationGeoPoint": {"$exists": True, "$ne": None},
                },
            },
            {"$sample": {"size": 500}},
            {"$project": {"destinationGeoPoint": 1}},
        ]

        dest_results = await aggregate_to_list(Trip, dest_pipeline)
        for trip_doc in dest_results:
            dest = trip_doc.get("destinationGeoPoint")
            if dest and "coordinates" in dest:
                coords = dest["coordinates"]
                if len(coords) >= 2:
                    _bump_state(coords[0], coords[1])
                    sample_size += 1

    # Sort by trip count (most trips first)
    sorted_states = sorted(
        detected_states.items(),
        key=lambda x: x[1],
        reverse=True,
    )

    state_details = []
    for code, count in sorted_states:
        state_info = get_state(code)
        if state_info:
            state_details.append(
                {
                    "code": code,
                    "name": state_info.get("name", code),
                    "trip_count": count,
                    "size_mb": state_info.get("size_mb", 0),
                },
            )

    return {
        "detected_states": [s["code"] for s in state_details],
        "state_details": state_details,
        "sample_size": sample_size,
        "detected_at": datetime.now(UTC).isoformat(),
    }


async def get_unconfigured_trip_states() -> list[str]:
    """
    Get states that have trips but are not yet configured for map services.

    Returns:
        List of state codes that need to be added to map coverage
    """
    config = await MapServiceConfig.get_or_create()
    configured = set(config.selected_states)

    detection = await detect_trip_states()
    detected = set(detection["detected_states"])

    return list(detected - configured)


async def should_auto_provision() -> dict[str, Any]:
    """
    Check if automatic map provisioning should be triggered.

    Returns:
        Dictionary with provisioning decision and details
    """
    config = await MapServiceConfig.get_or_create()
    await MapBuildProgress.get_or_create()

    # Don't provision if already in progress
    if config.status in {
        MapServiceConfig.STATUS_DOWNLOADING,
        MapServiceConfig.STATUS_BUILDING,
    }:
        return {
            "should_provision": False,
            "reason": "Build already in progress",
            "current_status": config.status,
        }

    # Get unconfigured states with trips
    unconfigured = await get_unconfigured_trip_states()

    if not unconfigured:
        return {
            "should_provision": False,
            "reason": "All trip states are configured",
            "configured_states": config.selected_states,
        }

    # Calculate what would be added
    new_states = list(set(config.selected_states) | set(unconfigured))

    total_size = 0
    for code in new_states:
        state_info = get_state(code)
        if state_info:
            total_size += int(state_info.get("size_mb", 0))

    return {
        "should_provision": True,
        "reason": f"Found {len(unconfigured)} new state(s) with trips",
        "current_states": config.selected_states,
        "new_states": unconfigured,
        "combined_states": new_states,
        "estimated_size_mb": total_size,
    }


async def auto_provision_map_data() -> dict[str, Any]:
    """
    Automatically provision map data for all states with trips.

    This is the main entry point for hands-off map configuration.
    It detects states from trip data and triggers the download/build
    pipeline if new states are found.

    Returns:
        Dictionary with provisioning result
    """
    from map_data.services import configure_map_services

    check = await should_auto_provision()

    if not check.get("should_provision"):
        return {
            "success": True,
            "action": "none",
            "reason": check.get("reason", "No provisioning needed"),
        }

    new_states = check.get("combined_states", [])
    if not new_states:
        return {
            "success": True,
            "action": "none",
            "reason": "No states to configure",
        }

    logger.info(
        "Auto-provisioning map data for states: %s",
        ", ".join(new_states),
    )

    try:
        result = await configure_map_services(new_states, force=False)
        return {
            "success": True,
            "action": "provisioning_started",
            "states": new_states,
            "result": result,
        }
    except RuntimeError as e:
        if "already in progress" in str(e).lower():
            return {
                "success": True,
                "action": "already_in_progress",
                "states": new_states,
            }
        raise


async def get_auto_provision_status() -> dict[str, Any]:
    """
    Get the current auto-provisioning status.

    Returns comprehensive status for the UI including:
    - Current configuration state
    - Detected trip states
    - Service health
    - Any pending provisioning needs
    """
    from map_data.services import (
        MAX_RETRIES,
        check_container_status,
        check_service_health,
    )

    config = await MapServiceConfig.get_or_create()
    progress = await MapBuildProgress.get_or_create()
    health = await check_service_health()
    nominatim_container = await check_container_status("nominatim")
    valhalla_container = await check_container_status("valhalla")
    detection = await detect_trip_states()

    configured_states = set(config.selected_states)
    detected_states = set(detection["detected_states"])
    missing_states = list(detected_states - configured_states)

    # Calculate sizes
    configured_size = 0
    missing_size = 0
    all_states = list_states()
    state_map = {s["code"]: s for s in all_states}

    for code in configured_states:
        if code in state_map:
            configured_size += int(state_map[code].get("size_mb", 0))

    for code in missing_states:
        if code in state_map:
            missing_size += int(state_map[code].get("size_mb", 0))

    # Get state names for display
    configured_names = []
    for code in sorted(configured_states):
        if code in state_map:
            configured_names.append(state_map[code].get("name", code))

    missing_details = []
    for code in sorted(missing_states):
        if code in state_map:
            missing_details.append(
                {
                    "code": code,
                    "name": state_map[code].get("name", code),
                    "size_mb": state_map[code].get("size_mb", 0),
                },
            )

    is_ready = (
        config.status == MapServiceConfig.STATUS_READY
        and health.nominatim_healthy
        and health.valhalla_healthy
    )

    is_building = config.status in {
        MapServiceConfig.STATUS_DOWNLOADING,
        MapServiceConfig.STATUS_BUILDING,
    }

    nominatim_progress = None
    if is_building and progress.phase == MapBuildProgress.PHASE_BUILDING_GEOCODER:
        container_name = (nominatim_container.get("container") or {}).get("name")
        nominatim_progress = await _get_nominatim_progress_snapshot(container_name)

    return {
        "mode": "automatic",
        "status": config.status,
        "is_ready": is_ready,
        "is_building": is_building,
        "progress": config.progress,
        "message": config.message,
        "build": {
            "phase": progress.phase,
            "phase_progress": progress.phase_progress,
            "total_progress": progress.total_progress,
            "started_at": (
                progress.started_at.isoformat() if progress.started_at else None
            ),
            "last_progress_at": (
                progress.last_progress_at.isoformat()
                if progress.last_progress_at
                else None
            ),
            "active_job_id": progress.active_job_id,
        },
        "geocoder_progress": nominatim_progress,
        "configured_states": list(configured_states),
        "configured_state_names": configured_names,
        "configured_size_mb": configured_size,
        "detected_states": list(detected_states),
        "missing_states": missing_states,
        "missing_state_details": missing_details,
        "missing_size_mb": missing_size,
        "needs_provisioning": len(missing_states) > 0 and not is_building,
        "services": {
            "geocoding": {
                "ready": health.nominatim_healthy,
                "has_data": health.nominatim_has_data,
                "error": health.nominatim_error,
                "container": nominatim_container.get("container"),
            },
            "routing": {
                "ready": health.valhalla_healthy,
                "has_data": health.valhalla_has_data,
                "error": health.valhalla_error,
                "container": valhalla_container.get("container"),
            },
        },
        "last_error": config.last_error,
        "retry_count": config.retry_count,
        "max_retries": MAX_RETRIES,
        "last_updated": (
            config.last_updated.isoformat() if config.last_updated else None
        ),
    }


async def _run_docker_psql(container_name: str, sql: str) -> str | None:
    if not container_name:
        return None
    cmd = [
        "docker",
        "exec",
        "-u",
        "postgres",
        container_name,
        "psql",
        "-d",
        "postgres",
        "-A",
        "-F",
        "|",
        "-tAc",
        sql,
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await process.communicate()
        if process.returncode != 0:
            return None
        return stdout.decode().strip()
    except Exception:
        return None


async def _get_nominatim_progress_snapshot(
    container_name: str | None,
) -> dict[str, Any] | None:
    if not container_name:
        return None

    size_output = await _run_docker_psql(
        container_name,
        "SELECT pg_database_size('nominatim');",
    )
    size_bytes = None
    if size_output and size_output.isdigit():
        size_bytes = int(size_output)

    activity_output = await _run_docker_psql(
        container_name,
        (
            "SELECT state, COALESCE(wait_event_type,''), COALESCE(wait_event,''), query "
            "FROM pg_stat_activity "
            "WHERE datname='nominatim' AND pid <> pg_backend_pid() "
            "ORDER BY (state='active') DESC, pid "
            "LIMIT 1;"
        ),
    )

    active_state = None
    wait_event_type = None
    wait_event = None
    active_query = None

    if activity_output:
        parts = activity_output.split("|", 3)
        if len(parts) >= 4:
            active_state = parts[0] or None
            wait_event_type = parts[1] or None
            wait_event = parts[2] or None
            active_query = " ".join(parts[3].split()) if parts[3] else None

    if size_bytes is None and not active_query:
        return None

    return {
        "db_size_bytes": size_bytes,
        "db_size_at": datetime.now(UTC).isoformat(),
        "active_state": active_state,
        "active_wait_event_type": wait_event_type,
        "active_wait_event": wait_event,
        "active_query": active_query,
    }
