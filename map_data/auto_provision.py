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
from typing import Any

from core.trip_source_policy import enforce_bouncie_source
from db.models import MapProvider
from map_data.extracts import build_local_osm_artifact_status
from map_data.models import MapServiceConfig
from map_data.progress import MapBuildProgress
from map_data.us_states import get_state, get_states_for_coordinate, list_states

logger = logging.getLogger(__name__)


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

    def _sample_gps_points(gps: dict[str, Any]) -> list[list[float]]:
        def sample_line(coords: Any) -> list[list[float]]:
            if not isinstance(coords, list) or not coords:
                return []
            points = [coords[0]]
            if len(coords) > 2:
                points.append(coords[len(coords) // 2])
            if len(coords) > 1:
                points.append(coords[-1])
            return points

        coords = gps.get("coordinates", [])
        geom_type = gps.get("type", "")
        if geom_type == "Point" and len(coords) >= 2:
            return [coords]
        if geom_type == "LineString":
            return sample_line(coords)
        if geom_type == "MultiLineString" and isinstance(coords, list):
            return [point for line in coords for point in sample_line(line)]
        return []

    collection = Trip.get_pymongo_collection()
    cursor = collection.find(
        enforce_bouncie_source({"gps": {"$exists": True, "$ne": None}}),
        {"gps": 1, "destinationGeoPoint": 1, "_id": 0},
    )
    async for trip_doc in cursor:
        trip_states: set[str] = set()
        gps = trip_doc.get("gps") or {}
        for point in _sample_gps_points(gps):
            if len(point) >= 2:
                trip_states.update(get_states_for_coordinate(point[0], point[1]))
                sample_size += 1

        dest = trip_doc.get("destinationGeoPoint")
        if dest and "coordinates" in dest:
            coords = dest["coordinates"]
            if len(coords) >= 2:
                trip_states.update(get_states_for_coordinate(coords[0], coords[1]))
                sample_size += 1

        for state in trip_states:
            detected_states[state] = detected_states.get(state, 0) + 1

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


async def should_auto_provision() -> dict[str, Any]:
    """
    Check if automatic map provisioning should be triggered.

    Returns:
        Dictionary with provisioning decision and details
    """
    from map_data.services import _get_map_provider_and_google_key

    config = await MapServiceConfig.get_or_create()
    await MapBuildProgress.get_or_create()
    map_provider, _google_key_ready = await _get_map_provider_and_google_key()

    if map_provider == MapProvider.GOOGLE.value:
        return {
            "should_provision": False,
            "reason": "Google Maps provider active; local provisioning is disabled.",
            "configured_states": config.selected_states,
        }

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

    if (
        config.status == MapServiceConfig.STATUS_NOT_CONFIGURED
        and config.selected_states
    ):
        total_size = 0
        for code in config.selected_states:
            state_info = get_state(code)
            if state_info:
                total_size += int(state_info.get("size_mb", 0))
        return {
            "should_provision": True,
            "reason": "Restarting cancelled setup",
            "current_states": config.selected_states,
            "new_states": [],
            "combined_states": list(config.selected_states),
            "estimated_size_mb": total_size,
        }

    detection = await detect_trip_states()
    detected = set(detection["detected_states"])
    if not detected:
        return {
            "should_provision": False,
            "reason": "No trips found yet",
            "configured_states": config.selected_states,
        }

    unconfigured = list(detected - set(config.selected_states))
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
    except RuntimeError as e:
        if "already in progress" in str(e).lower():
            return {
                "success": True,
                "action": "already_in_progress",
                "states": new_states,
            }
        raise
    else:
        return {
            "success": True,
            "action": "provisioning_started",
            "states": new_states,
            "result": result,
        }


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
        _get_map_provider_and_google_key,
        check_container_status,
        check_service_health,
    )

    config = await MapServiceConfig.get_or_create()
    progress = await MapBuildProgress.get_or_create()
    map_provider, google_key_ready = await _get_map_provider_and_google_key()

    configured_states = set(config.selected_states)
    all_states = list_states()
    state_map = {s["code"]: s for s in all_states}
    configured_size = 0
    for code in configured_states:
        if code in state_map:
            configured_size += int(state_map[code].get("size_mb", 0))
    configured_names = [
        state_map[code].get("name", code)
        for code in sorted(configured_states)
        if code in state_map
    ]

    if map_provider == MapProvider.GOOGLE.value:
        return {
            "mode": "google",
            "map_provider": map_provider,
            "status": "ready" if google_key_ready else "error",
            "is_ready": google_key_ready,
            "is_building": False,
            "progress": 100 if google_key_ready else 0,
            "message": (
                "Google Maps provider active. Local map provisioning is disabled."
                if google_key_ready
                else "Google Maps provider selected but API key is missing."
            ),
            "build": {
                "phase": MapBuildProgress.PHASE_IDLE,
                "phase_progress": 0.0,
                "total_progress": 0.0,
                "started_at": None,
                "last_progress_at": (
                    progress.last_progress_at.isoformat()
                    if progress.last_progress_at
                    else None
                ),
                "active_job_id": None,
            },
            "geocoder_progress": None,
            "configured_states": list(configured_states),
            "configured_state_names": configured_names,
            "configured_size_mb": configured_size,
            "detected_states": [],
            "missing_states": [],
            "missing_state_details": [],
            "missing_size_mb": 0,
            "needs_provisioning": False,
            "services": {
                "geocoding": {
                    "ready": google_key_ready,
                    "has_data": google_key_ready,
                    "error": None if google_key_ready else "Google API key missing",
                    "container": None,
                    "skipped": True,
                },
                "routing": {
                    "ready": google_key_ready,
                    "has_data": google_key_ready,
                    "error": None if google_key_ready else "Google API key missing",
                    "container": None,
                    "skipped": True,
                },
            },
            "last_error": config.last_error,
            "retry_count": config.retry_count,
            "max_retries": MAX_RETRIES,
            "last_updated": (
                config.last_updated.isoformat() if config.last_updated else None
            ),
        }

    health = await check_service_health()
    nominatim_container = await check_container_status("nominatim")
    valhalla_container = await check_container_status("valhalla")
    detection = await detect_trip_states()

    detected_states = set(detection["detected_states"])
    missing_states = list(detected_states - configured_states)

    # Calculate sizes
    missing_size = 0

    for code in missing_states:
        if code in state_map:
            missing_size += int(state_map[code].get("size_mb", 0))

    # Get state names for display
    missing_details = [
        {
            "code": code,
            "name": state_map[code].get("name", code),
            "size_mb": state_map[code].get("size_mb", 0),
        }
        for code in sorted(missing_states)
        if code in state_map
    ]

    is_ready = (
        config.status == MapServiceConfig.STATUS_READY
        and health.nominatim_healthy
        and health.valhalla_healthy
    )

    is_building = config.status in {
        MapServiceConfig.STATUS_DOWNLOADING,
        MapServiceConfig.STATUS_BUILDING,
    }

    no_trip_data = (
        not detected_states and not config.selected_states and not is_building
    )
    message = config.message
    if no_trip_data:
        message = "No trips found yet. Map data will build after trips are imported."

    nominatim_progress = None
    if is_building and progress.phase == MapBuildProgress.PHASE_BUILDING_GEOCODER:
        container_name = (nominatim_container.get("container") or {}).get("name")
        nominatim_progress = await _get_nominatim_progress_snapshot(container_name)

    local_osm = await build_local_osm_artifact_status(
        config=config,
        health=health,
        is_building=is_building,
    )

    return {
        "mode": "automatic",
        "status": config.status,
        "is_ready": is_ready,
        "is_building": is_building,
        "progress": config.progress,
        "message": message,
        "build": progress.to_build_payload(),
        "geocoder_progress": nominatim_progress,
        "configured_states": list(configured_states),
        "configured_state_names": configured_names,
        "configured_size_mb": configured_size,
        "detected_states": list(detected_states),
        "missing_states": missing_states,
        "missing_state_details": missing_details,
        "missing_size_mb": missing_size,
        "needs_provisioning": (
            (
                len(missing_states) > 0
                or (
                    config.selected_states
                    and config.status == MapServiceConfig.STATUS_NOT_CONFIGURED
                )
            )
            and not is_building
        ),
        "services": {
            "geocoding": {
                "ready": health.nominatim_healthy,
                "has_data": health.nominatim_has_data,
                "error": None if no_trip_data else health.nominatim_error,
                "container": nominatim_container.get("container"),
            },
            "routing": {
                "ready": health.valhalla_healthy,
                "has_data": health.valhalla_has_data,
                "error": None if no_trip_data else health.valhalla_error,
                "container": valhalla_container.get("container"),
            },
        },
        "local_osm": local_osm,
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
