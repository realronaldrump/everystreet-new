"""Utility functions for async operations, HTTP sessions, and common helpers.

This module provides:
- Shared aiohttp session management
- Retry decorators for async functions
- Geocoding utilities
- Distance calculations
- Async-to-sync bridge for Celery tasks
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import statistics
from collections.abc import Coroutine
from typing import Any, TypeVar

import aiohttp
from aiohttp import (
    ClientConnectorError,
    ClientError,
    ClientResponseError,
    ServerDisconnectedError,
)
from constants import (
    HTTP_CONNECTION_LIMIT,
    HTTP_TIMEOUT_CONNECT,
    HTTP_TIMEOUT_SOCK_READ,
    HTTP_TIMEOUT_TOTAL,
    METERS_TO_MILES,
)
from tenacity import (
    before_sleep_log,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from geometry_service import GeometryService

logger = logging.getLogger(__name__)

T = TypeVar("T")


class SessionState:
    """State container for aiohttp session to avoid global variables."""

    session: aiohttp.ClientSession | None = None
    session_owner_pid: int | None = None


async def get_session() -> aiohttp.ClientSession:
    """Get or create a shared aiohttp ClientSession.

    This function creates a per-process session and handles fork scenarios
    cleanly. Sessions are not shared across processes to avoid concurrency
    issues.
    """
    current_pid = os.getpid()

    # Handle fork scenario: close inherited session from parent process
    if (
        SessionState.session is not None
        and current_pid != SessionState.session_owner_pid
    ):
        try:
            logger.debug(
                "Discarding inherited session from parent process %s in child process %s",
                SessionState.session_owner_pid,
                current_pid,
            )
        except Exception as e:
            logger.warning(
                "Failed to discard inherited session: %s",
                e,
                exc_info=False,
            )
        finally:
            SessionState.session = None
            SessionState.session_owner_pid = None

    # Check for loop mismatch or closed loop
    if SessionState.session is not None:
        try:
            current_loop = asyncio.get_running_loop()
            if (
                SessionState.session.loop != current_loop
                or SessionState.session.loop.is_closed()
            ):
                logger.info(
                    "Detected event loop change. Creating new session.",
                )
                try:
                    if (
                        not SessionState.session.closed
                        and not SessionState.session.loop.is_closed()
                    ):
                        await SessionState.session.close()
                except Exception as e:
                    logger.warning("Error closing stale session: %s", e)
                SessionState.session = None
        except RuntimeError:
            # No running loop? Should not happen in get_session normally.
            pass

    # Create new session if needed
    if SessionState.session is None or SessionState.session.closed:
        timeout = aiohttp.ClientTimeout(
            total=HTTP_TIMEOUT_TOTAL,
            connect=HTTP_TIMEOUT_CONNECT,
            sock_read=HTTP_TIMEOUT_SOCK_READ,
        )
        headers = {
            "User-Agent": "EveryStreet/1.0",
            "Accept": "application/json",
        }
        connector = aiohttp.TCPConnector(
            limit=HTTP_CONNECTION_LIMIT,
            force_close=False,
            enable_cleanup_closed=True,
        )
        SessionState.session = aiohttp.ClientSession(
            timeout=timeout,
            headers=headers,
            connector=connector,
        )
        SessionState.session_owner_pid = current_pid
        logger.debug("Created new aiohttp session for process %s", current_pid)

    return SessionState.session


async def cleanup_session():
    """Close the shared session for the current process."""
    if SessionState.session and not SessionState.session.closed:
        try:
            await SessionState.session.close()
            logger.info("Closed aiohttp session for process %s", os.getpid())
        except Exception as e:
            logger.warning("Error closing session: %s", e)

    SessionState.session = None
    SessionState.session_owner_pid = None


def retry_async(
    max_retries: int = 3,
    retry_delay: float = 1.0,
    backoff_factor: float = 2.0,
    retry_exceptions: tuple = (
        ClientConnectorError,
        ClientResponseError,
        ServerDisconnectedError,
        ClientError,
        asyncio.TimeoutError,
    ),
):
    """Factory that returns a tenacity retry decorator configured with provided parameters.

    Args:
        max_retries: Maximum number of retry attempts (in addition to the first attempt).
        retry_delay: Initial delay between retries in seconds (used as multiplier).
        backoff_factor: Exponential backoff base for increasing delay between retries.
        retry_exceptions: Tuple of exception types that should trigger a retry.

    Returns:
        A tenacity retry decorator configured with the specified parameters.
    """
    return retry(
        # stop_after_attempt includes the first attempt, so add 1 to match original logic
        stop=stop_after_attempt(max_retries + 1),
        # Configure exponential backoff: wait = multiplier * (exp_base ** attempt)
        wait=wait_exponential(multiplier=retry_delay, exp_base=backoff_factor),
        # Filter specific exceptions that should trigger retry
        retry=retry_if_exception_type(retry_exceptions),
        # Log before each sleep using the module logger
        before_sleep=before_sleep_log(logger, logging.WARNING),
        # Ensure the last exception is re-raised if all retries fail
        reraise=True,
    )


@retry_async()
async def validate_location_osm(
    location: str,
    locationType: str,
) -> dict[str, Any] | None:
    """Validate a location using the OSM Nominatim search API."""
    params = {
        "q": location,
        "format": "json",
        "limit": 1,
        "featuretype": locationType,
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
    """Reverse geocode coordinates using OSM Nominatim."""
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
    """Reverse geocode coordinates using Mapbox Geocoding API."""
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


def meters_to_miles(meters: float) -> float:
    """Convert meters to miles.

    Note: For new code, prefer importing from constants module directly.
    """
    return meters * METERS_TO_MILES


def calculate_distance(
    coordinates: list[list[float]],
) -> float:
    """Calculate the total distance of a trip from a list of [lng, lat].

    coordinates.

    Args:
        coordinates: List of [longitude, latitude] coordinate pairs

    Returns:
        Total distance in miles
    """
    total_distance_meters = 0.0
    coords: list[list[float]] = coordinates if isinstance(coordinates, list) else []

    if not coords or not isinstance(coords[0], list):
        logger.warning("Invalid coordinates format for distance calculation.")
        return 0.0

    for i in range(len(coords) - 1):
        try:
            lon1, lat1 = coords[i]
            lon2, lat2 = coords[i + 1]
            total_distance_meters += GeometryService.haversine_distance(
                lon1,
                lat1,
                lon2,
                lat2,
                unit="meters",
            )
        except (
            TypeError,
            ValueError,
            IndexError,
        ) as e:
            logger.warning(
                "Skipping coordinate pair due to error: %s - Pair: %s, %s",
                e,
                coords[i],
                (coords[i + 1] if i + 1 < len(coords) else "N/A"),
            )
            continue

    return meters_to_miles(total_distance_meters)


def run_async_from_sync(
    coro: Coroutine[Any, Any, T],
) -> T:
    """Runs an async coroutine from a synchronous context, managing the event loop.

    This is crucial for calling async functions (like motor operations)
    from synchronous Celery tasks without encountering 'Event loop is closed' errors
    or 'Future attached to a different loop' errors.

    To avoid event loop conflicts with Motor (MongoDB async driver), this function:
    1. Always creates a fresh event loop for each call
    2. Properly cleans up the loop after execution
    3. Clears the thread-local event loop reference

    Args:
        coro: The awaitable coroutine to execute.

    Returns:
        The result of the coroutine.
    """
    # Always create a fresh loop to ensure isolation from any existing loop
    # This prevents "attached to a different loop" errors with Motor
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    except Exception:
        logger.error(
            "Exception occurred during run_until_complete",
            exc_info=True,
        )
        raise
    finally:
        try:
            # Cancel any pending tasks
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            # Allow cancelled tasks to complete
            if pending:
                loop.run_until_complete(
                    asyncio.gather(*pending, return_exceptions=True)
                )

            # Cleanup the session associated with this loop
            loop.run_until_complete(cleanup_session())

            loop.close()
        except Exception as e:
            logger.warning("Error during event loop cleanup: %s", e)
        finally:
            # Clear thread-local loop reference to avoid stale references
            asyncio.set_event_loop(None)


def calculate_circular_average_hour(
    hours_list: list[float],
) -> float:
    """Calculates the circular average of a list of hours (0-23)."""
    if not hours_list:
        return 0.0
    angles = [(h / 24.0) * 2 * math.pi for h in hours_list]
    avg_sin = statistics.mean([math.sin(angle) for angle in angles])
    avg_cos = statistics.mean([math.cos(angle) for angle in angles])
    avg_angle = math.atan2(avg_sin, avg_cos)
    avg_hour = (avg_angle / (2 * math.pi)) * 24.0
    return (avg_hour + 24.0) % 24.0
