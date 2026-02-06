"""
Simple route gap-filling via Valhalla routing API.

This module provides a single function to fetch driving routes between
points, used by the route solver to fill gaps in generated routes.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from core.exceptions import ExternalServiceException
from core.http.valhalla import ValhallaClient

logger = logging.getLogger(__name__)

# Rate limiting
MAX_CONCURRENT_API_CALLS = 5


class ValhallaClientState:
    """State container for Valhalla API client to avoid global variables."""

    client: ValhallaClient | None = None
    client_lock: asyncio.Lock | None = None
    client_loop: asyncio.AbstractEventLoop | None = None
    api_semaphore: asyncio.Semaphore | None = None
    api_semaphore_loop: asyncio.AbstractEventLoop | None = None


@dataclass(frozen=True)
class BridgeRoute:
    coordinates: list[list[float]]
    distance_m: float = 0.0
    duration_s: float = 0.0


async def get_valhalla_client() -> ValhallaClient:
    """Get or create a shared Valhalla client."""
    loop = asyncio.get_running_loop()

    if (
        ValhallaClientState.client_lock is None
        or ValhallaClientState.client_loop is not loop
        or loop.is_closed()
    ):
        ValhallaClientState.client = None
        ValhallaClientState.client_loop = loop
        ValhallaClientState.client_lock = asyncio.Lock()

    lock = ValhallaClientState.client_lock
    if lock is None:
        lock = asyncio.Lock()
        ValhallaClientState.client_lock = lock

    async with lock:
        if ValhallaClientState.client is None:
            ValhallaClientState.client = ValhallaClient()
            logger.debug("Created shared Valhalla client")
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
    request_timeout: float = 30.0,
) -> BridgeRoute | None:
    """
    Get driveable route between two points via Valhalla routing API.

    Args:
        from_xy: (lon, lat) of start point
        to_xy: (lon, lat) of end point
        request_timeout: Request timeout in seconds

    Returns:
        List of [lon, lat] coordinates for the route, or None if failed
    """
    try:
        loop = asyncio.get_running_loop()
        semaphore = get_api_semaphore(loop)
        async with semaphore:
            client = await get_valhalla_client()
            result = await client.route(
                [from_xy, to_xy],
                timeout=request_timeout,
            )
    except ExternalServiceException as exc:
        logger.exception("Valhalla routing error: %s", exc.message)
        return None
    except Exception:
        logger.exception("Unexpected error fetching bridge route")
        return None

    geometry = result.get("geometry") if isinstance(result, dict) else None
    coords = geometry.get("coordinates") if geometry else []
    if coords:
        distance_m = result.get("distance_meters", 0) if isinstance(result, dict) else 0
        duration_s = result.get("duration_seconds", 0) if isinstance(result, dict) else 0
        logger.info(
            "Fetched bridge route with %d coordinates (%.2f miles)",
            len(coords),
            (distance_m or 0) * 0.000621371,
        )
        return BridgeRoute(
            coordinates=coords,
            distance_m=float(distance_m or 0.0),
            duration_s=float(duration_s or 0.0),
        )

    logger.warning("No route found by Valhalla routing API")
    return None
