"""
Geocoding utilities for self-hosted Nominatim APIs.

This module provides reverse geocoding and location validation functions
with built-in retry logic and error handling.
"""

from __future__ import annotations

import logging
from typing import Any

from core.http.retry import retry_async
from core.mapping.factory import get_geocoder

logger = logging.getLogger(__name__)


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
    client = await get_geocoder()
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
    client = await get_geocoder()
    return await client.reverse(lat, lon)
