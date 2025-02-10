import json
import asyncio
import logging
from typing import Optional, Tuple, List, Dict, Any

import aiohttp
from aiohttp import ClientConnectorError, ClientResponseError, TCPConnector
from geojson import loads as geojson_loads
from timezonefinder import TimezoneFinder

# Initialize the TimezoneFinder instance.
tf = TimezoneFinder()

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Create a global connection pool with limits
CONN_POOL = TCPConnector(limit=10, force_close=True,
                         enable_cleanup_closed=True)
SESSION_TIMEOUT = aiohttp.ClientTimeout(
    total=10, connect=5, sock_connect=5, sock_read=5)

# Create a global session for reuse
_session: Optional[aiohttp.ClientSession] = None


async def get_session() -> aiohttp.ClientSession:
    """Get or create a shared aiohttp ClientSession."""
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession(
            connector=CONN_POOL,
            timeout=SESSION_TIMEOUT,
            headers={
                "User-Agent": "EveryStreet/1.0 (myapp@example.com)",
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate",
            }
        )
    return _session


async def cleanup_session():
    """Cleanup the global session."""
    global _session
    if _session and not _session.closed:
        await _session.close()
    _session = None


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
    params = {"q": location, "format": "json",
              "limit": 1, "featuretype": location_type}
    headers = {"User-Agent": "EveryStreet-Validator/1.0"}
    try:
        session = await get_session()
        async with session.get(
            "https://nominatim.openstreetmap.org/search",
            params=params,
            headers=headers,
        ) as response:
            if response.status == 200:
                data = await response.json()
                logger.debug(
                    f"Received {len(data)} results for location '{location}'."
                )
                return data[0] if data else None
            logger.error(
                f"HTTP {response.status} error for location '{location}'.")
            return None
    except Exception as e:
        logger.error(
            f"Exception during validate_location_osm for '{location}': {e}",
            exc_info=True,
        )
        return None


def validate_trip_data(trip: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Validate that a trip dictionary contains the required fields.

    Required fields: "transactionId", "startTime", "endTime", and "gps".
    Also verifies that the gps data (after JSON-parsing if needed) contains the keys "type" and "coordinates",
    and that "coordinates" is a list.

    Parameters:
        trip (dict): The trip data to validate.

    Returns:
        (bool, Optional[str]): A tuple (is_valid, error_message). If valid, error_message is None.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info(f"Validating trip data for {transaction_id}...")
    required = ["transactionId", "startTime", "endTime", "gps"]
    for field in required:
        if field not in trip:
            error_message = f"Missing required field: {field}"
            logger.warning(
                f"Trip {transaction_id} validation failed: {error_message}")
            return False, error_message

    logger.debug(f"All required fields present for trip {transaction_id}.")
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if "type" not in gps_data or "coordinates" not in gps_data:
            error_message = "gps data missing 'type' or 'coordinates'"
            logger.warning(
                f"Trip {transaction_id} validation failed: {error_message}")
            return False, error_message
        if not isinstance(gps_data["coordinates"], list):
            error_message = "gps['coordinates'] must be a list"
            logger.warning(
                f"Trip {transaction_id} validation failed: {error_message}")
            return False, error_message
        logger.debug(f"GPS structure valid for trip {transaction_id}.")
    except json.JSONDecodeError as e:
        error_message = f"Invalid gps data format: {e}"
        logger.warning(
            f"Trip {transaction_id} validation failed: {error_message}", exc_info=True
        )
        return False, error_message
    except Exception as e:
        error_message = f"Error validating gps data: {e}"
        logger.error(
            f"Error during gps validation for trip {transaction_id}: {error_message}",
            exc_info=True,
        )
        return False, error_message

    logger.info(f"Trip data validation successful for {transaction_id}.")
    return True, None


async def reverse_geocode_nominatim(
    lat: float, lon: float, retries: int = 3, backoff_factor: int = 1
) -> Optional[Dict[str, Any]]:
    """
    Reverse geocode a latitude and longitude using OSM Nominatim.

    Parameters:
        lat (float): The latitude.
        lon (float): The longitude.
        retries (int): Number of retries in case of failure (default is 3).
        backoff_factor (int): Backoff factor for retry delays (default is 1).

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

    for attempt in range(1, retries + 1):
        try:
            session = await get_session()
            async with session.get(url, params=params) as response:
                if response.status == 200:
                    try:
                        data = await response.json()
                        logger.debug(
                            f"Reverse geocoded ({lat}, {lon}): keys={list(data.keys())} (attempt {attempt})"
                        )
                        return data
                    except Exception as e:
                        logger.warning(f"Error parsing JSON response: {e}")
                        continue
                elif response.status == 429:  # Too Many Requests
                    retry_after = int(response.headers.get(
                        "Retry-After", backoff_factor * 5))
                    await asyncio.sleep(retry_after)
                    continue
                else:
                    logger.warning(
                        f"Unexpected status code: {response.status}")

        except (ClientResponseError, ClientConnectorError, asyncio.TimeoutError, OSError) as e:
            log_level = logging.WARNING if attempt < retries else logging.ERROR
            logger.log(
                log_level,
                f"Reverse geocode error (attempt {attempt}) for ({lat}, {lon}): {e}",
                exc_info=True,
            )
            if attempt < retries:
                await asyncio.sleep(backoff_factor * (2 ** (attempt - 1)))
                continue

        except Exception as e:
            logger.error(
                f"Unexpected error during reverse geocoding: {e}", exc_info=True)
            if attempt < retries:
                await asyncio.sleep(backoff_factor * (2 ** (attempt - 1)))
                continue

    logger.error(
        f"Failed to reverse geocode ({lat}, {lon}) after {retries} attempts.")
    return None


def get_trip_timezone(trip: Dict[str, Any]) -> str:
    """
    Attempts to determine the timezone for a trip by examining its gps data.

    If the gps field is a JSON string, it is parsed into a dict. Then the function looks at the
    "coordinates" property. For a Point geometry, the coordinate is used directly; for other types,
    the first coordinate is used.

    Returns the timezone as a string (or 'UTC' if not found or in case of an error).
    """
    try:
        gps_data = trip.get("gps")
        if isinstance(gps_data, str):
            gps_data = geojson_loads(gps_data)
        coords = gps_data.get("coordinates", [])
        if not coords:
            return "UTC"
        # For a Point geometry, use the single coordinate; otherwise, use the first coordinate.
        if gps_data.get("type") == "Point":
            lon, lat = coords
        else:
            lon, lat = coords[0]
        tz = tf.timezone_at(lng=lon, lat=lat)
        return tz or "UTC"
    except Exception as e:
        logger.error(f"Error getting trip timezone: {e}", exc_info=True)
        return "UTC"
