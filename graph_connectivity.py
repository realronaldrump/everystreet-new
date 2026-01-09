"""
Simple route gap-filling via Mapbox Directions API.

This module provides a single function to fetch driving routes between points,
used by the route solver to fill gaps in generated routes.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger(__name__)

# Rate limiting
MAX_CONCURRENT_API_CALLS = 5

# Connection pooling: shared httpx client for all Mapbox API requests
_mapbox_client: httpx.AsyncClient | None = None
_mapbox_client_lock = asyncio.Lock()

# Rate limiting: semaphore to limit concurrent API calls
_api_semaphore: asyncio.Semaphore | None = None


async def get_mapbox_client() -> httpx.AsyncClient:
    """Get or create a shared httpx client with connection pooling."""
    global _mapbox_client
    async with _mapbox_client_lock:
        if _mapbox_client is None or _mapbox_client.is_closed:
            _mapbox_client = httpx.AsyncClient(
                limits=httpx.Limits(
                    max_connections=10,
                    max_keepalive_connections=5,
                ),
                timeout=httpx.Timeout(30.0, connect=10.0),
            )
            logger.debug("Created new shared httpx client for Mapbox API")
        return _mapbox_client


def get_api_semaphore() -> asyncio.Semaphore:
    """Get or create the rate limiting semaphore."""
    global _api_semaphore
    if _api_semaphore is None:
        _api_semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
    return _api_semaphore


async def fetch_bridge_route(
    from_xy: tuple[float, float],
    to_xy: tuple[float, float],
    timeout: float = 30.0,
) -> list[list[float]] | None:
    """
    Get driveable route between two points via Mapbox Directions API.

    Args:
        from_xy: (lon, lat) of start point
        to_xy: (lon, lat) of end point
        timeout: Request timeout in seconds

    Returns:
        List of [lon, lat] coordinates for the route, or None if failed
    """
    from config import get_app_settings

    settings = await get_app_settings()
    token = settings.get("mapbox_access_token")
    if not token:
        logger.warning("Mapbox token not configured; cannot fetch bridge route")
        return None

    coords_str = f"{from_xy[0]},{from_xy[1]};{to_xy[0]},{to_xy[1]}"
    url = f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords_str}"
    params = {
        "access_token": token,
        "geometries": "geojson",
        "overview": "full",
    }

    try:
        # Use shared client with connection pooling and rate limiting
        semaphore = get_api_semaphore()
        async with semaphore:
            client = await get_mapbox_client()
            response = await client.get(url, params=params, timeout=timeout)
            response.raise_for_status()
            data = response.json()

            if routes := data.get("routes"):
                coords = routes[0]["geometry"]["coordinates"]
                logger.info(
                    "Fetched bridge route with %d coordinates (%.2f miles)",
                    len(coords),
                    routes[0].get("distance", 0) / 1609.34,  # meters to miles
                )
                return coords

            logger.warning("No route found by Mapbox Directions API")
            return None

    except httpx.HTTPStatusError as e:
        logger.error("Mapbox Directions API HTTP error: %s", e.response.status_code)
        # Add backoff for rate limit errors (429)
        if e.response.status_code == 429:
            await asyncio.sleep(1.0)  # Brief backoff
        return None
    except httpx.RequestError as e:
        logger.error("Mapbox Directions API request error: %s", e)
        return None
    except Exception as e:
        logger.error("Unexpected error fetching bridge route: %s", e)
        return None
