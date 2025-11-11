import asyncio
import functools
import json
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

EARTH_RADIUS_METERS = 6371000.0
EARTH_RADIUS_MILES = 3958.8
EARTH_RADIUS_KM = 6371.0

T = TypeVar("T")

# NOTE: Consider migrating to httpx in the future for simpler session lifecycle
# management. httpx provides better support for both sync and async operations
# and eliminates the need for complex PID tracking across process boundaries.

_SESSION: aiohttp.ClientSession | None = None
_SESSION_OWNER_PID: int | None = None


async def get_session() -> aiohttp.ClientSession:
    """Get or create a shared aiohttp ClientSession.

    This function creates a per-process session and handles fork scenarios
    cleanly. Sessions are not shared across processes to avoid concurrency
    issues.
    """
    global _SESSION, _SESSION_OWNER_PID

    current_pid = os.getpid()

    # Handle fork scenario: close inherited session from parent process
    if _SESSION is not None and current_pid != _SESSION_OWNER_PID:
        try:
            if not _SESSION.closed:
                await _SESSION.close()
            logger.debug(
                "Closed inherited session from parent process %s in child process %s",
                _SESSION_OWNER_PID,
                current_pid,
            )
        except Exception as e:
            logger.warning(
                "Failed to close inherited session: %s",
                e,
                exc_info=False,
            )
        finally:
            _SESSION = None
            _SESSION_OWNER_PID = None

    # Create new session if needed
    if _SESSION is None or _SESSION.closed:
        timeout = aiohttp.ClientTimeout(total=30, connect=10, sock_read=20)
        headers = {
            "User-Agent": "EveryStreet/1.0",
            "Accept": "application/json",
        }
        connector = aiohttp.TCPConnector(
            limit=20,
            force_close=False,
            enable_cleanup_closed=True,
        )
        _SESSION = aiohttp.ClientSession(
            timeout=timeout,
            headers=headers,
            connector=connector,
        )
        _SESSION_OWNER_PID = current_pid
        logger.debug("Created new aiohttp session for process %s", current_pid)

    return _SESSION


async def cleanup_session():
    """Close the shared session for the current process."""
    global _SESSION, _SESSION_OWNER_PID

    if _SESSION and not _SESSION.closed:
        await _SESSION.close()
        logger.info("Closed aiohttp session for process %s", os.getpid())
    _SESSION = None
    _SESSION_OWNER_PID = None


def retry_async(
    max_retries=3,
    retry_delay=1.0,
    backoff_factor=2.0,
    retry_exceptions=(
        ClientConnectorError,
        ClientResponseError,
        ServerDisconnectedError,
        ClientError,
        asyncio.TimeoutError,
    ),
):
    """Decorator for retrying async functions on specified exceptions."""

    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            last_exception = None
            delay = retry_delay

            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except retry_exceptions as e:
                    last_exception = e
                    if attempt < max_retries:
                        logger.warning(
                            "Retry %d/%d for %s: %s. Retrying in %.2fs",
                            attempt + 1,
                            max_retries,
                            func.__name__,
                            e,
                            delay,
                        )
                        await asyncio.sleep(delay)
                        delay *= backoff_factor
                    else:
                        logger.error(
                            "Failed after %d retries: %s",
                            max_retries,
                            func.__name__,
                        )
                        raise

            if last_exception:
                raise last_exception
            return None

        return wrapper

    return decorator


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


def validate_trip_data(
    trip: dict[str, Any],
) -> tuple[bool, str | None]:
    """Validate that a trip dictionary contains the required fields."""
    required = [
        "transactionId",
        "startTime",
        "endTime",
        "gps",
    ]
    for field in required:
        if field not in trip:
            return (
                False,
                f"Missing required field: {field}",
            )

    gps_data = trip["gps"]
    try:
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)

        if "type" not in gps_data or "coordinates" not in gps_data:
            return (
                False,
                "GPS data missing 'type' or 'coordinates'",
            )

        if not isinstance(gps_data["coordinates"], list):
            return (
                False,
                "GPS coordinates must be a list",
            )

        if len(gps_data["coordinates"]) < 2:
            return (
                False,
                "GPS coordinates must have at least 2 points",
            )

    except json.JSONDecodeError:
        return False, "Invalid GPS data format"
    except Exception as e:
        return (
            False,
            f"Error validating GPS data: {e}",
        )

    return True, None


