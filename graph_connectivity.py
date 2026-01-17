"""
Simple route gap-filling via Valhalla routing API.

This module provides a single function to fetch driving routes between
points, used by the route solver to fill gaps in generated routes.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

import httpx

from config import require_valhalla_route_url

logger = logging.getLogger(__name__)

# Rate limiting
MAX_CONCURRENT_API_CALLS = 5


class ValhallaClientState:
    """State container for Valhalla API client to avoid global variables."""

    client: httpx.AsyncClient | None = None
    client_lock: asyncio.Lock | None = None
    client_loop: asyncio.AbstractEventLoop | None = None
    api_semaphore: asyncio.Semaphore | None = None
    api_semaphore_loop: asyncio.AbstractEventLoop | None = None


async def get_valhalla_client() -> httpx.AsyncClient:
    """Get or create a shared httpx client with connection pooling."""
    loop = asyncio.get_running_loop()

    # Initialize lock if it doesn't exist or is for a different loop
    if (
        ValhallaClientState.client_lock is None
        or ValhallaClientState.client_loop is not loop
        or loop.is_closed()
    ):
        if ValhallaClientState.client and not ValhallaClientState.client.is_closed:
            with contextlib.suppress(Exception):
                await ValhallaClientState.client.aclose()
        ValhallaClientState.client = None
        ValhallaClientState.client_loop = loop
        ValhallaClientState.client_lock = asyncio.Lock()

    # At this point, client_lock is guaranteed to be initialized
    lock = ValhallaClientState.client_lock
    if lock is None:
        lock = asyncio.Lock()
        ValhallaClientState.client_lock = lock

    async with lock:
        if ValhallaClientState.client is None or ValhallaClientState.client.is_closed:
            ValhallaClientState.client = httpx.AsyncClient(
                limits=httpx.Limits(
                    max_connections=10,
                    max_keepalive_connections=5,
                ),
                timeout=httpx.Timeout(30.0, connect=10.0),
            )
            logger.debug("Created new shared httpx client for Valhalla API")
        return ValhallaClientState.client


def get_api_semaphore(loop: asyncio.AbstractEventLoop) -> asyncio.Semaphore:
    """Get or create the rate limiting semaphore."""
    if (
        ValhallaClientState.api_semaphore is None
        or ValhallaClientState.api_semaphore_loop is not loop
        or loop.is_closed()
    ):
        ValhallaClientState.api_semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
        ValhallaClientState.api_semaphore_loop = loop

    semaphore = ValhallaClientState.api_semaphore
    if semaphore is None:
        semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
        ValhallaClientState.api_semaphore = semaphore
        ValhallaClientState.api_semaphore_loop = loop

    return semaphore


async def fetch_bridge_route(
    from_xy: tuple[float, float],
    to_xy: tuple[float, float],
    timeout: float = 30.0,
) -> list[list[float]] | None:
    """
    Get driveable route between two points via Valhalla routing API.

    Args:
        from_xy: (lon, lat) of start point
        to_xy: (lon, lat) of end point
        timeout: Request timeout in seconds

    Returns:
        List of [lon, lat] coordinates for the route, or None if failed
    """
    url = require_valhalla_route_url()
    payload = {
        "locations": [
            {"lon": from_xy[0], "lat": from_xy[1]},
            {"lon": to_xy[0], "lat": to_xy[1]},
        ],
        "costing": "auto",
        "shape_format": "geojson",
    }

    try:
        loop = asyncio.get_running_loop()
        semaphore = get_api_semaphore(loop)
        async with semaphore:
            client = await get_valhalla_client()
            response = await client.post(url, json=payload, timeout=timeout)
            response.raise_for_status()
            data = response.json()

            trip = data.get("trip") or {}
            shape = trip.get("shape") or {}
            coords = shape.get("coordinates") or []
            if coords:
                distance_km = 0.0
                legs = trip.get("legs") or []
                summary = legs[0].get("summary") if legs else {}
                distance_km = summary.get("length", 0) if summary else 0
                logger.info(
                    "Fetched bridge route with %d coordinates (%.2f miles)",
                    len(coords),
                    distance_km * 0.621371,
                )
                return coords

            logger.warning("No route found by Valhalla routing API")
            return None

    except httpx.HTTPStatusError as e:
        logger.exception("Valhalla routing HTTP error: %s", e.response.status_code)
        return None
    except httpx.RequestError as e:
        logger.exception("Valhalla routing request error: %s", e)
        return None
    except Exception as e:
        logger.exception("Unexpected error fetching bridge route: %s", e)
        return None
