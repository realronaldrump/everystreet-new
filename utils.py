import json
import asyncio
import logging
from typing import Optional, Tuple, Dict, Any, TypeVar, Callable, Awaitable
import time
import functools
from contextlib import asynccontextmanager
import math

import aiohttp
from aiohttp import ClientConnectorError, ClientResponseError, TCPConnector
from geojson import loads as geojson_loads


logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Session configuration
SESSION_TIMEOUT = aiohttp.ClientTimeout(
    total=10, connect=5, sock_connect=5, sock_read=5
)

# Type for retry decorator
T = TypeVar("T")

# Constants for Earth radius in different units
EARTH_RADIUS_METERS = 6371000.0
EARTH_RADIUS_MILES = 3958.8
EARTH_RADIUS_KM = 6371.0


class BaseConnectionManager:
    """Base class for all connection/session management classes"""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def cleanup(self):
        """Method to cleanup resources - to be implemented by subclasses"""
        pass


class SessionManager(BaseConnectionManager):
    _session: Optional[aiohttp.ClientSession] = None
    _lock = asyncio.Lock()
    _cleanup_event = asyncio.Event()
    _last_activity = time.time()
    _idle_timeout = 300  # 5 minutes
    _maintenance_task = None
    _connector = None

    def __init__(self):
        self._headers = {
            "User-Agent": "EveryStreet/1.0 (myapp@example.com)",
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
        }

    async def get_session(self) -> aiohttp.ClientSession:
        """Get or create a shared aiohttp ClientSession."""
        async with self._lock:
            # Create a new session if needed
            if self._session is None or self._session.closed:
                logger.debug("Creating new aiohttp ClientSession")
                # Create connector with proper configuration
                self._connector = TCPConnector(
                    limit=20,  # Maximum number of connections
                    limit_per_host=8,  # Maximum number of connections per host
                    force_close=False,  # More efficient connection reuse
                    enable_cleanup_closed=True,  # Clean up closed connections
                    keepalive_timeout=30,  # Keep connections alive for 30 seconds
                )

                self._session = aiohttp.ClientSession(
                    connector=self._connector,
                    timeout=SESSION_TIMEOUT,
                    headers=self._headers,
                )

                # Start maintenance task if not running
                if self._maintenance_task is None or self._maintenance_task.done():
                    self._maintenance_task = asyncio.create_task(
                        self._session_maintenance()
                    )
                    self._maintenance_task.add_done_callback(
                        self._maintenance_done_callback
                    )

            # Update last activity time
            self._last_activity = time.time()
            return self._session

    def _maintenance_done_callback(self, future):
        """Handle any exceptions in the maintenance task."""
        try:
            future.result()
        except Exception as e:
            logger.error(f"Session maintenance task failed: {e}", exc_info=True)

    async def _session_maintenance(self):
        """
        Maintenance task that periodically checks for idle sessions
        and cleans them up to prevent resource leakage.
        """
        try:
            while True:
                await asyncio.sleep(60)  # Check every minute

                # Don't close if recently active
                if time.time() - self._last_activity < self._idle_timeout:
                    continue

                # Close idle session
                await self.cleanup("Session idle timeout reached")
        except asyncio.CancelledError:
            logger.debug("Session maintenance task cancelled")
        except Exception as e:
            logger.error(f"Error in session maintenance: {e}", exc_info=True)
            raise

    async def cleanup(self, reason="Manual cleanup"):
        """
        Properly cleanup the session and all related resources.
        """
        async with self._lock:
            if self._session and not self._session.closed:
                logger.info(f"Closing aiohttp ClientSession. Reason: {reason}")

                # Cancel the maintenance task first
                if self._maintenance_task and not self._maintenance_task.done():
                    self._maintenance_task.cancel()
                    try:
                        await self._maintenance_task
                    except asyncio.CancelledError:
                        pass

                # Close the session
                try:
                    await self._session.close()
                    # Wait a short time for connections to actually close
                    await asyncio.sleep(0.25)
                except Exception as e:
                    logger.error(f"Error closing session: {e}", exc_info=True)

                self._session = None

                # Close the connector if it exists
                if self._connector and not self._connector.closed:
                    await self._connector.close()
                    self._connector = None

                logger.debug("Session cleanup complete")


