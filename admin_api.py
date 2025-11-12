import asyncio
import logging
import subprocess
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, status

from db import (
    db_manager,
    delete_many_with_retry,
    find_one_with_retry,
    insert_one_with_retry,
    serialize_datetime,
    update_one_with_retry,
)
from models import CollectionModel, LocationModel, ValidateLocationModel
from osm_utils import generate_geojson_osm
from update_geo_points import update_geo_points
from utils import validate_location_osm

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()

# Collections
trips_collection = db_manager.db["trips"]
app_settings_collection = db_manager.db["app_settings"]

# Default settings if none stored
DEFAULT_APP_SETTINGS: dict[str, Any] = {
    "_id": "default",
    "highlightRecentTrips": True,
    "autoCenter": True,
    "showLiveTracking": True,
    "polylineColor": "#00FF00",
    "polylineOpacity": 0.8,
    "geocodeTripsOnFetch": True,
}


async def get_persisted_app_settings() -> dict[str, Any]:
    """Retrieve persisted application settings (creates defaults if missing)."""

    try:
        doc = await find_one_with_retry(app_settings_collection, {"_id": "default"})
        if doc is None:
            # Initialise defaults
            await insert_one_with_retry(app_settings_collection, DEFAULT_APP_SETTINGS)
            doc = DEFAULT_APP_SETTINGS.copy()
        return doc
    except Exception as e:
        logger.exception("Error fetching app settings: %s", e)
        # Fallback to defaults on error
        return DEFAULT_APP_SETTINGS.copy()


@router.get(
    "/api/app_settings",
    response_model=dict,
    summary="Get Application Settings",
    description="Retrieve persisted application-wide settings.",
)
async def get_app_settings_endpoint():
    try:
        doc = await get_persisted_app_settings()
        # Remove Mongo _id for response clarity
        doc.pop("_id", None)
        return doc
    except Exception as e:
        logger.exception("Error fetching app settings via API: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve application settings.",
        )


@router.post(
    "/api/app_settings",
    response_model=dict,
    summary="Update Application Settings",
    description="Persist application settings. Fields omitted in the payload remain unchanged.",
)
async def update_app_settings_endpoint(settings: dict = Body(...)):
    try:
        if not isinstance(settings, dict):
            raise HTTPException(status_code=400, detail="Invalid payload")

        # Upsert merge into single document with _id = default
        await update_one_with_retry(
            app_settings_collection,
            {"_id": "default"},
            {"$set": settings},
            upsert=True,
        )

        updated_settings = await get_persisted_app_settings()
        return updated_settings
    except Exception as e:
        logger.exception("Error updating app settings via API: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update application settings.",
        )


@router.post("/api/database/clear-collection")
async def clear_collection(data: CollectionModel):
    """Clear all documents from a collection."""
    try:
        name = data.collection
        if not name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing 'collection' field",
            )

        result = await delete_many_with_retry(db_manager.db[name], {})

        return {
            "message": f"Successfully cleared collection {name}",
            "deleted_count": result.deleted_count,
        }

    except Exception as e:
        logger.exception(
            "Error clearing collection: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/database/storage-info")
async def get_storage_info():
    """Get database storage usage information."""
    try:
        stats = await db_manager.db.command("dbStats")
        data_size = stats.get("dataSize", 0)
        used_mb = round(data_size / (1024 * 1024), 2)

        return {
            "used_mb": used_mb,
        }
    except Exception as e:
        logger.exception(
            "Error getting storage info: %s",
            str(e),
        )
        return {
            "used_mb": 0,
            "error": str(e),
        }


@router.post("/update_geo_points")
async def update_geo_points_route(
    collection_name: str,
):
    """Update geo points for all trips in a collection."""
    if collection_name != "trips":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid collection name. Only 'trips' is supported.",
        )

    collection = trips_collection

    try:
        await update_geo_points(collection)
        return {"message": f"GeoPoints updated for {collection_name}"}
    except Exception as e:
        logger.exception(
            "Error in update_geo_points_route: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error updating GeoPoints: {e}",
        )


