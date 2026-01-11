"""
App settings management.

This module handles storage and retrieval of app-wide settings from MongoDB. Settings
are stored once and shared across all deployments using the same database.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from db.models import AppSettings

logger = logging.getLogger(__name__)


class SettingsCache:
    """Cache container for app settings to avoid global variables."""

    _cache: dict[str, Any] | None = None

    @classmethod
    def get_cache(cls) -> dict[str, Any] | None:
        """Get the current cache."""
        return cls._cache

    @classmethod
    def set_cache(cls, cache: dict[str, Any] | None) -> None:
        """Set the cache."""
        cls._cache = cache


async def get_app_settings() -> dict[str, Any]:
    """
    Retrieve app settings from database.

    Returns:
        Dictionary containing:
            - mapbox_access_token: str
            - clarity_project_id: str | None
    """

    def get_empty_settings() -> dict[str, Any]:
        """Return empty settings structure when none configured."""
        return {
            "mapbox_access_token": "",
            "clarity_project_id": None,
        }

    try:
        # Get the single settings document from the collection
        settings = await AppSettings.find_one()

        if settings:
            logger.debug("Retrieved app settings from database")

            # Use DB value
            # Model fields should be populated, fallback to dict access if needed via extra fields
            token = settings.mapbox_access_token or ""

            # If mapbox_access_token was not in model fields but in db (because of extra='allow')
            if not token and hasattr(settings, "mapbox_access_token"):
                token = getattr(settings, "mapbox_access_token", "")

            clarity_id = settings.clarity_project_id

            result = {
                "mapbox_access_token": token,
                "clarity_project_id": clarity_id,
            }
            # Update cache
            SettingsCache.set_cache(result)
            return result

        logger.warning("No app settings found in database. Using environment defaults.")
        return get_empty_settings()
    except Exception as e:
        logger.exception("Error retrieving app settings: %s", e)
        return get_empty_settings()


async def update_app_settings(settings: dict[str, Any]) -> bool:
    """
    Update app settings in database.

    Args:
        settings: Dictionary containing settings fields to update.
            Only the fields present in this dict will be updated.

    Returns:
        True if update was successful, False otherwise.
    """

    try:
        # Build update_data with only the fields that were explicitly provided
        update_data = {}

        if "mapbox_access_token" in settings:
            update_data["mapbox_access_token"] = settings["mapbox_access_token"]
        if "clarity_project_id" in settings:
            update_data["clarity_project_id"] = settings["clarity_project_id"]

        if not update_data:
            logger.warning("No fields to update in app settings")
            return False

        # Update via Beanie
        # We try to get the single settings document first
        doc = await AppSettings.find_one()
        if doc:
            # Update fields
            for k, v in update_data.items():
                setattr(doc, k, v)
            doc.updated_at = datetime.now(UTC)
            await doc.save()
            success = True
        else:
            # Insert new document (MongoDB will auto-generate ObjectId)
            new_doc = AppSettings(updated_at=datetime.now(UTC), **update_data)
            await new_doc.insert()
            success = True

        if success:
            logger.info("Successfully updated app settings in database")
            # Invalidate cache
            SettingsCache.set_cache(None)
        else:
            logger.warning("No changes made to app settings")

        return success
    except Exception as e:
        logger.exception("Error updating app settings: %s", e)
        return False


def get_cached_mapbox_token() -> str:
    """
    Get Mapbox token from cache (sync access).

    This is used for module-level imports where async isn't available. The cache is
    populated when get_app_settings() is called. Falls back to environment variable if
    cache is empty or missing.
    """
    token = ""
    cache = SettingsCache.get_cache()
    if cache and cache.get("mapbox_access_token"):
        token = cache["mapbox_access_token"]

    return token


def get_cached_clarity_id() -> str | None:
    """
    Get Clarity ID from cache (sync access).

    This is used for module-level imports where async isn't available. The cache is
    populated when get_app_settings() is called. Falls back to None if cache not yet
    populated.
    """
    cache = SettingsCache.get_cache()
    if cache:
        return cache.get("clarity_project_id")
    return None


async def ensure_settings_cached() -> None:
    """
    Ensure settings are loaded into cache.

    Call this at app startup to populate the cache.
    """
    await get_app_settings()
    logger.info("App settings loaded into cache")
