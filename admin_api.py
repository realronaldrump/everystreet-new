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
from db.schemas import CollectionModel, LocationModel, ValidateLocationModel
from osm_utils import generate_geojson_osm

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


DEFAULT_APP_SETTINGS: dict[str, Any] = {
    "highlightRecentTrips": True,
    "autoCenter": True,
    "showLiveTracking": True,
    "polylineColor": "#00FF00",
    "polylineOpacity": 0.8,
    "geocodeTripsOnFetch": True,
}


async def get_persisted_app_settings() -> AppSettings:
    try:
        settings = await AppSettings.find_one()
        if settings is None:
            settings = AppSettings(**DEFAULT_APP_SETTINGS)
            await settings.insert()
        return settings
    except Exception as e:
        logger.exception("Error fetching app settings: %s", e)
        return AppSettings(**DEFAULT_APP_SETTINGS)


@router.get(
    "/api/app_settings",
    response_model=AppSettings,
    response_model_exclude={"id"},
    summary="Get Application Settings",
    description="Retrieve persisted application-wide settings.",
)
async def get_app_settings_endpoint():
    try:
        return await get_persisted_app_settings()
    except Exception as e:
        logger.exception("Error fetching app settings via API: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve application settings.",
        )


@router.post(
    "/api/app_settings",
    response_model=AppSettings,
    response_model_exclude={"id"},
    summary="Update Application Settings",
    description="Persist application settings. Fields omitted in payload remain unchanged.",
)
async def update_app_settings_endpoint(settings: Annotated[dict, Body()]):
    try:
        if not isinstance(settings, dict):
            raise HTTPException(status_code=400, detail="Invalid payload")

        existing = await AppSettings.find_one()
        if existing:
            for key, value in settings.items():
                setattr(existing, key, value)
            await existing.save()
        else:
            payload = DEFAULT_APP_SETTINGS.copy()
            payload.update(settings)
            await AppSettings(**payload).insert()

        return await get_persisted_app_settings()
    except Exception as e:
        logger.exception("Error updating app settings via API: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update application settings.",
        )


@router.post("/api/database/clear-collection")
async def clear_collection(data: CollectionModel):
    try:
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
                detail=f"Unknown collection '{name}'. Supported: {list(COLLECTION_TO_MODEL.keys())}",
            )

        result = await model.find_all().delete()
        deleted_count = result.deleted_count if result else 0

        return {
            "message": f"Successfully cleared collection {name}",
            "deleted_count": deleted_count,
        }

    except HTTPException:
        raise
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
    try:
        return {
            "used_mb": None,
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
    try:
        most_recent = await Trip.find_all().sort(-Trip.endTime).limit(1).to_list()

        if not most_recent:
            return {"lastPoint": None}

        gps_data = most_recent[0].gps

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
    try:
        earliest_trip = await Trip.find_all().sort(Trip.startTime, 1).limit(1).to_list()

        if not earliest_trip or not earliest_trip[0].startTime:
            now = datetime.now(UTC)
            return {"first_trip_date": now.isoformat()}

        earliest_trip_date = ensure_utc(earliest_trip[0].startTime)

        return {
            "first_trip_date": earliest_trip_date.isoformat().replace("+00:00", "Z"),
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
