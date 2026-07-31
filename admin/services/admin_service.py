from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status

from admin.services.storage_service import StorageService
from config import get_mapbox_token
from core.date_utils import ensure_utc
from core.mapping.factory import clear_local_provider_cache, get_geocoder
from core.serialization import serialize_utc_datetime
from core.service_config import clear_config_cache, get_service_config
from db.manager import db_manager
from db.models import AppSettings, Trip
from routing.graph_connectivity import clear_router_cache

logger = logging.getLogger(__name__)

_MB_BYTES = 1024 * 1024


def _bytes_to_mb(size_bytes: float | None) -> float:
    if not size_bytes:
        return 0.0
    return round(size_bytes / _MB_BYTES, 2)


def _total_size_bytes(stats: dict[str, Any], index_key: str, data_key: str) -> int:
    total_size = stats.get("totalSize")
    if total_size is not None and total_size > 0:
        return int(total_size)

    storage_size = stats.get("storageSize") or 0
    index_size = stats.get(index_key) or 0
    combined = storage_size + index_size
    if combined > 0:
        return int(combined)

    return int(stats.get(data_key, 0) or 0)


def _public_app_settings_payload(settings: AppSettings) -> dict[str, Any]:
    payload = settings.model_dump()
    payload.pop("accentColor", None)
    payload.pop("mapbox_access_token", None)
    payload["mapbox_token"] = get_mapbox_token()
    return payload


# Map collection names to Beanie Document models for admin operations
MAPBOX_SETTINGS_ERROR = (
    "Mapbox token is hard-coded in the application and cannot be changed in settings."
)

DEFAULT_APP_SETTINGS: dict[str, Any] = {
    # UI Preferences
    "highlightRecentTrips": True,
    "autoCenter": True,
    "mapTripsWithinCoverageOnly": False,
    "tripLayersUseHeatmap": True,
    "mapTerrainReliefEnabled": False,
    "geocodeTripsOnFetch": True,
    "mapMatchTripsOnFetch": False,
    "mapMatchingProviderPolicy": "auto",
    # Geo Service Configuration (defaults for Docker Compose)
    "mapbox_token": get_mapbox_token(),
    "google_maps_api_key": None,
    "nominatim_user_agent": "Every Street/1.0",
    "geofabrik_mirror": "https://download.geofabrik.de",
    "osm_extracts_path": "/osm",
    "mapCoverageMode": "trips",
    "mapCoverageBufferMiles": 10.0,
    "mapCoverageSimplifyFeet": 150.0,
    "mapCoverageMaxPointsPerTrip": 2000,
    "mapCoverageBatchSize": 200,
    "coverageIncludeServiceRoads": True,
    "streetCoverageTripMode": "both",
    "setup_completed": False,
    "setup_completed_at": None,
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
        return _public_app_settings_payload(settings)

    @staticmethod
    async def update_app_settings(settings: dict[str, Any]) -> dict[str, Any]:
        settings = dict(settings)
        settings.pop("accentColor", None)
        settings.pop("mapbox_token", None)
        settings.pop("mapbox_access_token", None)

        existing = await AppSettings.find_one()
        router_settings_changed = False
        local_client_settings_changed = False
        if existing:
            if (
                "map_provider" in settings
                and settings["map_provider"] != existing.map_provider
            ):
                router_settings_changed = True
            if (
                "google_maps_api_key" in settings
                and settings["google_maps_api_key"] != existing.google_maps_api_key
            ):
                router_settings_changed = True
            if (
                "nominatim_user_agent" in settings
                and settings["nominatim_user_agent"] != existing.nominatim_user_agent
            ):
                local_client_settings_changed = True
            for key, value in settings.items():
                setattr(existing, key, value)
            await existing.save()
        else:
            router_settings_changed = (
                "map_provider" in settings or "google_maps_api_key" in settings
            )
            local_client_settings_changed = "nominatim_user_agent" in settings
            payload = DEFAULT_APP_SETTINGS.copy()
            payload.update(settings)
            await AppSettings(**payload).insert()

        clear_config_cache()
        if router_settings_changed:
            clear_router_cache()
        if local_client_settings_changed:
            clear_local_provider_cache()
        # Repopulate this process immediately; others refresh within the
        # settings cache TTL.
        await get_service_config(force_refresh=True)
        updated = await AdminService.get_persisted_app_settings()
        return _public_app_settings_payload(updated)

    @staticmethod
    async def get_storage_info() -> dict[str, Any]:
        snapshot = await StorageService.get_storage_snapshot()
        db_logical_bytes: int | None = None
        db_logical_mb: float | None = None
        try:
            stats = await db_manager.db.command("dbStats")
            db_logical_bytes = _total_size_bytes(stats, "indexSize", "dataSize")
            db_logical_mb = _bytes_to_mb(db_logical_bytes)
        except Exception:
            logger.exception("Failed to load database logical size stats")

        sources = snapshot.get("sources")
        has_mongo_volume_size = isinstance(sources, list) and any(
            source.get("id") == "mongo_data"
            and isinstance(source.get("size_bytes"), int)
            for source in sources
            if isinstance(source, dict)
        )
        if db_logical_bytes is not None and not has_mongo_volume_size:
            if isinstance(sources, list):
                sources.append(
                    {
                        "id": "mongodb_logical",
                        "label": "MongoDB logical data",
                        "category": "Database",
                        "size_bytes": db_logical_bytes,
                        "size_mb": db_logical_mb,
                        "detail": "Derived from MongoDB dbStats",
                        "error": None,
                    },
                )
            current_total_bytes = snapshot.get("total_bytes")
            if isinstance(current_total_bytes, int):
                total_bytes = current_total_bytes + db_logical_bytes
            else:
                total_bytes = db_logical_bytes
            snapshot["total_bytes"] = total_bytes
            snapshot["total_mb"] = _bytes_to_mb(total_bytes)

        snapshot.update(
            {
                "database_logical_bytes": db_logical_bytes,
                "database_logical_mb": db_logical_mb,
                "used_mb": snapshot.get("total_mb"),
            },
        )
        return snapshot

    @staticmethod
    async def get_storage_summary() -> dict[str, Any]:
        return await AdminService.get_storage_info()

    @staticmethod
    async def validate_location(location: str, location_type: str) -> dict[str, Any]:
        try:
            geocoder = await get_geocoder()

            async def _validate() -> dict[str, Any] | None:
                validate_fn = getattr(geocoder, "validate_location", None)
                if callable(validate_fn):
                    return await validate_fn(location, location_type)

                try:
                    results = await geocoder.search_raw(
                        query=location,
                        limit=1,
                        polygon_geojson=True,
                    )
                except NotImplementedError:
                    results = await geocoder.search(
                        location,
                        limit=1,
                    )

                if not results:
                    return None

                result = results[0]
                if (
                    location_type
                    and result.get("type") != location_type
                    and result.get("source") != "google"
                ):
                    return None
                return result

            validated = await asyncio.wait_for(
                _validate(),
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

        return {
            "first_trip_date": serialize_utc_datetime(start_time)
            or start_time.isoformat()
        }


__all__ = [
    "DEFAULT_APP_SETTINGS",
    "MAPBOX_SETTINGS_ERROR",
    "AdminService",
]
