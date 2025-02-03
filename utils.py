import json
import asyncio
import logging
import aiohttp
from aiohttp import ClientConnectorError, ClientResponseError
from geojson import loads as geojson_loads
from timezonefinder import TimezoneFinder

tf = TimezoneFinder()
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)


async def validate_location_osm(location, location_type):
    """
    Asynchronously validate a location using OSM Nominatim search.
    Returns the first matching location dict or None.
    """
    params = {
        "q": location,
        "format": "json",
        "limit": 1,
        "featuretype": location_type
    }
    headers = {"User-Agent": "EveryStreet-Validator/1.0"}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            async with session.get("https://nominatim.openstreetmap.org/search", params=params, headers=headers) as response:
                if response.status == 200:
                    data = await response.json()
                    logger.debug(f"Received {len(data)} results for location '{location}'.")
                    return data[0] if data else None
                else:
                    logger.error(f"HTTP {response.status} error for location '{location}'.")
                    return None
    except Exception as e:
        logger.error(f"Exception during validate_location_osm for '{location}': {e}", exc_info=True)
        return None


def validate_trip_data(trip):
    """
    Validate that a trip dict contains required fields.
    Returns a tuple (True, None) if valid or (False, error_message) if not.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info(f"Validating trip data for {transaction_id}...")
    required = ["transactionId", "startTime", "endTime", "gps"]
    for field in required:
        if field not in trip:
            error_message = f"Missing required field: {field}"
            logger.warning(f"Trip {transaction_id} validation failed: {error_message}")
            return False, error_message

    logger.debug(f"All required fields present for trip {transaction_id}.")
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if "type" not in gps_data or "coordinates" not in gps_data:
            error_message = "gps data missing 'type' or 'coordinates'"
            logger.warning(f"Trip {transaction_id} validation failed: {error_message}")
            return False, error_message
        if not isinstance(gps_data["coordinates"], list):
            error_message = "gps['coordinates'] must be a list"
            logger.warning(f"Trip {transaction_id} validation failed: {error_message}")
            return False, error_message
        logger.debug(f"GPS structure valid for trip {transaction_id}.")
    except json.JSONDecodeError as e:
        error_message = f"Invalid gps data format: {e}"
        logger.warning(f"Trip {transaction_id} validation failed: {error_message}", exc_info=True)
        return False, error_message
    except Exception as e:
        error_message = f"Error validating gps data: {e}"
        logger.error(f"Error during gps validation for trip {transaction_id}: {error_message}", exc_info=True)
        return False, error_message

    logger.info(f"Trip data validation successful for {transaction_id}.")
    return True, None


async def reverse_geocode_nominatim(lat, lon, retries=3, backoff_factor=1):
    """
    Reverse geocode a latitude and longitude using OSM Nominatim.
    Returns the full JSON response as a dict, or None on failure.
    """
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "format": "jsonv2",
        "lat": lat,
        "lon": lon,
        "zoom": 18,
        "addressdetails": 1,
    }
    headers = {"User-Agent": "EveryStreet/1.0 (myapp@example.com)"}

    for attempt in range(1, retries + 1):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.get(url, params=params, headers=headers) as response:
                    response.raise_for_status()
                    data = await response.json()
                    logger.debug(f"Reverse geocoded ({lat}, {lon}): keys={list(data.keys())} (attempt {attempt})")
                    return data
        except (ClientResponseError, ClientConnectorError, asyncio.TimeoutError) as e:
            level = logging.WARNING if attempt < retries else logging.ERROR
            logger.log(level, f"Reverse geocode error (attempt {attempt}) for ({lat}, {lon}): {e}", exc_info=True)
            if attempt < retries:
                await asyncio.sleep(backoff_factor * (2 ** (attempt - 1)))
    logger.error(f"Failed to reverse geocode ({lat}, {lon}) after {retries} attempts.")
    return None

def get_trip_timezone(trip):
    """
    Simple function that attempts to figure out the timezone for a trip
    by looking at the first coordinate if available, or default 'UTC'.
    """
    try:
        if isinstance(trip["gps"], str):
            gps_data = geojson_loads(trip["gps"])
        else:
            gps_data = trip["gps"]
        coords = gps_data.get("coordinates", [])
        if not coords:
            return "UTC"

        # if it's a Point, just coords
        if gps_data["type"] == "Point":
            lon, lat = coords
        else:
            lon, lat = coords[0]

        tz = tf.timezone_at(lng=lon, lat=lat)
        return tz or "UTC"
    except Exception as e:
        # Log timezone retrieval errors
        logger.error(f"Error getting trip timezone: {e}", exc_info=True)
        return "UTC"