import json
import aiohttp
from aiohttp import ClientConnectorError, ClientResponseError
import asyncio
import logging
import requests

# Configure the logger
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.DEBUG)

def validate_location_osm(location, location_type):
    """
    Use OSM Nominatim to see if location is valid. Return the first match or None.
    """
    params = {
        "q": location,
        "format": "json",
        "limit": 1,
        "featuretype": location_type
    }
    headers = {"User-Agent": "EveryStreet-Validator/1.0"}
    response = requests.get("https://nominatim.openstreetmap.org/search", params=params, headers=headers)
    if response.status_code == 200:
        data = response.json()
        return data[0] if data else None
    return None

#############################
# Data Validation
#############################


def validate_trip_data(trip):
    """
    Ensure the trip has transactionId, startTime, endTime, gps, etc.
    Return (bool_ok, error_message), with enhanced logging.
    """
    transaction_id = trip.get(
        'transactionId', '?')  # Get transaction ID safely
    # Log function entry
    logger.info(f"Validating trip data for trip {transaction_id}...")

    required = ["transactionId", "startTime", "endTime", "gps"]
    for field in required:
        if field not in trip:
            error_message = f"Missing required field: {field}"
            # Log missing field as warning
            logger.warning(
                f"Validation failed for trip {transaction_id}: {error_message}")
            return (False, error_message)
    # Log if required fields are present
    logger.debug(f"Required fields present for trip {transaction_id}.")

    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if "type" not in gps_data or "coordinates" not in gps_data:
            error_message = "gps data missing 'type' or 'coordinates'"
            # Log GPS data structure issue
            logger.warning(
                f"Validation failed for trip {transaction_id}: {error_message}")
            return (False, error_message)
        if not isinstance(gps_data["coordinates"], list):
            error_message = "gps['coordinates'] must be a list"
            # Log coords not a list
            logger.warning(
                f"Validation failed for trip {transaction_id}: {error_message}")
            return (False, error_message)
        # Log valid GPS structure
        logger.debug(f"GPS data structure is valid for trip {transaction_id}.")
    except json.JSONDecodeError as e:  # Catch JSON decoding errors specifically
        error_message = f"Invalid gps data format: {str(e)}"
        # Log JSON decode error with exception info
        logger.warning(
            f"Validation failed for trip {transaction_id}: {error_message}", exc_info=True)
        return (False, error_message)
    except Exception as e:  # Catch other potential errors during validation
        error_message = f"Error validating gps data: {str(e)}"
        # Log general validation error with exception info
        logger.error(
            f"Error during gps data validation for trip {transaction_id}: {error_message}", exc_info=True)
        return (False, error_message)

    # Log validation success
    logger.info(f"Trip data validation successful for trip {transaction_id}.")
    return (True, None)

#############################
# Reverse geocode with Nominatim
#############################


async def reverse_geocode_nominatim(lat, lon, retries=3, backoff_factor=1):
    """
    Reverse geocode lat/lon using the OSM Nominatim service.
    Returns the FULL Nominatim JSON response as a dict, or None if failure.
      Example successful return:
        {
          "place_id": "...",
          "licence": "...",
          "osm_type": "...",
          "display_name": "123 Main St, ...",
          "address": {...},
          ...
        }
    If success but no display_name present, returns whatever OSM gave.
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
            # Create a short-lived session
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.get(url, params=params, headers=headers) as response:
                    response.raise_for_status()
                    data = await response.json()
                    
                    # Return the ENTIRE JSON dict from Nominatim
                    logger.debug(
                        f"Reverse geocoded ({lat}, {lon}): got top-level keys {list(data.keys())} (attempt {attempt})"
                    )
                    return data

        except (aiohttp.ClientResponseError, aiohttp.ClientConnectorError, asyncio.TimeoutError) as e:
            log_level = logging.WARNING if attempt < retries else logging.ERROR
            logger.log(
                log_level,
                f"Nominatim reverse geocode error (attempt {attempt}) for ({lat},{lon}): {e}",
                exc_info=True
            )
            if attempt < retries:
                # Simple backoff
                await asyncio.sleep(backoff_factor * (2 ** (attempt - 1)))

    logger.error(
        f"Failed to reverse geocode ({lat},{lon}) after {retries} attempts."
    )
    return None