import asyncio
import functools
import json
import logging
import math
from typing import Any, Dict, Optional, Tuple, TypeVar

import aiohttp
from aiohttp import ClientConnectorError, ClientResponseError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Earth radius constants
EARTH_RADIUS_METERS = 6371000.0
EARTH_RADIUS_MILES = 3958.8
EARTH_RADIUS_KM = 6371.0

# Type for retry decorator
T = TypeVar("T")

# Shared session
_SESSION: Optional[aiohttp.ClientSession] = None
_SESSION_LOCK = asyncio.Lock()


async def get_session() -> aiohttp.ClientSession:
    """Get or create a shared aiohttp ClientSession."""
    global _SESSION

    async with _SESSION_LOCK:
        if _SESSION is None or _SESSION.closed:
            timeout = aiohttp.ClientTimeout(total=30, connect=10, sock_read=20)
            headers = {
                "User-Agent": "EveryStreet/1.0",
                "Accept": "application/json",
            }
            connector = aiohttp.TCPConnector(
                limit=20,  # Connection pool size
                force_close=False,  # Keep-alive
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
    retry_exceptions=(ClientConnectorError, ClientResponseError, asyncio.TimeoutError),
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
                            "Failed after %d retries: %s", max_retries, func.__name__
                        )
                        raise

            if last_exception:
                raise last_exception

        return wrapper

    return decorator


@retry_async()
async def validate_location_osm(
    location: str, locationType: str
) -> Optional[Dict[str, Any]]:
    """Validate a location using the OSM Nominatim search API."""
    params = {
        "q": location,
        "format": "json",
        "limit": 1,
        "featuretype": locationType,
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
            logger.error("HTTP %s error validating location", response.status)
            return None
    except Exception as e:
        logger.error("Error validating location: %s", e)
        raise


def validate_trip_data(trip: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """Validate that a trip dictionary contains the required fields."""
    # Check required fields
    required = ["transactionId", "startTime", "endTime", "gps"]
    for field in required:
        if field not in trip:
            return False, f"Missing required field: {field}"

    # Validate GPS data
    gps_data = trip["gps"]
    try:
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)

        if "type" not in gps_data or "coordinates" not in gps_data:
            return False, "GPS data missing 'type' or 'coordinates'"

        if not isinstance(gps_data["coordinates"], list):
            return False, "GPS coordinates must be a list"

        if len(gps_data["coordinates"]) < 2:
            return False, "GPS coordinates must have at least 2 points"

    except json.JSONDecodeError:
        return False, "Invalid GPS data format"
    except Exception as e:
        return False, f"Error validating GPS data: {e}"

    return True, None


@retry_async(max_retries=3, retry_delay=2.0)
async def reverse_geocode_nominatim(lat: float, lon: float) -> Optional[Dict[str, Any]]:
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
        elif response.status == 429:  # Rate limit
            retry_after = int(response.headers.get("Retry-After", 5))
            raise ClientResponseError(
                request_info=response.request_info,
                history=response.history,
                status=429,
                message=f"Rate limited. Retry after {retry_after}s",
            )
        else:
            logger.warning("Geocoding error: status code %d", response.status)
            return None


def haversine(
    lon1: float, lat1: float, lon2: float, lat2: float, unit: str = "meters"
) -> float:
    """Calculate the great-circle distance between two points."""
    # Convert to radians
    lon1_rad = math.radians(lon1)
    lat1_rad = math.radians(lat1)
    lon2_rad = math.radians(lon2)
    lat2_rad = math.radians(lat2)

    # Haversine formula
    dlon = lon2_rad - lon1_rad
    dlat = lat2_rad - lat1_rad
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    # Choose radius based on unit
    if unit == "miles":
        radius = EARTH_RADIUS_MILES
    elif unit == "km":
        radius = EARTH_RADIUS_KM
    else:  # meters
        radius = EARTH_RADIUS_METERS

    return radius * c
