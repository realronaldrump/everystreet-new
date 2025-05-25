import asyncio
import functools
import json
import logging
import math
import statistics
from collections.abc import Coroutine
from functools import lru_cache
from time import perf_counter
from typing import Any, TypeVar

import aiohttp
from aiohttp import ClientConnectorError, ClientResponseError

# Configure logging once at module level
logger = logging.getLogger(__name__)

# Constants
EARTH_RADIUS_METERS = 6371000.0
EARTH_RADIUS_MILES = 3958.8
EARTH_RADIUS_KM = 6371.0
METERS_TO_MILES_FACTOR = 1609.34

# Pre-computed conversion factors for better performance
RADIANS_PER_DEGREE = math.pi / 180.0
DEGREES_PER_RADIAN = 180.0 / math.pi

T = TypeVar("T")

# Global session management
_SESSION: aiohttp.ClientSession | None = None
_SESSION_LOCK = asyncio.Lock()

# Performance tracking
_performance_metrics = {
    "coordinate_validations": 0,
    "distance_calculations": 0,
    "geocoding_requests": 0,
}


async def get_session() -> aiohttp.ClientSession:
    """Get or create a shared aiohttp ClientSession with optimized settings."""
    global _SESSION

    async with _SESSION_LOCK:
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
            logger.debug("Created new aiohttp session")

        return _SESSION


async def cleanup_session():
    """Close the shared session."""
    global _SESSION

    async with _SESSION_LOCK:
        if _SESSION and not _SESSION.closed:
            await _SESSION.close()
            _SESSION = None
            logger.info("Closed aiohttp session")


def retry_async(
    max_retries=3,
    retry_delay=1.0,
    backoff_factor=2.0,
    retry_exceptions=(
        ClientConnectorError,
        ClientResponseError,
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

        return wrapper

    return decorator


@retry_async()
async def validate_location_osm(
    location: str,
    location_type: str,
) -> dict[str, Any] | None:
    """Validate a location using the OSM Nominatim search API."""
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


@lru_cache(maxsize=1000)
def _validate_coordinate_pair(lon: float, lat: float) -> bool:
    """Fast coordinate validation with caching."""
    return -180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0


def validate_trip_data(trip: dict[str, Any]) -> tuple[bool, str | None]:
    """Validate that a trip dictionary contains the required fields.

    Optimized validation with early returns and consolidated GPS validation.
    """
    global _performance_metrics
    _performance_metrics["coordinate_validations"] += 1

    required_fields = ("transactionId", "startTime", "endTime", "gps")

    # Check required fields using set intersection for faster lookup
    trip_keys = set(trip.keys())
    missing_fields = set(required_fields) - trip_keys
    if missing_fields:
        return False, f"Missing required fields: {', '.join(missing_fields)}"

    # Validate GPS data
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)

        # Combined GPS validation checks
        if (
            not isinstance(gps_data, dict)
            or "type" not in gps_data
            or "coordinates" not in gps_data
        ):
            return False, "GPS data missing 'type' or 'coordinates'"

        coordinates = gps_data["coordinates"]
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            return (
                False,
                "GPS coordinates must be a list with at least 2 points",
            )

        # Fast coordinate validation
        for i, coord in enumerate(coordinates[:10]):  # Sample first 10 for performance
            if not isinstance(coord, list) or len(coord) < 2:
                return False, f"Invalid coordinate format at index {i}"
            if not _validate_coordinate_pair(coord[0], coord[1]):
                return False, f"Invalid coordinate values at index {i}"

    except json.JSONDecodeError:
        return False, "Invalid GPS data format"
    except Exception as e:
        return False, f"Error validating GPS data: {e}"

    return True, None


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
        logger.warning("Geocoding error: status code %d", response.status)
        return None


@lru_cache(maxsize=2000)
def haversine(
    lon1: float,
    lat1: float,
    lon2: float,
    lat2: float,
    unit: str = "meters",
) -> float:
    """Calculate the great-circle distance between two points.

    Optimized with caching and pre-computed constants.
    """
    global _performance_metrics
    _performance_metrics["distance_calculations"] += 1

    # Early return for identical points
    if lon1 == lon2 and lat1 == lat2:
        return 0.0

    # Pre-computed radius lookup
    radius_map = {
        "meters": EARTH_RADIUS_METERS,
        "miles": EARTH_RADIUS_MILES,
        "km": EARTH_RADIUS_KM,
    }

    radius = radius_map.get(unit)
    if radius is None:
        raise ValueError("Invalid unit. Use 'meters', 'miles', or 'km'.")

    # Convert to radians using pre-computed factor
    lon1_rad = lon1 * RADIANS_PER_DEGREE
    lat1_rad = lat1 * RADIANS_PER_DEGREE
    lon2_rad = lon2 * RADIANS_PER_DEGREE
    lat2_rad = lat2 * RADIANS_PER_DEGREE

    # Haversine formula optimized
    dlon = lon2_rad - lon1_rad
    dlat = lat2_rad - lat1_rad

    # Pre-compute sin values
    sin_dlat_2 = math.sin(dlat * 0.5)
    sin_dlon_2 = math.sin(dlon * 0.5)

    a = (
        sin_dlat_2 * sin_dlat_2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * sin_dlon_2 * sin_dlon_2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))

    return radius * c


