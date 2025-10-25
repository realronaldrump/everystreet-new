import logging
import asyncio
from datetime import datetime, timezone
from typing import Any

import geojson as geojson_module
from fastapi import APIRouter, Body, HTTPException, status

from db import (
    SerializationHelper,
    db_manager,
    delete_many_with_retry,
    find_one_with_retry,
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
    "disableWebSockets": False,
    "highlightRecentTrips": True,
    "autoCenter": True,
    "showLiveTracking": True,
    "polylineColor": "#00FF00",
    "polylineOpacity": 0.8,
    "storageLimitMb": 512,
}


async def get_persisted_app_settings() -> dict[str, Any]:
    """Retrieve persisted application settings (creates defaults if missing)."""

    try:
        doc = await find_one_with_retry(app_settings_collection, {"_id": "default"})
        if doc is None:
            # Initialise defaults
            await app_settings_collection.insert_one(DEFAULT_APP_SETTINGS)
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
    description="Retrieve persisted application-wide settings such as WebSocket preference.",
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
        await app_settings_collection.update_one(
            {"_id": "default"},
            {"$set": settings},
            upsert=True,
        )

        # Update in-memory storage limit if provided
        if "storageLimitMb" in settings:
            db_manager.set_limit_mb(settings["storageLimitMb"])
            # Recalculate quota status immediately
            try:
                await db_manager.check_quota()
            except Exception:
                logger.exception("Failed to refresh quota after storageLimitMb update")

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
        used_mb, limit_mb = await db_manager.check_quota()

        if used_mb is None or limit_mb is None:
            used_mb = 0
            limit_mb = db_manager.limit_mb
            storage_usage_percent = 0
        else:
            storage_usage_percent = round((used_mb / limit_mb) * 100, 2)

        return {
            "used_mb": used_mb,
            "limit_mb": limit_mb,
            "usage_percent": storage_usage_percent,
        }
    except Exception as e:
        logger.exception(
            "Error getting storage info: %s",
            str(e),
        )
        return {
            "used_mb": 0,
            "limit_mb": db_manager.limit_mb,
            "usage_percent": 0,
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
    except asyncio.TimeoutError as exc:
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
            now = datetime.now(timezone.utc)
            return {"first_trip_date": now.isoformat()}

        earliest_trip_date = earliest_trip["startTime"]
        if earliest_trip_date.tzinfo is None:
            earliest_trip_date = earliest_trip_date.replace(
                tzinfo=timezone.utc,
            )

        return {
            "first_trip_date": SerializationHelper.serialize_datetime(
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
