"""
Factory class for resolving the active MappingProvider.
"""

import logging

from beanie.exceptions import CollectionWasNotInitialized

from core.exceptions import ValidationException
from core.mapping.google_provider import GoogleProvider
from core.mapping.interfaces import Geocoder, MappingProvider, Router
from core.mapping.local_provider import LocalProvider
from db.models import AppSettings, MapProvider

logger = logging.getLogger(__name__)
_local_provider: LocalProvider | None = None


def _get_local_provider() -> LocalProvider:
    global _local_provider
    if _local_provider is None:
        _local_provider = LocalProvider()
    return _local_provider


def clear_local_provider_cache() -> None:
    """Reset cached local provider so settings-backed env changes take effect."""
    global _local_provider
    _local_provider = None


async def _load_mapping_settings() -> AppSettings:
    """Load persisted mapping settings or raise a configuration error."""
    try:
        settings = await AppSettings.find_one({"_id": "default"})
    except CollectionWasNotInitialized as exc:
        msg = (
            "Map provider settings are unavailable because AppSettings is not "
            "initialized. Complete setup before using mapping services."
        )
        logger.warning(msg)
        raise ValidationException(msg, {"code": "settings_unavailable"}) from exc
    except Exception as exc:
        logger.exception("Failed to resolve AppSettings for mapping provider")
        msg = "Failed to load map provider settings."
        raise ValidationException(msg, {"code": "settings_load_failed"}) from exc

    if not settings:
        msg = (
            "Map provider settings are missing. Configure app settings before "
            "using mapping services."
        )
        raise ValidationException(msg, {"code": "settings_missing"})

    return settings


async def is_google_map_provider() -> bool:
    """Return True when map provider is configured to Google."""
    settings = await _load_mapping_settings()
    return settings.map_provider == MapProvider.GOOGLE


async def get_mapping_provider() -> MappingProvider:
    """
    Returns the active MappingProvider based on AppSettings.

    If MapProvider.GOOGLE is selected, a non-empty API key is required.
    Otherwise, defaults to LocalProvider (Valhalla + Nominatim).
    """
    settings = await _load_mapping_settings()

    if settings.map_provider == MapProvider.GOOGLE:
        api_key = (settings.google_maps_api_key or "").strip()
        if not api_key:
            raise ValidationException(
                "Map provider is set to GOOGLE, but google_maps_api_key is missing or blank. "
                "Set app_settings.google_maps_api_key to a valid key or switch map_provider "
                "to self_hosted.",
                {"code": "google_key_missing"},
            )
        return GoogleProvider(api_key=api_key)

    return _get_local_provider()


async def get_geocoder() -> Geocoder:
    provider = await get_mapping_provider()
    return provider.geocoder


async def get_router() -> Router:
    provider = await get_mapping_provider()
    return provider.router