def meters_to_miles(meters: float) -> float:
    """Convert meters to miles using precomputed factor."""
    return meters / METERS_TO_MILES_FACTOR


def calculate_distance(coordinates: list[list[float]]) -> float:
    """Calculate the total distance of a trip from coordinate pairs.

    Optimized with early validation, vectorized operations, and caching.

    Args:
        coordinates: List of [longitude, latitude] coordinate pairs

    Returns:
        Total distance in miles
    """
    if not coordinates or not isinstance(coordinates, list):
        logger.warning("Invalid or empty coordinates for distance calculation.")
        return 0.0

    coord_count = len(coordinates)
    if coord_count < 2:
        return 0.0

    # Validate first coordinate to check structure
    if not isinstance(coordinates[0], list) or len(coordinates[0]) < 2:
        logger.warning("Invalid coordinates format for distance calculation.")
        return 0.0

    total_distance_meters = 0.0
    valid_pairs = 0

    # Batch process coordinates for better performance
    for i in range(coord_count - 1):
        try:
            coord1 = coordinates[i]
            coord2 = coordinates[i + 1]

            # Fast validation and extraction
            if (
                len(coord1) >= 2
                and len(coord2) >= 2
                and isinstance(coord1[0], (int, float))
                and isinstance(coord1[1], (int, float))
                and isinstance(coord2[0], (int, float))
                and isinstance(coord2[1], (int, float))
            ):

                lon1, lat1 = coord1[0], coord1[1]
                lon2, lat2 = coord2[0], coord2[1]

                # Skip identical consecutive points for performance
                if lon1 != lon2 or lat1 != lat2:
                    distance = haversine(lon1, lat1, lon2, lat2, unit="meters")
                    total_distance_meters += distance
                    valid_pairs += 1

        except (TypeError, ValueError, IndexError) as e:
            logger.warning(
                "Skipping coordinate pair %d due to error: %s",
                i,
                e,
            )
            continue

    # Log performance metrics periodically
    if valid_pairs > 0 and valid_pairs % 100 == 0:
        logger.debug(
            f"Processed {valid_pairs} coordinate pairs in distance calculation"
        )

    return meters_to_miles(total_distance_meters)


def run_async_from_sync(coro: Coroutine[Any, Any, T]) -> T:
    """Run async coroutine from sync context with proper loop management.

    Optimized loop handling for Celery tasks and other sync contexts.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # If loop is running, we need to run in a new thread
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(asyncio.run, coro)
                return future.result()
        else:
            logger.debug("Reusing existing event loop for sync-to-async execution.")
    except RuntimeError:
        logger.debug("No event loop found, creating new one.")
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    if loop.is_closed():
        logger.warning("Event loop was closed. Creating a new one.")
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    try:
        return loop.run_until_complete(coro)
    except Exception:
        logger.error("Exception occurred during run_until_complete", exc_info=True)
        raise


def calculate_circular_average_hour(hours_list: list[float]) -> float:
    """Calculate the circular average of hours (0-23).

    Optimized with early return and vectorized operations.
    """
    if not hours_list:
        return 0.0

    if len(hours_list) == 1:
        return hours_list[0]

    # Convert hours to radians and calculate trigonometric averages
    factor = (2.0 * math.pi) / 24.0
    angles = [h * factor for h in hours_list]
    avg_sin = statistics.mean(math.sin(angle) for angle in angles)
    avg_cos = statistics.mean(math.cos(angle) for angle in angles)

    # Convert back to hours
    avg_angle = math.atan2(avg_sin, avg_cos)
    avg_hour = avg_angle / factor

    return (avg_hour + 24.0) % 24.0


def get_performance_metrics() -> dict[str, Any]:
    """Get current performance metrics for monitoring optimization effectiveness."""
    return {
        **_performance_metrics,
        "session_cache_size": _get_session_cache_info(),
        "coordinate_cache_size": (
            _validate_coordinate_pair.cache_info()
            if hasattr(_validate_coordinate_pair, "cache_info")
            else {}
        ),
        "haversine_cache_size": (
            haversine.cache_info() if hasattr(haversine, "cache_info") else {}
        ),
    }


def reset_performance_metrics() -> None:
    """Reset performance counters."""
    global _performance_metrics
    _performance_metrics = {
        "coordinate_validations": 0,
        "distance_calculations": 0,
        "geocoding_requests": 0,
    }


def _get_session_cache_info() -> dict[str, Any]:
    """Get aiohttp session cache information."""
    global _SESSION
    if _SESSION and not _SESSION.closed:
        return {
            "session_active": True,
            "connector_limit": getattr(_SESSION._connector, "_limit", "unknown"),
        }
    return {"session_active": False}
