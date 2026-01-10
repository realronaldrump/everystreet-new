"""Geocoding utilities for OpenStreetMap Nominatim and Mapbox APIs.

This module provides reverse geocoding and location validation functions
with built-in retry logic and rate limit handling.
"""

from __future__ import annotations

import logging
from typing import Any

from aiohttp import ClientResponseError

from core.http.retry import retry_async
from core.http.session import get_session

logger = logging.getLogger(__name__)


@retry_async()
async def validate_location_osm(
    location: str,
    location_type: str,
) -> dict[str, Any] | None:
    """Validate a location using the OSM Nominatim search API.

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
    headers = {"User-Agent": "EveryStreet-Validator/1.0"}

    session = await get_session()
    try:
        async with session.get(
            "https://nominatim.openstreetmap.org/search",
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
        logger.error("Error validating location: %s", e)
        raise


@retry_async(max_retries=3, retry_delay=2.0)
async def reverse_geocode_nominatim(
    lat: float,
    lon: float,
) -> dict[str, Any] | None:
    """Reverse geocode coordinates using OSM Nominatim.

    Args:
        lat: Latitude coordinate.
        lon: Longitude coordinate.

    Returns:
        Geocoding result dictionary or None if failed.
    """
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "format": "jsonv2",
        "lat": lat,
        "lon": lon,
        "zoom": 18,
        "addressdetails": 1,
    }
    headers = {"User-Agent": "EveryStreet-GeoCoder/1.0"}

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


@retry_async(max_retries=3, retry_delay=1.0)
async def reverse_geocode_mapbox(
    lat: float,
    lon: float,
    access_token: str,
) -> dict[str, Any] | None:
    """Reverse geocode coordinates using Mapbox Geocoding API.

    Args:
        lat: Latitude coordinate.
        lon: Longitude coordinate.
        access_token: Mapbox API access token.

    Returns:
        The first feature from Mapbox geocoding result or None if failed.
    """
    url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{lon},{lat}.json"
    params = {
        "access_token": access_token,
        "types": "address,poi",
        "limit": 1,
    }

    session = await get_session()
    async with session.get(url, params=params) as response:
        if response.status == 200:
            data = await response.json()
            if data.get("features"):
                return data["features"][0]
            return None
        if response.status == 429:
            retry_after = int(response.headers.get("Retry-After", 5))
            raise ClientResponseError(
                request_info=response.request_info,
                history=response.history,
                status=429,
                message=f"Rate limited. Retry after {retry_after}s",
            )
        logger.warning(
            "Mapbox geocoding error: status code %d",
            response.status,
        )
        return None
