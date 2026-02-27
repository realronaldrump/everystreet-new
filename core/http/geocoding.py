"""
Geocoding utilities for self-hosted Nominatim APIs.

This module provides reverse geocoding and location validation functions
with built-in retry logic and error handling.
"""

from __future__ import annotations

import logging
from typing import Any

from core.exceptions import ValidationException
from core.http.nominatim import NominatimClient
from core.http.retry import retry_async
from core.mapping.factory import get_geocoder

logger = logging.getLogger(__name__)


def _is_settings_bootstrap_error(exc: ValidationException) -> bool:
    code = str(exc.details.get("code") or "").strip().lower()
    return code in {"settings_unavailable", "settings_missing"}


async def _resolve_geocoder() -> Any:
    """
    Resolve the active geocoder, falling back to local Nominatim when app settings
    are not initialized yet (common in isolated tests / bootstrap flows).
    """
    try:
        return await get_geocoder()
    except ValidationException as exc:
        if not _is_settings_bootstrap_error(exc):
            raise
        logger.debug(
            "Falling back to Nominatim geocoder due to bootstrap settings state: %s",
            exc.message,
        )
        return NominatimClient()


async def validate_location_osm(
    location: str,
    location_type: str,
) -> dict[str, Any] | None:
    """
    Validate a location using the active geocoder.

    Args:
        location: The location string to validate.
        location_type: The feature type to filter results.

    Returns:
        The first matching location result or None if not found.
    """
    client = await _resolve_geocoder()
    try:
        results = await client.search_raw(
            query=location,
            limit=1,
            polygon_geojson=True,
        )
    except NotImplementedError:
        # Fallback for Google Maps
        results = await client.search(
            query=location,
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


@retry_async(max_retries=3, retry_delay=2.0)
async def reverse_geocode_nominatim(
    lat: float,
    lon: float,
) -> dict[str, Any] | None:
    """
    Reverse geocode coordinates using the active mapping provider.

    Args:
        lat: Latitude coordinate.
        lon: Longitude coordinate.

    Returns:
        Geocoding result dictionary or None if failed.
    """
    client = await _resolve_geocoder()
    return await client.reverse(lat, lon)
