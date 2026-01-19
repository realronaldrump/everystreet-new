import asyncio
import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, status

from core.http.geocoding import validate_location_osm
from date_utils import ensure_utc
from db.models import (
    AppSettings,
    GasFillup,
    MatchedTrip,
    OptimalRouteProgress,
    OsmData,
    Place,
    ProgressStatus,
    ServerLog,
    Street,
    TaskConfig,
    TaskHistory,
    Trip,
    Vehicle,
)
from db.schemas import CollectionModel, ValidateLocationModel

# Map collection names to Beanie Document models for admin operations
COLLECTION_TO_MODEL = {
    "trips": Trip,
    "matched_trips": MatchedTrip,
    "streets": Street,
    "osm_data": OsmData,
    "places": Place,
    "task_config": TaskConfig,
    "task_history": TaskHistory,
    "progress_status": ProgressStatus,
    "optimal_route_progress": OptimalRouteProgress,
    "gas_fillups": GasFillup,
    "vehicles": Vehicle,
    "server_logs": ServerLog,
}


logger = logging.getLogger(__name__)
router = APIRouter()

MAPBOX_SETTINGS_ERROR = (
    "mapbox_access_token is no longer configurable via app settings. "
    "Set MAPBOX_TOKEN in the environment for map rendering only."
)


DEFAULT_APP_SETTINGS: dict[str, Any] = {
    # UI Preferences
    "highlightRecentTrips": True,
    "autoCenter": True,
    "showLiveTracking": True,
    "polylineColor": "#00FF00",
    "polylineOpacity": 0.8,
    "geocodeTripsOnFetch": True,
    "mapMatchTripsOnFetch": False,
    # Geo Service Configuration (defaults for Docker Compose)
    "mapbox_token": None,
    "nominatim_base_url": "http://nominatim:8080",
    "nominatim_user_agent": "EveryStreet/1.0",
    "valhalla_base_url": "http://valhalla:8002",
    "geofabrik_mirror": "https://download.geofabrik.de",
    "osm_extracts_path": "/osm",
}


async def get_persisted_app_settings() -> AppSettings:
    try:
        settings = await AppSettings.find_one()
        if settings is None:
            settings = AppSettings(**DEFAULT_APP_SETTINGS)
            await settings.insert()
    except Exception:
        logger.exception("Error fetching app settings")
        return AppSettings(**DEFAULT_APP_SETTINGS)
    else:
        return settings


@router.get(
    "/api/app_settings",
    response_model=AppSettings,
    response_model_exclude={"id"},
    summary="Get Application Settings",
    description="Retrieve persisted application-wide settings.",
)
async def get_app_settings_endpoint():
    try:
        settings = await get_persisted_app_settings()
        payload = settings.model_dump()
        payload.pop("mapbox_access_token", None)
    except Exception:
        logger.exception("Error fetching app settings via API")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve application settings.",
        )
    else:
        return payload


@router.post(
    "/api/app_settings",
    response_model=AppSettings,
    response_model_exclude={"id"},
    summary="Update Application Settings",
    description="Persist application settings. Fields omitted in payload remain unchanged.",
)
async def update_app_settings_endpoint(settings: Annotated[dict, Body()]):
    if not isinstance(settings, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")
    # Block the old deprecated field name
    if "mapbox_access_token" in settings:
        raise HTTPException(
            status_code=400,
            detail=MAPBOX_SETTINGS_ERROR,
        )

    try:
        existing = await AppSettings.find_one()
        if existing:
            for key, value in settings.items():
                setattr(existing, key, value)
            await existing.save()
        else:
            payload = DEFAULT_APP_SETTINGS.copy()
            payload.update(settings)
            await AppSettings(**payload).insert()

        # Clear the service config cache so new settings take effect immediately
        from service_config import clear_config_cache

        clear_config_cache()

    except Exception:
        logger.exception("Error updating app settings via API")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update application settings.",
        )
    else:
        return await get_persisted_app_settings()


@router.post("/api/database/clear-collection")
async def clear_collection(data: CollectionModel):
    name = data.collection
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing 'collection' field",
        )

    # Use Beanie models for known collections
    model = COLLECTION_TO_MODEL.get(name)
    if model is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Unknown collection "
                f"'{name}'. Supported: {list(COLLECTION_TO_MODEL.keys())}"
            ),
        )

    try:
        result = await model.find_all().delete()
        deleted_count = result.deleted_count if result else 0
    except Exception as e:
        logger.exception("Error clearing collection %s", name)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
    else:
        return {
            "message": f"Successfully cleared collection {name}",
            "deleted_count": deleted_count,
        }


@router.get("/api/database/storage-info")
async def get_storage_info():
    try:
        payload = {
            "used_mb": None,
        }
    except Exception as e:
        logger.exception("Error getting storage info")
        return {
            "used_mb": 0,
            "error": str(e),
        }
    else:
        return payload


@router.post("/api/validate_location")
async def validate_location(
    data: ValidateLocationModel,
):
    try:
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
        logger.exception(
            "Location validation failed for location=%s type=%s",
            data.location,
            data.locationType,
        )
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


@router.get("/api/first_trip_date")
async def get_first_trip_date():
    try:
        earliest_trip = await Trip.find_all().sort("startTime").limit(1).to_list()

        if not earliest_trip or not earliest_trip[0].startTime:
            now = datetime.now(UTC)
            return {"first_trip_date": now.isoformat()}

        start_time = ensure_utc(earliest_trip[0].startTime)
        if not start_time:
            now = datetime.now(UTC)
            return {"first_trip_date": now.isoformat()}

        return {
            "first_trip_date": start_time.isoformat().replace("+00:00", "Z"),
        }
    except Exception as e:
        logger.exception("get_first_trip_date error")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
