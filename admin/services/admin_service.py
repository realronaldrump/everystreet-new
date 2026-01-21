from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status

from core.date_utils import ensure_utc
from core.http.geocoding import validate_location_osm
from core.service_config import clear_config_cache
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

logger = logging.getLogger(__name__)

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
    "nominatim_user_agent": "EveryStreet/1.0",
    "geofabrik_mirror": "https://download.geofabrik.de",
    "osm_extracts_path": "/osm",
    "setup_completed": False,
    "setup_completed_at": None,
}

DEPRECATED_APP_SETTINGS_FIELDS = {
    "nominatim_base_url",
    "nominatim_search_url",
    "nominatim_reverse_url",
    "valhalla_base_url",
    "valhalla_status_url",
    "valhalla_route_url",
    "valhalla_trace_route_url",
    "valhalla_trace_attributes_url",
}


class AdminService:
    """Admin service helpers for settings and collection maintenance."""

    @staticmethod
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

    @staticmethod
    async def get_app_settings_payload() -> dict[str, Any]:
        settings = await AdminService.get_persisted_app_settings()
        payload = settings.model_dump()
        payload.pop("mapbox_access_token", None)
        for key in DEPRECATED_APP_SETTINGS_FIELDS:
            payload.pop(key, None)
        return payload

    @staticmethod
    async def update_app_settings(settings: dict[str, Any]) -> AppSettings:
        existing = await AppSettings.find_one()
        if existing:
            for key, value in settings.items():
                setattr(existing, key, value)
            await existing.save()
        else:
            payload = DEFAULT_APP_SETTINGS.copy()
            payload.update(settings)
            await AppSettings(**payload).insert()

        clear_config_cache()
        return await AdminService.get_persisted_app_settings()

    @staticmethod
    async def clear_collection(collection: str) -> dict[str, Any]:
        model = COLLECTION_TO_MODEL.get(collection)
        if model is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Unknown collection "
                    f"'{collection}'. Supported: {list(COLLECTION_TO_MODEL.keys())}"
                ),
            )

        result = await model.find_all().delete()
        deleted_count = result.deleted_count if result else 0
        return {
            "message": f"Successfully cleared collection {collection}",
            "deleted_count": deleted_count,
        }

    @staticmethod
    async def get_storage_info() -> dict[str, Any]:
        return {
            "used_mb": None,
        }

    @staticmethod
    async def validate_location(location: str, location_type: str) -> dict[str, Any]:
        try:
            validated = await asyncio.wait_for(
                validate_location_osm(location, location_type),
                timeout=12.0,
            )
        except TimeoutError as exc:
            logger.warning(
                "Location validation timed out for location=%s type=%s",
                location,
                location_type,
            )
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="Validation timed out. Please try again.",
            ) from exc
        except Exception as exc:
            logger.exception(
                "Location validation failed for location=%s type=%s",
                location,
                location_type,
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

    @staticmethod
    async def get_first_trip_date() -> dict[str, str]:
        earliest_trip = await Trip.find_all().sort("startTime").limit(1).to_list()
        if not earliest_trip or not earliest_trip[0].startTime:
            now = datetime.now(UTC)
            return {"first_trip_date": now.isoformat()}

        start_time = ensure_utc(earliest_trip[0].startTime)
        if not start_time:
            now = datetime.now(UTC)
            return {"first_trip_date": now.isoformat()}

        return {"first_trip_date": start_time.isoformat().replace("+00:00", "Z")}


__all__ = [
    "COLLECTION_TO_MODEL",
    "DEFAULT_APP_SETTINGS",
    "DEPRECATED_APP_SETTINGS_FIELDS",
    "MAPBOX_SETTINGS_ERROR",
    "AdminService",
]
