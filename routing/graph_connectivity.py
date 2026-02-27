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
from core.mapping.factory import get_router
from core.mapping.interfaces import Router

logger = logging.getLogger(__name__)

# Rate limiting
MAX_CONCURRENT_API_CALLS = 5


class RouterState:
    """State container for Map Router to avoid global variables."""

    client: Router | None = None
    client_lock: asyncio.Lock | None = None
    client_loop: asyncio.AbstractEventLoop | None = None
    api_semaphore: asyncio.Semaphore | None = None
    api_semaphore_loop: asyncio.AbstractEventLoop | None = None


def clear_router_cache() -> None:
    """Reset the shared router so future calls resolve provider settings again."""
    RouterState.client = None
    RouterState.client_loop = None


@dataclass(frozen=True)
class BridgeRoute:
    coordinates: list[list[float]]
    distance_m: float = 0.0
    duration_s: float = 0.0


async def get_shared_router() -> Router:
    """Get or create a shared Map Router."""
    loop = asyncio.get_running_loop()

    if (
        RouterState.client_lock is None
        or RouterState.client_loop is not loop
        or loop.is_closed()
    ):
        RouterState.client = None
        RouterState.client_loop = loop
        RouterState.client_lock = asyncio.Lock()

    lock = RouterState.client_lock
    if lock is None:
        lock = asyncio.Lock()
        RouterState.client_lock = lock

    async with lock:
        if RouterState.client is None:
            RouterState.client = await get_router()
            logger.debug("Created shared Map Router")
        return RouterState.client


async def get_valhalla_client() -> Router:
    """
    Backward-compatible alias used by tests and older call sites.

    Returns the shared active router implementation.
    """
    return await get_shared_router()


def get_api_semaphore(loop: asyncio.AbstractEventLoop) -> asyncio.Semaphore:
    """Get or create the rate limiting semaphore."""
    if (
        RouterState.api_semaphore is None
        or RouterState.api_semaphore_loop is not loop
        or loop.is_closed()
    ):
        RouterState.api_semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
        RouterState.api_semaphore_loop = loop

    semaphore = RouterState.api_semaphore
    if semaphore is None:
        semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
        RouterState.api_semaphore = semaphore
        RouterState.api_semaphore_loop = loop

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
            client = await get_shared_router()
            result = await client.route(
                [from_xy, to_xy],
                timeout_s=request_timeout,
            )
    except ExternalServiceException:
        logger.exception("Routing error")
        return None
    except Exception:
        logger.exception("Unexpected error fetching bridge route")
        return None

    geometry = result.get("geometry") if isinstance(result, dict) else None
    coords = geometry.get("coordinates") if geometry else []
    if coords:
        distance_m = result.get("distance_meters", 0) if isinstance(result, dict) else 0
        duration_s = (
            result.get("duration_seconds", 0) if isinstance(result, dict) else 0
        )
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

    logger.warning("No route found by routing API")
    return None