@router.post("/api/validate_location")
async def validate_location(
    data: ValidateLocationModel,
):
    """Validate a location using OpenStreetMap."""
    try:
        # Hard timeout to ensure we never leave the client hanging
        validated = await asyncio.wait_for(
            validate_location_osm(
                data.location,
                data.locationType,
            ),
            timeout=12.0,
        )
    except TimeoutError as exc:
        logger.warning(
            "Location validation timed out for location=%s type=%s",
            data.location,
            data.locationType,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Validation timed out. Please try again.",
        ) from exc
    except Exception as exc:
        logger.exception("Location validation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to validate location at this time.",
        ) from exc

    if not validated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location not found.",
        )

    return validated


@router.post("/api/generate_geojson")
async def generate_geojson_endpoint(
    location: LocationModel,
    streets_only: bool = False,
):
    """Generate GeoJSON for a location using the imported function."""
    geojson_data, err = await generate_geojson_osm(
        location.dict(),
        streets_only,
    )
    if geojson_data:
        return geojson_data
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=err or "Unknown error",
    )


@router.get("/api/last_trip_point")
async def get_last_trip_point():
    """Get coordinates of the last point in the most recent trip."""
    try:
        most_recent = await find_one_with_retry(
            trips_collection,
            {},
            sort=[("endTime", -1)],
        )

        if not most_recent:
            return {"lastPoint": None}

        gps_data = most_recent["gps"]

        if "coordinates" not in gps_data or not gps_data["coordinates"]:
            return {"lastPoint": None}

        return {"lastPoint": gps_data["coordinates"][-1]}
    except Exception as e:
        logger.exception(
            "Error get_last_trip_point: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve last trip point",
        )


@router.get("/api/first_trip_date")
async def get_first_trip_date():
    """Get the date of the earliest trip in the database."""
    try:
        earliest_trip = await find_one_with_retry(
            trips_collection,
            {},
            sort=[("startTime", 1)],
        )

        if not earliest_trip or not earliest_trip.get("startTime"):
            now = datetime.now(UTC)
            return {"first_trip_date": now.isoformat()}

        earliest_trip_date = earliest_trip["startTime"]
        if earliest_trip_date.tzinfo is None:
            earliest_trip_date = earliest_trip_date.replace(
                tzinfo=UTC,
            )

        return {
            "first_trip_date": serialize_datetime(
                earliest_trip_date,
            ),
        }
    except Exception as e:
        logger.exception(
            "get_first_trip_date error: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/logs")
async def get_logs(
    service: str = Query(..., description="Service name: web, worker, beat, or system"),
    lines: int = Query(100, description="Number of log lines to retrieve", ge=1, le=1000),
    follow: bool = Query(False, description="Stream logs in real-time (not implemented yet)")
):
    """
    Retrieve logs from Docker containers or system logs.

    Available services:
    - web: FastAPI web application logs
    - worker: Celery worker logs
    - beat: Celery beat scheduler logs
    - system: System-level logs (journalctl)
    """
    try:
        # Map service names to possible Docker container names
        container_map = {
            "web": ["everystreet-new_web_1", "everystreet-new-web-1", "web"],
            "worker": ["everystreet-new_worker_1", "everystreet-new-worker-1", "worker"],
            "beat": ["everystreet-new_beat_1", "everystreet-new-beat-1", "beat"],
        }

        if service in container_map:
            # Get Docker container logs - try multiple possible container names
            container_names = container_map[service]
            container_name = None

            # Try each possible container name
            for name in container_names:
                check_cmd = ["docker", "ps", "-a", "--filter", f"name={name}", "--format", "{{.Names}}"]
                check_result = subprocess.run(check_cmd, capture_output=True, text=True, timeout=10)

                if name in check_result.stdout.strip():
                    container_name = name
                    break

            if not container_name:
                # List all available containers for debugging
                all_cmd = ["docker", "ps", "-a", "--format", "{{.Names}}"]
                all_result = subprocess.run(all_cmd, capture_output=True, text=True, timeout=10)
                available = all_result.stdout.strip().split('\n') if all_result.stdout.strip() else []
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Container not found. Tried: {', '.join(container_names)}. Available containers: {', '.join(available)}"
                )

            cmd = ["docker", "logs", "--tail", str(lines), container_name]

        elif service == "system":
            # Get system logs using journalctl
            cmd = ["journalctl", "--since", "today", "--no-pager", "-n", str(lines)]
        else:
            # List available services
            available_services = list(container_map.keys()) + ["system"]

            # Get running containers for reference
            ps_cmd = ["docker", "ps", "--format", "{{.Names}}"]
            ps_result = subprocess.run(ps_cmd, capture_output=True, text=True, timeout=10)

            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid service '{service}'. Available services: {', '.join(available_services)}. Running containers: {ps_result.stdout.strip()}"
            )

        # Execute the log command
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30  # 30 second timeout
        )

        if result.returncode != 0:
            logger.error("Log retrieval failed: %s", result.stderr)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to retrieve logs: {result.stderr}"
            )

        # Split logs into lines and return as structured response
        log_lines = result.stdout.strip().split('\n') if result.stdout.strip() else []

        return {
            "service": service,
            "lines_requested": lines,
            "lines_returned": len(log_lines),
            "logs": log_lines,
            "timestamp": datetime.now(UTC).isoformat()
        }

    except subprocess.TimeoutExpired:
        logger.error("Log retrieval timed out for service: %s", service)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Log retrieval timed out"
        )
    except subprocess.CalledProcessError as e:
        logger.error("Log retrieval command failed: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Command execution failed: {str(e)}"
        )
    except Exception as e:
        logger.exception("Unexpected error retrieving logs: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected error: {str(e)}"
        )


