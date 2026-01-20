"""
Service configuration loader.

Provides async functions to load service configuration from the database
with environment variable fallbacks. This allows runtime configuration
through the UI while maintaining backward compatibility with .env files.

Usage:
    from service_config import get_service_config

    config = await get_service_config()
    nominatim_url = config.get_nominatim_search_url()
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

    Returns AppSettings document with all geo service URLs and tokens.
    Falls back to defaults if no settings are saved yet.

    This function caches the settings for the lifetime of the request.
    Use refresh_service_config() to force a reload.
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

        # Apply environment variable overrides for backward compatibility
        # Environment variables take precedence if set
        _apply_env_overrides(settings)
        _apply_settings_to_env(settings)

        _settings_cache = settings
        return settings

    except Exception as e:
        logger.warning("Failed to load settings from DB, using defaults: %s", e)
        # Return a default settings object (not persisted)
        settings = AppSettings()
        _apply_env_overrides(settings)
        _apply_settings_to_env(settings)
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

    # Nominatim
    env_nominatim_base = os.getenv("NOMINATIM_BASE_URL", "").strip()
    if env_nominatim_base:
        settings.nominatim_base_url = env_nominatim_base

    env_nominatim_search = os.getenv("NOMINATIM_SEARCH_URL", "").strip()
    if env_nominatim_search:
        settings.nominatim_search_url = env_nominatim_search

    env_nominatim_reverse = os.getenv("NOMINATIM_REVERSE_URL", "").strip()
    if env_nominatim_reverse:
        settings.nominatim_reverse_url = env_nominatim_reverse

    env_nominatim_ua = os.getenv("NOMINATIM_USER_AGENT", "").strip()
    if env_nominatim_ua:
        settings.nominatim_user_agent = env_nominatim_ua

    # Valhalla
    env_valhalla_base = os.getenv("VALHALLA_BASE_URL", "").strip()
    if env_valhalla_base:
        settings.valhalla_base_url = env_valhalla_base

    env_valhalla_status = os.getenv("VALHALLA_STATUS_URL", "").strip()
    if env_valhalla_status:
        settings.valhalla_status_url = env_valhalla_status

    env_valhalla_route = os.getenv("VALHALLA_ROUTE_URL", "").strip()
    if env_valhalla_route:
        settings.valhalla_route_url = env_valhalla_route

    env_valhalla_trace = os.getenv("VALHALLA_TRACE_ROUTE_URL", "").strip()
    if env_valhalla_trace:
        settings.valhalla_trace_route_url = env_valhalla_trace

    env_valhalla_attrs = os.getenv("VALHALLA_TRACE_ATTRIBUTES_URL", "").strip()
    if env_valhalla_attrs:
        settings.valhalla_trace_attributes_url = env_valhalla_attrs

    # OSM/Geofabrik
    env_geofabrik = os.getenv("GEOFABRIK_MIRROR", "").strip()
    if env_geofabrik:
        settings.geofabrik_mirror = env_geofabrik

    env_osm_path = os.getenv("OSM_EXTRACTS_PATH", "").strip()
    if env_osm_path:
        settings.osm_extracts_path = env_osm_path


def _set_env_value(key: str, value: str | None) -> None:
    if not value:
        return
    existing = os.getenv(key)
    if existing is None or key in _seeded_env_keys:
        os.environ[key] = value
        _seeded_env_keys.add(key)


def _apply_settings_to_env(settings: AppSettings) -> None:
    """Seed environment variables from stored settings."""
    _set_env_value("MAPBOX_TOKEN", settings.mapbox_token)
    _set_env_value("NOMINATIM_BASE_URL", settings.nominatim_base_url)
    _set_env_value("NOMINATIM_SEARCH_URL", settings.get_nominatim_search_url())
    _set_env_value("NOMINATIM_REVERSE_URL", settings.get_nominatim_reverse_url())
    _set_env_value("NOMINATIM_USER_AGENT", settings.nominatim_user_agent)
    _set_env_value("VALHALLA_BASE_URL", settings.valhalla_base_url)
    _set_env_value("VALHALLA_STATUS_URL", settings.get_valhalla_status_url())
    _set_env_value("VALHALLA_ROUTE_URL", settings.get_valhalla_route_url())
    _set_env_value("VALHALLA_TRACE_ROUTE_URL", settings.get_valhalla_trace_route_url())
    _set_env_value(
        "VALHALLA_TRACE_ATTRIBUTES_URL",
        settings.get_valhalla_trace_attributes_url(),
    )
    _set_env_value("GEOFABRIK_MIRROR", settings.geofabrik_mirror)
    _set_env_value("OSM_EXTRACTS_PATH", settings.osm_extracts_path)


async def refresh_service_config() -> AppSettings:
    """Force reload of service configuration from database."""
    global _settings_cache
    _settings_cache = None
    return await get_service_config()


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


async def get_nominatim_search_url_async() -> str:
    """Get Nominatim search URL from settings."""
    config = await get_service_config()
    return config.get_nominatim_search_url()


async def get_nominatim_reverse_url_async() -> str:
    """Get Nominatim reverse URL from settings."""
    config = await get_service_config()
    return config.get_nominatim_reverse_url()


async def get_valhalla_trace_route_url_async() -> str:
    """Get Valhalla trace_route URL from settings."""
    config = await get_service_config()
    return config.get_valhalla_trace_route_url()


async def get_valhalla_route_url_async() -> str:
    """Get Valhalla route URL from settings."""
    config = await get_service_config()
    return config.get_valhalla_route_url()