@asynccontextmanager
async def get_session_ctx():
    """
    Context manager for getting a session, ensuring proper cleanup.
    Usage:
        async with get_session_ctx() as session:
            async with session.get(...) as response:
                ...
    """
    session_manager = SessionManager()
    try:
        session = await session_manager.get_session()
        yield session
    finally:
        # We don't close the session here, as it's managed by SessionManager
        pass


# Create a singleton instance
session_manager = SessionManager()


async def get_session() -> aiohttp.ClientSession:
    """Get or create a shared aiohttp ClientSession."""
    return await session_manager.get_session()


async def cleanup_session():
    """Cleanup the global session."""
    await session_manager.cleanup()


def retry_async(
    max_retries=3,
    retry_delay=1.0,
    backoff_factor=2.0,
    retry_exceptions=(ClientConnectorError, ClientResponseError, asyncio.TimeoutError),
):
    """
    Decorator for async functions to retry on specified exceptions.

    Args:
        max_retries: Maximum number of retry attempts
        retry_delay: Initial delay between retries in seconds
        backoff_factor: Multiplier for delay after each retry
        retry_exceptions: Tuple of exceptions that should trigger a retry

    Returns:
        Decorated function that implements retry logic
    """

    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            last_exception = None
            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except retry_exceptions as e:
                    last_exception = e
                    if attempt < max_retries:
                        # Calculate delay with exponential backoff and jitter
                        delay = retry_delay * (backoff_factor**attempt)
                        jitter = delay * 0.1 * (2 * (0.5 - 0.5))  # Add up to 10% jitter
                        wait_time = delay + jitter

                        logger.warning(
                            f"Retry {attempt+1}/{max_retries} for {func.__name__}: {e}. "
                            f"Retrying in {wait_time:.2f}s"
                        )
                        await asyncio.sleep(wait_time)
                    else:
                        logger.error(
                            f"Failed after {max_retries} retries: {func.__name__}: {e}"
                        )
                        raise

            # This should not be reached, but just in case
            if last_exception:
                raise last_exception

        return wrapper

    return decorator


