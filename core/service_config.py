"""
Service configuration loader.

Provides async functions to load user-specific configuration from the
database.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

from config import get_mapbox_token

if TYPE_CHECKING:
    from db.models import AppSettings

logger = logging.getLogger(__name__)

# Cache for settings to avoid repeated DB calls
_settings_cache: AppSettings | None = None
_seeded_env_keys: set[str] = set()


async def get_service_config() -> AppSettings:
    """
    Get service configuration from the database.

    Returns AppSettings document with user-specific settings.

    This function caches the settings for the lifetime of the process.
    Use clear_config_cache() to force a reload.
    """
    global _settings_cache

    if _settings_cache is not None:
        return _settings_cache

    from db.models import AppSettings

    settings = await AppSettings.find_one()
    if settings is None:
        settings = AppSettings()
        await settings.insert()
        logger.info("Created default AppSettings document")

    _apply_settings_to_env(settings)
    _settings_cache = settings
    return settings


def _set_env_value(key: str, value: str | None, *, force: bool = False) -> None:
    if not value:
        return
    existing = os.getenv(key)
    if force or existing is None or key in _seeded_env_keys:
        os.environ[key] = value
        _seeded_env_keys.add(key)


def _apply_settings_to_env(settings: AppSettings, *, force: bool = False) -> None:
    """Seed environment variables from stored settings."""
    _set_env_value(
        "NOMINATIM_USER_AGENT",
        settings.nominatim_user_agent,
        force=force,
    )
    _set_env_value("GEOFABRIK_MIRROR", settings.geofabrik_mirror, force=force)
    _set_env_value("OSM_EXTRACTS_PATH", settings.osm_extracts_path, force=force)
    _set_env_value(
        "COVERAGE_INCLUDE_SERVICE_ROADS",
        "1" if settings.coverageIncludeServiceRoads else "0",
        force=force,
    )


def apply_settings_to_env(settings: AppSettings, *, force: bool = False) -> None:
    """Public helper to sync settings into env vars for the running process."""
    _apply_settings_to_env(settings, force=force)


def clear_config_cache() -> None:
    """
    Clear the settings cache.

    Called on settings update.
    """
    global _settings_cache
    _settings_cache = None


# Convenience async getters for commonly used values
async def get_mapbox_token_async() -> str:
    """Get the application's immutable Mapbox token."""
    return get_mapbox_token()
