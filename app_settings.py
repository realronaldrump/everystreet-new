"""App settings management.

This module handles storage and retrieval of app-wide settings from MongoDB.
Settings are stored once and shared across all deployments using the same database.
"""

from __future__ import annotations

import logging
from typing import Any

from db import db_manager, find_one_with_retry, update_one_with_retry

logger = logging.getLogger(__name__)

# In-memory cache for sync access
_settings_cache: dict[str, Any] | None = None


async def get_app_settings_collection():
    """Get the app_settings collection from db_manager."""
    return db_manager.get_collection("app_settings")


async def get_app_settings() -> dict[str, Any]:
    """Retrieve app settings from database.

    Returns:
        Dictionary containing:
            - mapbox_access_token: str
            - clarity_project_id: str | None
    """
    global _settings_cache

    def get_empty_settings() -> dict[str, Any]:
        """Return empty settings structure when none configured."""
        return {
            "mapbox_access_token": "",
            "clarity_project_id": None,
        }

    try:
        collection = await get_app_settings_collection()
        settings = await find_one_with_retry(
            collection,
            {"_id": "app_settings"},
        )

        if settings:
            logger.debug("Retrieved app settings from database")
            result = {
                "mapbox_access_token": settings.get("mapbox_access_token", ""),
                "clarity_project_id": settings.get("clarity_project_id"),
            }
            # Update cache
            _settings_cache = result
            return result

        logger.warning(
            "No app settings found in database. "
            "Please configure via the profile page."
        )
        return get_empty_settings()
    except Exception as e:
        logger.exception("Error retrieving app settings: %s", e)
        return get_empty_settings()


async def update_app_settings(settings: dict[str, Any]) -> bool:
    """Update app settings in database.

    Args:
        settings: Dictionary containing settings fields to update.
            Only the fields present in this dict will be updated.

    Returns:
        True if update was successful, False otherwise.
    """
    global _settings_cache

    try:
        collection = await get_app_settings_collection()

        # Build update_data with only the fields that were explicitly provided
        update_data = {}

        if "mapbox_access_token" in settings:
            update_data["mapbox_access_token"] = settings["mapbox_access_token"]
        if "clarity_project_id" in settings:
            update_data["clarity_project_id"] = settings["clarity_project_id"]

        if not update_data:
            logger.warning("No fields to update in app settings")
            return False

        result = await update_one_with_retry(
            collection,
            {"_id": "app_settings"},
            {"$set": update_data},
            upsert=True,
        )

        success = result.modified_count > 0 or result.upserted_id is not None
        if success:
            logger.info("Successfully updated app settings in database")
            # Invalidate cache
            _settings_cache = None
        else:
            logger.warning("No changes made to app settings")

        return success
    except Exception as e:
        logger.exception("Error updating app settings: %s", e)
        return False


def get_cached_mapbox_token() -> str:
    """Get Mapbox token from cache (sync access).

    This is used for module-level imports where async isn't available.
    The cache is populated when get_app_settings() is called.
    Falls back to empty string if cache not yet populated.
    """
    if _settings_cache and _settings_cache.get("mapbox_access_token"):
        return _settings_cache["mapbox_access_token"]
    return ""


def get_cached_clarity_id() -> str | None:
    """Get Clarity ID from cache (sync access).

    This is used for module-level imports where async isn't available.
    The cache is populated when get_app_settings() is called.
    Falls back to None if cache not yet populated.
    """
    if _settings_cache:
        return _settings_cache.get("clarity_project_id")
    return None


async def ensure_settings_cached() -> None:
    """Ensure settings are loaded into cache.

    Call this at app startup to populate the cache.
    """
    await get_app_settings()
    logger.info("App settings loaded into cache")