@retry_async()
async def validate_location_osm(
    location: str, location_type: str
) -> Optional[Dict[str, Any]]:
    """
    Asynchronously validate a location using the OSM Nominatim search API.
    Returns the first matching location as a dict or None if no match is found.

    Parameters:
        location (str): The search query for the location.
        location_type (str): The feature type (e.g., "city", "county", etc.).

    Returns:
        dict or None: The first matching location object or None.
    """
    params = {
        "q": location,
        "format": "json",
        "limit": 1,
        "featuretype": location_type,
    }
    headers = {"User-Agent": "EveryStreet-Validator/1.0"}

    async with get_session_ctx() as session:
        try:
            async with session.get(
                "https://nominatim.openstreetmap.org/search",
                params=params,
                headers=headers,
                timeout=SESSION_TIMEOUT,
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    logger.debug(
                        "Received %s results for location '%s'.",
                        len(data),
                        location,
                    )
                    return data[0] if data else None
                logger.error(
                    "HTTP %s error for location '%s'.", response.status, location
                )
                return None
        except Exception as e:
            logger.error(
                "Exception during validate_location_osm for '%s': %s",
                location,
                e,
                exc_info=True,
            )
            raise


def validate_trip_data(trip: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Validate that a trip dictionary contains the required fields.

    Required fields: "transactionId", "startTime", "endTime", and "gps".
    Also verifies that the gps data (after JSON-parsing if needed) contains the keys
    "type" and "coordinates",
    and that "coordinates" is a list.

    Parameters:
        trip (dict): The trip data to validate.

    Returns:
        (bool, Optional[str]): A tuple (is_valid, error_message). If valid,
        error_message is None.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info("Validating trip data for %s...", transaction_id)
    required = ["transactionId", "startTime", "endTime", "gps"]
    for field in required:
        if field not in trip:
            error_message = f"Missing required field: {field}"
            logger.warning(
                "Trip %s validation failed: %s", transaction_id, error_message
            )
            return False, error_message

    logger.debug("All required fields present for trip %s.", transaction_id)
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if "type" not in gps_data or "coordinates" not in gps_data:
            error_message = "gps data missing 'type' or 'coordinates'"
            logger.warning(
                "Trip %s validation failed: %s", transaction_id, error_message
            )
            return False, error_message
        if not isinstance(gps_data["coordinates"], list):
            error_message = "gps['coordinates'] must be a list"
            logger.warning(
                "Trip %s validation failed: %s", transaction_id, error_message
            )
            return False, error_message
        if len(gps_data["coordinates"]) < 2:
            error_message = "gps['coordinates'] must have at least 2 points"
            logger.warning(
                "Trip %s validation failed: %s", transaction_id, error_message
            )
            return False, error_message
        logger.debug("GPS structure valid for trip %s.", transaction_id)
    except json.JSONDecodeError as e:
        error_message = f"Invalid gps data format: {e}"
        logger.warning(
            "Trip %s validation failed: %s",
            transaction_id,
            error_message,
            exc_info=True,
        )
        return False, error_message
    except Exception as e:
        error_message = f"Error validating gps data: {e}"
        logger.error(
            "Error during gps validation for trip %s: %s",
            transaction_id,
            error_message,
            exc_info=True,
        )
        return False, error_message

    logger.info("Trip data validation successful for %s.", transaction_id)
    return True, None


@retry_async(max_retries=3, retry_delay=2.0)
async def reverse_geocode_nominatim(lat: float, lon: float) -> Optional[Dict[str, Any]]:
    """
    Reverse geocode a latitude and longitude using OSM Nominatim.
    Uses retry decorator for automatic retries on network issues.

    Parameters:
        lat (float): The latitude.
        lon (float): The longitude.

    Returns:
        dict or None: The JSON response as a dict if successful; otherwise, None.
    """
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "format": "jsonv2",
        "lat": lat,
        "lon": lon,
        "zoom": 18,
        "addressdetails": 1,
    }

    # Use context manager for proper resource handling
    async with get_session_ctx() as session:
        async with session.get(
            url,
            params=params,
            headers={"User-Agent": "EveryStreet-GeoCoder/1.0"},
            timeout=SESSION_TIMEOUT,
        ) as response:
            if response.status == 200:
                try:
                    data = await response.json()
                    logger.debug(
                        "Reverse geocoded (%s, %s): keys=%s",
                        lat,
                        lon,
                        list(data.keys()),
                    )
                    return data
                except Exception as e:
                    logger.warning("Error parsing JSON response: %s", e)
                    return None
            elif response.status == 429:  # Too Many Requests
                retry_after = int(response.headers.get("Retry-After", 5))
                logger.warning(
                    f"Rate limit exceeded for reverse geocoding. Retry-After: {retry_after}s"
                )
                raise ClientResponseError(
                    request_info=response.request_info,
                    history=response.history,
                    status=429,
                    message=f"Rate limited. Retry after {retry_after}s",
                )
            else:
                logger.warning(
                    f"Unexpected status code in reverse_geocode_nominatim: {response.status}"
                )
                return None


def haversine(
    lon1: float, lat1: float, lon2: float, lat2: float, unit: str = "meters"
) -> float:
    """
    Calculate the great-circle distance between two points on Earth.

    Args:
        lon1: Longitude of the first point in degrees
        lat1: Latitude of the first point in degrees
        lon2: Longitude of the second point in degrees
        lat2: Latitude of the second point in degrees
        unit: Unit of distance ('meters', 'miles', or 'km')

    Returns:
        Distance between the points in the specified unit
    """
    # Convert decimal degrees to radians
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

    # Choose the radius based on the requested unit
    if unit == "miles":
        radius = EARTH_RADIUS_MILES
    elif unit == "km":
        radius = EARTH_RADIUS_KM
    else:  # Default to meters
        radius = EARTH_RADIUS_METERS

    return radius * c
