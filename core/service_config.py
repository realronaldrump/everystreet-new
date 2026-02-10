"""
Service configuration loader.

Provides async functions to load user-specific configuration from the
database with environment variable fallbacks. This allows runtime
configuration through the UI while maintaining backward compatibility
with .env files.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from db.models import AppSettings

logger = logging.getLogger(__name__)

# Cache for settings to avoid repeated DB calls
_settings_cache: AppSettings | None = None
_seeded_env_keys: set[str] = set()


async def get_service_config() -> AppSettings:
    """
    Get service configuration from the database.

    Returns AppSettings document with user-specific settings. Falls back
    to defaults if no settings are saved yet.

    This function caches the settings for the lifetime of the process.
    Use clear_config_cache() to force a reload.
    """
    global _settings_cache

    if _settings_cache is not None:
        return _settings_cache

    from db.models import AppSettings

    try:
        settings = await AppSettings.find_one()
        if settings is None:
            # Create default settings
            settings = AppSettings()
            await settings.insert()
            logger.info("Created default AppSettings document")
    except Exception as e:
        logger.warning("Failed to load settings from DB, using defaults: %s", e)
        # Return a default settings object (not persisted)
        settings = AppSettings()
        _apply_env_overrides(settings)
        _apply_settings_to_env(settings)
        return settings
    else:
        # Apply environment variable overrides for backward compatibility
        # Environment variables take precedence if set
        _apply_env_overrides(settings)
        _apply_settings_to_env(settings)

        _settings_cache = settings
        return settings


def _apply_env_overrides(settings: AppSettings) -> None:
    """
    Apply environment variable overrides to settings.

    Environment variables take precedence over database settings for
    backward compatibility with existing .env deployments.
    """
    # Mapbox
    env_mapbox = os.getenv("MAPBOX_TOKEN", "").strip()
    if env_mapbox:
        settings.mapbox_token = env_mapbox

    # OSM/Geofabrik
    env_geofabrik = os.getenv("GEOFABRIK_MIRROR", "").strip()
    if env_geofabrik:
        settings.geofabrik_mirror = env_geofabrik

    env_osm_path = os.getenv("OSM_EXTRACTS_PATH", "").strip()
    if env_osm_path:
        settings.osm_extracts_path = env_osm_path


def _set_env_value(key: str, value: str | None, *, force: bool = False) -> None:
    if not value:
        return
    existing = os.getenv(key)
    if force or existing is None or key in _seeded_env_keys:
        os.environ[key] = value
        _seeded_env_keys.add(key)


def _apply_settings_to_env(settings: AppSettings, *, force: bool = False) -> None:
    """Seed environment variables from stored settings."""
    _set_env_value("MAPBOX_TOKEN", settings.mapbox_token, force=force)
    _set_env_value("GEOFABRIK_MIRROR", settings.geofabrik_mirror, force=force)
    _set_env_value("OSM_EXTRACTS_PATH", settings.osm_extracts_path, force=force)


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
    """Get Mapbox token from settings."""
    config = await get_service_config()
    return config.mapbox_token or ""
