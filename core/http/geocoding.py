"""
Geocoding utilities for self-hosted Nominatim APIs.

This module provides reverse geocoding and location validation functions
with built-in retry logic and error handling.
"""

from __future__ import annotations

import logging
from typing import Any

from aiohttp import ClientResponseError

from core.http.retry import retry_async
from core.http.session import get_session
from config import (
    require_nominatim_search_url,
    require_nominatim_reverse_url,
    require_nominatim_user_agent,
)

logger = logging.getLogger(__name__)


@retry_async()
async def validate_location_osm(
    location: str,
    location_type: str,
) -> dict[str, Any] | None:
    """
    Validate a location using the self-hosted Nominatim search API.

    Args:
        location: The location string to validate.
        location_type: The feature type to filter results.

    Returns:
        The first matching location result or None if not found.
    """
    params = {
        "q": location,
        "format": "json",
        "limit": 1,
        "featuretype": location_type,
        "polygon_geojson": 1,
    }
    headers = {"User-Agent": require_nominatim_user_agent()}
    url = require_nominatim_search_url()

    session = await get_session()
    try:
        async with session.get(
            url,
            params=params,
            headers=headers,
        ) as response:
            if response.status == 200:
                data = await response.json()
                return data[0] if data else None
            logger.error(
                "HTTP %s error validating location",
                response.status,
            )
            return None
    except Exception as e:
        logger.exception("Error validating location: %s", e)
        raise


@retry_async(max_retries=3, retry_delay=2.0)
async def reverse_geocode_nominatim(
    lat: float,
    lon: float,
) -> dict[str, Any] | None:
    """
    Reverse geocode coordinates using self-hosted Nominatim.

    Args:
        lat: Latitude coordinate.
        lon: Longitude coordinate.

    Returns:
        Geocoding result dictionary or None if failed.
    """
    url = require_nominatim_reverse_url()
    params = {
        "format": "jsonv2",
        "lat": lat,
        "lon": lon,
        "zoom": 18,
        "addressdetails": 1,
    }
    headers = {"User-Agent": require_nominatim_user_agent()}

    session = await get_session()
    async with session.get(url, params=params, headers=headers) as response:
        if response.status == 200:
            return await response.json()
        if response.status == 429:
            retry_after = int(response.headers.get("Retry-After", 5))
            raise ClientResponseError(
                request_info=response.request_info,
                history=response.history,
                status=429,
                message=f"Rate limited. Retry after {retry_after}s",
            )
        logger.warning(
            "Geocoding error: status code %d",
            response.status,
        )
        return None