@router.get("/api/logs/services")
async def get_available_log_services():
    """Get list of available log services and their status."""
    try:
        services_status = {}

        # Check Docker containers
        container_map = {
            "web": ["everystreet-new_web_1", "everystreet-new-web-1", "web"],
            "worker": ["everystreet-new_worker_1", "everystreet-new-worker-1", "worker"],
            "beat": ["everystreet-new_beat_1", "everystreet-new-beat-1", "beat"],
        }

        # First, try to get all containers to see what's actually available
        try:
            all_containers_cmd = ["docker", "ps", "-a", "--format", "{{.Names}}"]
            all_containers_result = subprocess.run(all_containers_cmd, capture_output=True, text=True, timeout=5)
            available_containers = all_containers_result.stdout.strip().split('\n') if all_containers_result.stdout.strip() else []
            logger.info(f"Available Docker containers: {available_containers}")
        except Exception as e:
            logger.warning(f"Could not list Docker containers: {e}")
            available_containers = []

        for service_name, container_names in container_map.items():
            try:
                # Try each possible container name
                found_container = None
                status_text = ""

                for container_name in container_names:
                    check_all_cmd = ["docker", "ps", "-a", "--filter", f"name={container_name}", "--format", "{{.Status}}"]
                    check_all_result = subprocess.run(check_all_cmd, capture_output=True, text=True, timeout=5)

                    if check_all_result.returncode == 0 and check_all_result.stdout.strip():
                        # Container exists - we can get logs from it
                        found_container = container_name
                        status_text = check_all_result.stdout.strip()
                        break

                if found_container:
                    services_status[service_name] = {
                        "available": True,
                        "status": status_text,
                        "container": found_container
                    }
                else:
                    services_status[service_name] = {
                        "available": False,
                        "status": "Container not found",
                        "container": container_names[0]  # Use first name as example
                    }
            except Exception as e:
                logger.error(f"Error checking container {service_name}: {e}")
                services_status[service_name] = {
                    "available": False,
                    "status": f"Error checking status: {str(e)}",
                    "container": container_names[0]
                }

        # Check system logs availability
        try:
            journal_cmd = ["journalctl", "--version"]
            journal_result = subprocess.run(journal_cmd, capture_output=True, text=True, timeout=5)
            services_status["system"] = {
                "available": journal_result.returncode == 0,
                "status": "Available" if journal_result.returncode == 0 else "Not available"
            }
        except Exception:
            services_status["system"] = {
                "available": False,
                "status": "journalctl not available"
            }

        return {
            "services": services_status,
            "timestamp": datetime.now(UTC).isoformat()
        }

    except Exception as e:
        logger.exception("Error getting services status: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get services status: {str(e)}"
        )