def standardize_and_validate_gps(
    gps_input: Any,
    transaction_id: str | None = None,
) -> dict[str, Any] | None:
    """Standardize arbitrary GPS input into GeoJSON and validate ranges.

    Accepts a JSON string, list of coordinate pairs, or a GeoJSON dict and
    returns a validated GeoJSON Point or LineString. Returns None if invalid.

    Args:
        gps_input: Raw GPS input (str | list | dict)
        transaction_id: Optional id for contextual logging

    Returns:
        GeoJSON dict or None.
    """
    processed_coords: list[list[float]] = []

    def _log_warning(msg: str, *args: Any):
        if transaction_id is not None:
            if args:
                logger.warning("Trip %s: " + msg, transaction_id, *args)
            else:
                logger.warning("Trip %s: %s", transaction_id, msg)
        else:
            logger.warning(msg, *args)

    def _log_debug(msg: str, *args: Any):
        if transaction_id is not None:
            if args:
                logger.debug("Trip %s: " + msg, transaction_id, *args)
            else:
                logger.debug("Trip %s: %s", transaction_id, msg)
        else:
            logger.debug(msg, *args)

    if isinstance(gps_input, str):
        try:
            gps_data = json.loads(gps_input)
        except json.JSONDecodeError:
            _log_warning("Invalid JSON string in GPS data")
            return None
    elif isinstance(gps_input, list | dict):
        gps_data = gps_input
    else:
        _log_warning("GPS data is of unexpected type: %s", type(gps_input).__name__)
        return None

    if isinstance(gps_data, list):
        raw_coords = gps_data
    elif isinstance(gps_data, dict):
        if (
            gps_data.get("type") in ["Point", "LineString"]
            and "coordinates" in gps_data
        ):
            raw_coords = gps_data.get("coordinates")
            if gps_data["type"] == "Point":
                if (
                    isinstance(raw_coords, list)
                    and len(raw_coords) == 2
                    and all(isinstance(c, int | float) for c in raw_coords)
                ):
                    raw_coords = [raw_coords]
                else:
                    _log_warning("GPS data (dict, Point) has invalid coordinates")
                    return None
        else:
            _log_warning(
                "GPS data (dict) is not a valid GeoJSON Point or LineString",
            )
            return None
    else:
        _log_warning("GPS data structure not recognized")
        return None

    if not isinstance(raw_coords, list):
        _log_warning("Parsed GPS coordinates are not a list: %s", raw_coords)
        return None

    for coord_pair in raw_coords:
        if (
            isinstance(coord_pair, list)
            and len(coord_pair) >= 2
            and all(isinstance(c, int | float) for c in coord_pair[:2])
        ):
            lon, lat = coord_pair[0], coord_pair[1]
            if -180 <= lon <= 180 and -90 <= lat <= 90:
                processed_coords.append([lon, lat])
            else:
                _log_warning("Coordinate out of bounds: [%s, %s]", lon, lat)
        else:
            _log_debug("Skipping invalid coordinate pair: %s", coord_pair)

    if not processed_coords:
        # Reduce noise for common invalid GPS cases
        if transaction_id is not None:
            logger.debug(
                "Trip %s: No valid coordinate pairs found after validation.",
                transaction_id,
            )
        else:
            logger.debug("No valid coordinate pairs found after validation.")
        return None

    unique_coords: list[list[float]] = []
    for coord in processed_coords:
        if not unique_coords or coord != unique_coords[-1]:
            unique_coords.append(coord)

    if len(unique_coords) == 1:
        return {"type": "Point", "coordinates": unique_coords[0]}
    return {"type": "LineString", "coordinates": unique_coords}


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


def haversine(
    lon1: float,
    lat1: float,
    lon2: float,
    lat2: float,
    unit: str = "meters",
) -> float:
    """Calculate the great-circle distance between two points."""
    lon1, lat1, lon2, lat2 = map(math.radians, [lon1, lat1, lon2, lat2])

    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    if unit == "meters":
        radius = EARTH_RADIUS_METERS
    elif unit == "miles":
        radius = EARTH_RADIUS_MILES
    elif unit == "km":
        radius = EARTH_RADIUS_KM
    else:
        raise ValueError(
            "Invalid unit specified. Use 'meters', 'miles', or 'km'.",
        )

    distance = radius * c
    return distance


def meters_to_miles(meters: float) -> float:
    """Convert meters to miles."""
    return meters / 1609.34


def calculate_distance(
    coordinates: list[list[float]],
) -> float:
    """Calculate the total distance of a trip from a list of [lng, lat]
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
            total_distance_meters += haversine(
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
    from synchronous Celery tasks without encountering 'Event loop is closed' errors.
    It gets the current thread's loop or creates one if needed, and runs the
    coroutine until completion using loop.run_until_complete. Unlike asyncio.run(),
    it doesn't close the loop afterwards, allowing libraries like motor to
    clean up properly.

    Args:
        coro: The awaitable coroutine to execute.

    Returns:
        The result of the coroutine.

    """
    try:
        loop = asyncio.get_event_loop_policy().get_event_loop()
        logger.debug(
            "Reusing existing event loop for sync-to-async execution.",
        )
    except RuntimeError:
        logger.debug(
            "No event loop found, creating a new one for sync-to-async execution.",
        )
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    if loop.is_closed():
        logger.warning("Event loop was closed. Creating a new one.")
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
