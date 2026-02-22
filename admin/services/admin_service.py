from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, status
from pymongo.errors import OperationFailure

from admin.services.storage_service import StorageService
from config import get_mapbox_token
from core.date_utils import ensure_utc
from core.http.geocoding import validate_location_osm
from core.service_config import apply_settings_to_env, clear_config_cache
from db.manager import db_manager
from db.models import (
    ALL_DOCUMENT_MODELS,
    AppSettings,
    GasFillup,
    Job,
    OsmData,
    Place,
    ServerLog,
    Street,
    TaskConfig,
    TaskHistory,
    Trip,
    Vehicle,
)

if TYPE_CHECKING:
    from collections.abc import Iterable

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


# Map collection names to Beanie Document models for admin operations
COLLECTION_TO_MODEL = {
    "trips": Trip,
    "streets": Street,
    "osm_data": OsmData,
    "places": Place,
    "task_config": TaskConfig,
    "task_history": TaskHistory,
    "jobs": Job,
    "gas_fillups": GasFillup,
    "vehicles": Vehicle,
    "server_logs": ServerLog,
}

MAPBOX_SETTINGS_ERROR = (
    "Mapbox token is hard-coded in the application and cannot be changed in settings."
)

DEFAULT_APP_SETTINGS: dict[str, Any] = {
    # UI Preferences
    "highlightRecentTrips": True,
    "autoCenter": True,
    "geocodeTripsOnFetch": True,
    "mapMatchTripsOnFetch": False,
    # Geo Service Configuration (defaults for Docker Compose)
    "mapbox_token": get_mapbox_token(),
    "nominatim_user_agent": "EveryStreet/1.0",
    "geofabrik_mirror": "https://download.geofabrik.de",
    "osm_extracts_path": "/osm",
    "mapCoverageMode": "trips",
    "mapCoverageBufferMiles": 10.0,
    "mapCoverageSimplifyFeet": 150.0,
    "mapCoverageMaxPointsPerTrip": 2000,
    "mapCoverageBatchSize": 200,
    "coverageIncludeServiceRoads": True,
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
        payload = settings.model_dump()
        payload.pop("mapbox_access_token", None)
        payload["mapbox_token"] = get_mapbox_token()
        return payload

    @staticmethod
    async def update_app_settings(settings: dict[str, Any]) -> AppSettings:
        settings = dict(settings)
        settings.pop("mapbox_token", None)
        settings.pop("mapbox_access_token", None)

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
        updated = await AdminService.get_persisted_app_settings()
        apply_settings_to_env(updated, force=True)
        return updated

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
        snapshot = await StorageService.get_storage_snapshot()
        db_logical_bytes: int | None = None
        db_logical_mb: float | None = None
        try:
            stats = await db_manager.db.command("dbStats")
            db_logical_bytes = _total_size_bytes(stats, "indexSize", "dataSize")
            db_logical_mb = _bytes_to_mb(db_logical_bytes)
        except Exception:
            logger.exception("Failed to load database logical size stats")

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
        storage_info, collections = await asyncio.gather(
            AdminService.get_storage_info(),
            AdminService.get_collections_summary(),
        )
        storage_info["collections"] = collections
        return storage_info

    @staticmethod
    async def get_collections_summary() -> list[dict[str, Any]]:
        collection_models: dict[str, Any] = {}
        for model in ALL_DOCUMENT_MODELS:
            collection_models.setdefault(model.get_collection_name(), model)

        collection_names = sorted(collection_models)
        collection_sizes = await AdminService.get_collection_sizes_mb(collection_names)

        async def _count_documents(collection_name: str) -> int:
            model = collection_models[collection_name]
            try:
                return await model.find_all().count()
            except Exception:
                logger.exception(
                    "Failed to count documents for collection %s",
                    collection_name,
                )
                return 0

        counts = await asyncio.gather(
            *[
                _count_documents(collection_name)
                for collection_name in collection_names
            ],
        )

        return [
            {
                "name": collection_name,
                "document_count": counts[index],
                "size_mb": collection_sizes.get(collection_name),
            }
            for index, collection_name in enumerate(collection_names)
        ]

    @staticmethod
    async def get_collection_sizes_mb(
        collection_names: Iterable[str],
    ) -> dict[str, float | None]:
        collection_name_list = list(collection_names)
        try:
            db = db_manager.db
        except Exception as exc:
            logger.warning(
                "MongoDB unavailable while loading collection sizes: %s",
                exc,
            )
            return dict.fromkeys(collection_name_list, None)

        sizes: dict[str, float | None] = {}
        for collection in collection_name_list:
            try:
                stats = await db.command({"collStats": collection})
            except OperationFailure as exc:
                if getattr(exc, "code", None) == 26:
                    sizes[collection] = 0.0
                    continue
                logger.warning(
                    "Failed to fetch stats for collection %s: %s",
                    collection,
                    exc,
                )
                sizes[collection] = None
                continue

            size_bytes = _total_size_bytes(stats, "totalIndexSize", "size")
            sizes[collection] = _bytes_to_mb(size_bytes)

        return sizes

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
    "MAPBOX_SETTINGS_ERROR",
    "AdminService",
]
