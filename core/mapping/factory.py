"""
Factory class for resolving the active MappingProvider.
"""

import logging

from beanie.exceptions import CollectionWasNotInitialized

from core.exceptions import ValidationException
from db.models import AppSettings, MapProvider
from core.mapping.interfaces import MappingProvider
from core.mapping.local_provider import LocalProvider
from core.mapping.google_provider import GoogleProvider

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


async def get_mapping_provider() -> MappingProvider:
    """
    Returns the active MappingProvider based on AppSettings.

    If MapProvider.GOOGLE is selected, a non-empty API key is required.
    Otherwise, defaults to LocalProvider (Valhalla + Nominatim).
    """
    try:
        settings = await AppSettings.find_one({"_id": "default"})
    except CollectionWasNotInitialized:
        logger.debug(
            "AppSettings collection not initialized; defaulting to LocalProvider",
        )
        return _get_local_provider()
    except Exception:
        logger.exception("Failed to resolve AppSettings; defaulting to LocalProvider")
        return _get_local_provider()

    if not settings:
        return _get_local_provider()

    if settings.map_provider == MapProvider.GOOGLE:
        api_key = (settings.google_maps_api_key or "").strip()
        if not api_key:
            raise ValidationException(
                "Map provider is set to GOOGLE, but google_maps_api_key is missing or blank. "
                "Set app_settings.google_maps_api_key to a valid key or switch map_provider "
                "to self_hosted.",
            )
        return GoogleProvider(api_key=api_key)

    return _get_local_provider()


async def get_geocoder() -> "Geocoder":
    provider = await get_mapping_provider()
    return provider.geocoder


async def get_router() -> "Router":
    provider = await get_mapping_provider()
    return provider.router
