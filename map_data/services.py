"""
Map data management services.

Provides core business logic for:
- Service health checks (Nominatim, Valhalla)
- Geofabrik region catalog browsing
- Region download and build orchestration
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from datetime import UTC, datetime
from typing import Any

import httpx

from config import get_geofabrik_mirror, get_nominatim_base_url, get_valhalla_base_url
from map_data.models import GeoServiceHealth, MapDataJob, MapRegion

logger = logging.getLogger(__name__)

# Cache for Geofabrik index (refreshed every hour)
_geofabrik_cache: dict[str, Any] = {"data": None, "timestamp": 0}
GEOFABRIK_CACHE_TTL = 3600  # 1 hour


async def check_container_status(service_name: str) -> dict[str, Any]:
    """Check if a docker compose service container is running."""
    try:
        result = subprocess.run(
            [
                "docker",
                "compose",
                "ps",
                "--format",
                "json",
                service_name,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception as exc:
        logger.warning("Failed to check container status for %s: %s", service_name, exc)
        return {"running": False, "status": "unknown"}

    if result.returncode != 0:
        status_text = (result.stderr or "").strip() or "unknown"
        logger.warning("docker compose ps failed for %s: %s", service_name, status_text)
        return {"running": False, "status": status_text}

    output = (result.stdout or "").strip()
    if not output:
        return {"running": False, "status": "not running"}

    entry: dict[str, Any] | None = None
    try:
        parsed = json.loads(output)
        if isinstance(parsed, list):
            entry = parsed[0] if parsed else None
        elif isinstance(parsed, dict):
            entry = parsed
    except json.JSONDecodeError:
        for line in output.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                break
            except json.JSONDecodeError:
                continue

    if not entry:
        return {"running": False, "status": "unknown"}

    status_text = str(entry.get("Status") or entry.get("State") or "unknown")
    state_text = status_text.lower()
    running = "running" in state_text or state_text.startswith("up")
    return {"running": running, "status": status_text}


async def check_service_health(force_refresh: bool = False) -> GeoServiceHealth:
    """
    Check health of Nominatim and Valhalla services.

    Args:
        force_refresh: If True, always perform fresh health checks

    Returns:
        GeoServiceHealth document with current status
    """
    health = await GeoServiceHealth.get_or_create()

    # Check if we need to refresh (within last 30 seconds unless forced)
    if not force_refresh and health.last_updated:
        age = (datetime.now(UTC) - health.last_updated).total_seconds()
        if age < 30:
            return health

    # Check Nominatim
    nominatim_container = await check_container_status("nominatim")
    health.nominatim_container_running = bool(nominatim_container.get("running"))
    nominatim_url = get_nominatim_base_url()
    try:
        if not health.nominatim_container_running:
            health.nominatim_healthy = False
            health.nominatim_has_data = False
            health.nominatim_error = "Container stopped"
            health.nominatim_last_check = datetime.now(UTC)
            health.nominatim_response_time_ms = None
            health.nominatim_version = None
        else:
            start = time.monotonic()
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{nominatim_url}/status")
            elapsed = (time.monotonic() - start) * 1000

            health.nominatim_has_data = response.status_code == 200
            health.nominatim_healthy = health.nominatim_has_data
            health.nominatim_response_time_ms = elapsed
            health.nominatim_last_check = datetime.now(UTC)
            health.nominatim_error = None

            if response.status_code == 200:
                try:
                    text = response.text
                    if "Nominatim" in text:
                        health.nominatim_version = text.strip()
                except Exception:
                    pass
            else:
                health.nominatim_error = "Waiting for data import"
    except Exception as e:
        health.nominatim_healthy = False
        health.nominatim_has_data = False
        health.nominatim_last_check = datetime.now(UTC)
        health.nominatim_response_time_ms = None
        health.nominatim_version = None
        error_str = str(e).lower()
        if "connection refused" in error_str:
            health.nominatim_error = "Container running, service starting up"
        elif "timed out" in error_str or "timeout" in error_str:
            health.nominatim_error = "Service not responding"
        else:
            health.nominatim_error = str(e)

    # Check Valhalla
    valhalla_container = await check_container_status("valhalla")
    health.valhalla_container_running = bool(valhalla_container.get("running"))
    valhalla_url = get_valhalla_base_url()
    try:
        if not health.valhalla_container_running:
            health.valhalla_healthy = False
            health.valhalla_has_data = False
            health.valhalla_error = "Container stopped"
            health.valhalla_last_check = datetime.now(UTC)
            health.valhalla_response_time_ms = None
            health.valhalla_version = None
            health.valhalla_tile_count = None
        else:
            start = time.monotonic()
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{valhalla_url}/status")
            elapsed = (time.monotonic() - start) * 1000

            health.valhalla_response_time_ms = elapsed
            health.valhalla_last_check = datetime.now(UTC)
            health.valhalla_error = None
            health.valhalla_has_data = False

            if response.status_code == 200:
                try:
                    data = response.json()
                    if isinstance(data, dict):
                        health.valhalla_version = data.get("version")
                        health.valhalla_tile_count = data.get("tileset", {}).get(
                            "tile_count",
                        )
                        health.valhalla_has_data = bool(
                            (health.valhalla_tile_count or 0) > 0,
                        )
                except Exception:
                    pass

            health.valhalla_healthy = (
                response.status_code == 200 and health.valhalla_has_data
            )
            if response.status_code != 200:
                health.valhalla_error = "Service unavailable"
            elif not health.valhalla_has_data:
                health.valhalla_error = "Waiting for routing tiles"
    except Exception as e:
        health.valhalla_healthy = False
        health.valhalla_has_data = False
        health.valhalla_last_check = datetime.now(UTC)
        health.valhalla_response_time_ms = None
        health.valhalla_version = None
        health.valhalla_tile_count = None
        error_str = str(e).lower()
        if "connection refused" in error_str:
            health.valhalla_error = "Container running, service starting up"
        elif "timed out" in error_str or "timeout" in error_str:
            health.valhalla_error = "Service not responding"
        else:
            health.valhalla_error = str(e)

    health.last_updated = datetime.now(UTC)
    await health.save()

    return health


async def get_geofabrik_regions(parent: str | None = None) -> list[dict[str, Any]]:
    """
    Get available regions from Geofabrik.

    Parses the Geofabrik index to provide a hierarchical view of available
    OSM extracts.

    Args:
        parent: Parent region path (e.g., "north-america" or "north-america/us")
                If None, returns top-level continents

    Returns:
        List of region dictionaries with id, name, type, size, etc.
    """
    global _geofabrik_cache

    # Check cache
    now = time.time()
    if (
        _geofabrik_cache["data"]
        and (now - _geofabrik_cache["timestamp"]) < GEOFABRIK_CACHE_TTL
    ):
        index = _geofabrik_cache["data"]
    else:
        # Fetch fresh index
        index = await _fetch_geofabrik_index()
        _geofabrik_cache = {"data": index, "timestamp": now}

    # Filter by parent
    if parent:
        # Normalize parent path
        parent = parent.strip("/").lower()
        return [r for r in index if r.get("parent", "").lower() == parent]
    # Return top-level regions (continents)
    return [r for r in index if not r.get("parent")]


async def suggest_region_from_first_trip() -> dict[str, Any] | None:
    """
    Suggest a Geofabrik region based on the first available trip.

    Uses the first trip with usable GPS data and finds the smallest
    Geofabrik region whose bounding box contains that coordinate.
    """
    from db.models import Trip

    trip = await Trip.find({"gps": {"$ne": None}}).sort("startTime").first_or_none()
    if not trip:
        return None

    coordinate = _extract_trip_coordinate(trip)
    if not coordinate:
        return None

    await get_geofabrik_regions()
    all_regions = _geofabrik_cache.get("data", []) or []

    lon, lat = coordinate
    candidates = [
        region
        for region in all_regions
        if _bbox_contains(region.get("bounding_box"), lon, lat)
    ]

    if not candidates:
        return None

    candidates.sort(key=lambda region: _bbox_area(region.get("bounding_box")))
    selected = candidates[0]

    return {
        "id": selected.get("id"),
        "name": selected.get("name") or selected.get("id"),
        "pbf_size_mb": _normalize_pbf_size(selected.get("pbf_size_mb")),
        "pbf_url": selected.get("pbf_url"),
        "bounding_box": _normalize_bbox(selected.get("bounding_box")),
    }


async def _fetch_geofabrik_index() -> list[dict[str, Any]]:
    """
    Fetch and parse the Geofabrik index.

    Returns a flat list of all regions with their metadata.
    """
    mirror = get_geofabrik_mirror()
    regions = []

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Fetch the main index page
            response = await client.get(f"{mirror}/index-v1.json")
            if response.status_code != 200:
                # Fall back to parsing HTML
                return await _parse_geofabrik_html(client, mirror)

            data = response.json()

            # The JSON index has a list of features
            for feature in data.get("features", []):
                props = feature.get("properties", {})
                urls = props.get("urls", {})

                region_id = props.get("id", "")
                parent = props.get("parent", "")

                # Extract bounding box from geometry
                bbox = []
                geometry = feature.get("geometry", {})
                if geometry.get("type") == "Polygon":
                    coords = geometry.get("coordinates", [[]])[0]
                    if coords:
                        lons = [c[0] for c in coords]
                        lats = [c[1] for c in coords]
                        bbox = [min(lons), min(lats), max(lons), max(lats)]

                region = {
                    "id": region_id,
                    "name": props.get("name", region_id),
                    "parent": parent,
                    "iso3166_1": props.get("iso3166-1:alpha2"),
                    "iso3166_2": props.get("iso3166-2"),
                    "type": "region" if parent else "continent",
                    "pbf_url": urls.get("pbf"),
                    "pbf_size_mb": _bytes_to_mb(urls.get("pbf_size", 0)),
                    "last_modified": props.get("modified"),
                    "bounding_box": bbox,
                    "has_children": bool(props.get("has_children", False)),
                }
                regions.append(region)

    except Exception:
        logger.exception("Failed to fetch Geofabrik index")
        # Return empty list on error - UI will show error state

    return regions


async def _parse_geofabrik_html(
    client: httpx.AsyncClient,
    mirror: str,
) -> list[dict[str, Any]]:
    """
    Fallback: Parse Geofabrik HTML pages if JSON index is not available.

    This is slower but works with any Geofabrik mirror.
    """
    regions = []

    try:
        # Fetch main page
        response = await client.get(mirror)
        if response.status_code != 200:
            return regions

        # Parse continent links
        html = response.text
        continent_pattern = r'href="([a-z-]+)/"[^>]*>([^<]+)</a>'
        for match in re.finditer(continent_pattern, html, re.IGNORECASE):
            continent_id = match.group(1)
            continent_name = match.group(2).strip()

            if continent_id in ["technical", "index", ".."]:
                continue

            regions.append(
                {
                    "id": continent_id,
                    "name": continent_name,
                    "parent": "",
                    "type": "continent",
                    "has_children": True,
                },
            )

    except Exception:
        logger.exception("Failed to parse Geofabrik HTML")

    return regions


def _bytes_to_mb(bytes_val: int | None) -> float | None:
    """Convert bytes to megabytes."""
    if bytes_val is None or bytes_val == 0:
        return None
    return round(bytes_val / (1024 * 1024), 2)


def _normalize_pbf_size(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _normalize_bbox(value: Any) -> list[float]:
    if isinstance(value, list | tuple) and len(value) == 4:
        try:
            return [float(item) for item in value]
        except (TypeError, ValueError):
            return []
    if isinstance(value, str):
        parts = [part for part in re.split(r"[\s,]+", value.strip()) if part]
        if len(parts) == 4:
            try:
                return [float(part) for part in parts]
            except ValueError:
                return []
    return []


def _bbox_contains(bbox: list[float] | None, lon: float, lat: float) -> bool:
    if not bbox or len(bbox) != 4:
        return False
    min_lon, min_lat, max_lon, max_lat = bbox
    return min_lon <= lon <= max_lon and min_lat <= lat <= max_lat


def _bbox_area(bbox: list[float] | None) -> float:
    if not bbox or len(bbox) != 4:
        return float("inf")
    min_lon, min_lat, max_lon, max_lat = bbox
    return abs(max_lon - min_lon) * abs(max_lat - min_lat)


def _extract_trip_coordinate(trip: Any) -> tuple[float, float] | None:
    gps_candidates = [getattr(trip, "matchedGps", None), getattr(trip, "gps", None)]
    for gps in gps_candidates:
        if not isinstance(gps, dict):
            continue
        coords = gps.get("coordinates")
        if not coords:
            continue
        if gps.get("type") == "Point":
            return _normalize_coordinate(coords)
        if gps.get("type") == "LineString" and isinstance(coords, list) and coords:
            return _normalize_coordinate(coords[0])

    coords_list = getattr(trip, "coordinates", None)
    if isinstance(coords_list, list) and coords_list:
        return _normalize_coordinate(coords_list[0])

    return None


def _normalize_coordinate(value: Any) -> tuple[float, float] | None:
    if isinstance(value, list | tuple) and len(value) >= 2:
        try:
            lon = float(value[0])
            lat = float(value[1])
            return lon, lat
        except (TypeError, ValueError):
            return None

    if isinstance(value, dict):
        lon = value.get("lon") or value.get("lng") or value.get("longitude")
        lat = value.get("lat") or value.get("latitude")
        try:
            if lon is None or lat is None:
                return None
            return float(lon), float(lat)
        except (TypeError, ValueError):
            return None

    return None


async def download_region(
    geofabrik_id: str,
    display_name: str | None = None,
) -> MapDataJob:
    """
    Start downloading a region from Geofabrik.

    Creates the MapRegion record and MapDataJob, then triggers the
    background download task.

    Args:
        geofabrik_id: Geofabrik region ID (e.g., "north-america/us/texas")
        display_name: Human-readable name (optional, derived from ID if not provided)

    Returns:
        The created MapDataJob for tracking progress
    """
    # Get region info from cache
    await get_geofabrik_regions()
    region_info = None

    # Search through all regions (need to search recursively)
    # For now, search the flat list
    all_regions = _geofabrik_cache.get("data", [])
    for r in all_regions:
        if r.get("id") == geofabrik_id:
            region_info = r
            break

    if not region_info:
        # Region not found in cache, construct basic info
        mirror = get_geofabrik_mirror()
        region_info = {
            "id": geofabrik_id,
            "name": display_name
            or geofabrik_id.split("/")[-1].replace("-", " ").title(),
            "pbf_url": f"{mirror}/{geofabrik_id}-latest.osm.pbf",
        }

    # Create or update MapRegion
    existing = await MapRegion.find_one({"name": geofabrik_id})
    if existing:
        region = existing
        region.status = MapRegion.STATUS_DOWNLOADING
        region.download_progress = 0.0
        region.last_error = None
    else:
        size_mb: float | None = _normalize_pbf_size(region_info.get("pbf_size_mb"))
        bbox: list[float] = _normalize_bbox(region_info.get("bounding_box"))
        region = MapRegion(
            name=geofabrik_id,
            display_name=display_name or region_info.get("name", geofabrik_id),
            source="geofabrik",
            source_url=region_info.get("pbf_url"),
            source_size_mb=size_mb,
            status=MapRegion.STATUS_DOWNLOADING,
            bounding_box=bbox,
        )
        await region.insert()

    region.updated_at = datetime.now(UTC)
    await region.save()

    # Create job
    job = MapDataJob(
        job_type=MapDataJob.JOB_DOWNLOAD,
        region_id=region.id,
        status=MapDataJob.STATUS_PENDING,
        stage="Queued for download",
        message=f"Preparing to download {region.display_name}",
    )
    await job.insert()

    # Enqueue background task
    from tasks.map_data import enqueue_download_task

    await enqueue_download_task(str(job.id))

    return job


async def download_and_build_all(
    geofabrik_id: str,
    display_name: str | None = None,
) -> MapDataJob:
    """
    Download a region and automatically build both Nominatim and Valhalla.

    This is a convenience function that chains:
    1. Download the OSM PBF file
    2. Import into Nominatim
    3. Build Valhalla routing tiles

    Args:
        geofabrik_id: Geofabrik region ID (e.g., "north-america/us/texas")
        display_name: Optional display name for the region

    Returns:
        The created MapDataJob for tracking progress
    """
    # Get region info from Geofabrik
    mirror = get_geofabrik_mirror()
    regions = await get_geofabrik_regions()
    region_info = None
    for r in regions:
        if r.get("id") == geofabrik_id:
            region_info = r
            break

    if not region_info:
        # Check nested regions
        parts = geofabrik_id.split("/")
        for i in range(len(parts)):
            parent = "/".join(parts[:i]) or None
            children = await get_geofabrik_regions(parent=parent)
            for child in children:
                if child.get("id") == geofabrik_id:
                    region_info = child
                    break
            if region_info:
                break

    if not region_info:
        # Create basic region info
        region_info = {
            "id": geofabrik_id,
            "name": display_name
            or geofabrik_id.split("/")[-1].replace("-", " ").title(),
            "pbf_url": f"{mirror}/{geofabrik_id}-latest.osm.pbf",
        }

    # Create or update MapRegion
    existing = await MapRegion.find_one({"name": geofabrik_id})
    if existing:
        region = existing
        region.status = MapRegion.STATUS_DOWNLOADING
        region.download_progress = 0.0
        region.nominatim_status = "not_built"
        region.valhalla_status = "not_built"
        region.last_error = None
    else:
        size_mb: float | None = _normalize_pbf_size(region_info.get("pbf_size_mb"))
        bbox: list[float] = _normalize_bbox(region_info.get("bounding_box"))
        region = MapRegion(
            name=geofabrik_id,
            display_name=display_name or region_info.get("name", geofabrik_id),
            source="geofabrik",
            source_url=region_info.get("pbf_url"),
            source_size_mb=size_mb,
            status=MapRegion.STATUS_DOWNLOADING,
            bounding_box=bbox,
        )
        await region.insert()

    region.updated_at = datetime.now(UTC)
    await region.save()

    # Create a special "download + build all" job
    # We use a new job type to indicate the full pipeline
    job = MapDataJob(
        job_type="download_and_build_all",  # Special type for full pipeline
        region_id=region.id,
        status=MapDataJob.STATUS_PENDING,
        stage="Queued for download and build",
        message=f"Preparing to download and build {region.display_name}",
    )
    await job.insert()

    # Enqueue background task with build_after flag
    from tasks.map_data import enqueue_download_task

    await enqueue_download_task(str(job.id), build_after=True)

    return job


async def build_nominatim(
    region_id: str,
    then_build_valhalla: bool = False,
) -> MapDataJob:
    """
    Start building Nominatim data for a downloaded region.

    Args:
        region_id: MapRegion document ID
        then_build_valhalla: If True, automatically build Valhalla after Nominatim

    Returns:
        The created MapDataJob for tracking progress
    """
    from beanie import PydanticObjectId

    region = await MapRegion.get(PydanticObjectId(region_id))
    if not region:
        msg = f"Region not found: {region_id}"
        raise ValueError(msg)

    if region.status not in (MapRegion.STATUS_DOWNLOADED, MapRegion.STATUS_READY):
        msg = f"Region must be downloaded first. Current status: {region.status}"
        raise ValueError(
            msg,
        )

    # Update region status
    region.nominatim_status = "building"
    region.status = MapRegion.STATUS_BUILDING_NOMINATIM
    region.updated_at = datetime.now(UTC)
    await region.save()

    # Create job
    job_type = (
        MapDataJob.JOB_BUILD_ALL
        if then_build_valhalla
        else MapDataJob.JOB_BUILD_NOMINATIM
    )
    job = MapDataJob(
        job_type=job_type,
        region_id=region.id,
        status=MapDataJob.STATUS_PENDING,
        stage="Queued for Nominatim build",
        message=f"Preparing to build Nominatim for {region.display_name}",
    )
    await job.insert()

    # Enqueue background task
    from tasks.map_data import enqueue_nominatim_build_task

    await enqueue_nominatim_build_task(str(job.id))

    return job


async def build_valhalla(region_id: str) -> MapDataJob:
    """
    Start building Valhalla tiles for a downloaded region.

    Args:
        region_id: MapRegion document ID

    Returns:
        The created MapDataJob for tracking progress
    """
    from beanie import PydanticObjectId

    region = await MapRegion.get(PydanticObjectId(region_id))
    if not region:
        msg = f"Region not found: {region_id}"
        raise ValueError(msg)

    if region.status not in (
        MapRegion.STATUS_DOWNLOADED,
        MapRegion.STATUS_READY,
        MapRegion.STATUS_BUILDING_NOMINATIM,
    ):
        msg = f"Region must be downloaded first. Current status: {region.status}"
        raise ValueError(
            msg,
        )

    # Update region status
    region.valhalla_status = "building"
    region.status = MapRegion.STATUS_BUILDING_VALHALLA
    region.updated_at = datetime.now(UTC)
    await region.save()

    # Create job
    job = MapDataJob(
        job_type=MapDataJob.JOB_BUILD_VALHALLA,
        region_id=region.id,
        status=MapDataJob.STATUS_PENDING,
        stage="Queued for Valhalla build",
        message=f"Preparing to build Valhalla tiles for {region.display_name}",
    )
    await job.insert()

    # Enqueue background task
    from tasks.map_data import enqueue_valhalla_build_task

    await enqueue_valhalla_build_task(str(job.id))

    return job


async def delete_region(region_id: str) -> None:
    """
    Delete a region and its associated data.

    Args:
        region_id: MapRegion document ID
    """
    import os

    from beanie import PydanticObjectId

    from config import get_osm_extracts_path

    region = await MapRegion.get(PydanticObjectId(region_id))
    if not region:
        msg = f"Region not found: {region_id}"
        raise ValueError(msg)

    # Check for active jobs
    active_job = await MapDataJob.find_one(
        {
            "region_id": region.id,
            "status": {"$in": [MapDataJob.STATUS_PENDING, MapDataJob.STATUS_RUNNING]},
        },
    )
    if active_job:
        msg = "Cannot delete region with active jobs. Cancel the job first."
        raise ValueError(msg)

    # Delete PBF file if it exists
    if region.pbf_path:
        extracts_path = get_osm_extracts_path()
        full_path = os.path.join(extracts_path, region.pbf_path)
        if os.path.exists(full_path):
            try:
                os.remove(full_path)
                logger.info("Deleted PBF file: %s", full_path)
            except Exception as e:
                logger.warning("Failed to delete PBF file %s: %s", full_path, e)

    # Delete associated jobs
    await MapDataJob.find({"region_id": region.id}).delete()

    # Delete region document
    await region.delete()

    logger.info("Deleted region: %s", region.display_name)


async def cancel_job(job_id: str) -> MapDataJob:
    """
    Cancel a pending or running job.

    Args:
        job_id: MapDataJob document ID

    Returns:
        The updated MapDataJob
    """
    from beanie import PydanticObjectId

    job = await MapDataJob.get(PydanticObjectId(job_id))
    if not job:
        msg = f"Job not found: {job_id}"
        raise ValueError(msg)

    if job.status in (
        MapDataJob.STATUS_COMPLETED,
        MapDataJob.STATUS_FAILED,
        MapDataJob.STATUS_CANCELLED,
    ):
        msg = f"Cannot cancel job with status: {job.status}"
        raise ValueError(msg)

    job.status = MapDataJob.STATUS_CANCELLED
    job.stage = "Cancelled by user"
    job.completed_at = datetime.now(UTC)
    await job.save()

    # Update region status if needed
    if job.region_id:
        region = await MapRegion.get(job.region_id)
        if region:
            if job.job_type == MapDataJob.JOB_DOWNLOAD:
                region.status = MapRegion.STATUS_NOT_DOWNLOADED
            elif job.job_type == MapDataJob.JOB_BUILD_NOMINATIM:
                region.nominatim_status = "not_built"
                region.status = MapRegion.STATUS_DOWNLOADED
            elif job.job_type == MapDataJob.JOB_BUILD_VALHALLA:
                region.valhalla_status = "not_built"
                region.status = MapRegion.STATUS_DOWNLOADED
            region.updated_at = datetime.now(UTC)
            await region.save()

    return job
