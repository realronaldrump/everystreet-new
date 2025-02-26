import json
import asyncio
import logging
from typing import Optional, Tuple, Dict, Any

import aiohttp
from aiohttp import ClientConnectorError, ClientResponseError, TCPConnector
from geojson import loads as geojson_loads
from timezonefinder import TimezoneFinder

tf = TimezoneFinder()
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

SESSION_TIMEOUT = aiohttp.ClientTimeout(
    total=10, connect=5, sock_connect=5, sock_read=5
)


class SessionManager:
    _instance = None
    _session: Optional[aiohttp.ClientSession] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            connector = TCPConnector(
                limit=10, force_close=True, enable_cleanup_closed=True
            )
            self._session = aiohttp.ClientSession(
                connector=connector,
                timeout=SESSION_TIMEOUT,
                headers={
                    "User-Agent": "EveryStreet/1.0 (myapp@example.com)",
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip, deflate",
                },
            )
        return self._session

    async def cleanup(self):
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None


session_manager = SessionManager()


async def get_session() -> aiohttp.ClientSession:
    return await session_manager.get_session()


async def cleanup_session():
    await session_manager.cleanup()


async def validate_location_osm(
    location: str, location_type: str
) -> Optional[Dict[str, Any]]:
    params = {"q": location, "format": "json", "limit": 1, "featuretype": location_type}
    headers = {"User-Agent": "EveryStreet-Validator/1.0"}
    try:
        session = await get_session()
        async with session.get(
            "https://nominatim.openstreetmap.org/search", params=params, headers=headers
        ) as response:
            if response.status == 200:
                data = await response.json()
                logger.debug(
                    "Received %s results for location '%s'.", len(data), location
                )
                return data[0] if data else None
            logger.error("HTTP %s error for location '%s'.", response.status, location)
            return None
    except Exception as e:
        logger.error(
            "Exception during validate_location_osm for '%s': %s",
            location,
            e,
            exc_info=True,
        )
        return None


def validate_trip_data(trip: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    transaction_id = trip.get("transactionId", "?")
    logger.info("Validating trip data for %s...", transaction_id)
    required = ["transactionId", "startTime", "endTime", "gps"]
    for field in required:
        if field not in trip:
            msg = f"Missing required field: {field}"
            logger.warning("Trip %s validation failed: %s", transaction_id, msg)
            return False, msg
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if "type" not in gps_data or "coordinates" not in gps_data:
            msg = "gps data missing 'type' or 'coordinates'"
            logger.warning("Trip %s validation failed: %s", transaction_id, msg)
            return False, msg
        if not isinstance(gps_data["coordinates"], list):
            msg = "gps['coordinates'] must be a list"
            logger.warning("Trip %s validation failed: %s", transaction_id, msg)
            return False, msg
        logger.debug("GPS structure valid for trip %s.", transaction_id)
    except json.JSONDecodeError as e:
        msg = f"Invalid gps data format: {e}"
        logger.warning(
            "Trip %s validation failed: %s", transaction_id, msg, exc_info=True
        )
        return False, msg
    except Exception as e:
        msg = f"Error validating gps data: {e}"
        logger.error(
            "Error during gps validation for trip %s: %s",
            transaction_id,
            msg,
            exc_info=True,
        )
        return False, msg
    logger.info("Trip data validation successful for %s.", transaction_id)
    return True, None


async def reverse_geocode_nominatim(
    lat: float, lon: float, retries: int = 3, backoff_factor: int = 1
) -> Optional[Dict[str, Any]]:
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
                            "Reverse geocoded (%s, %s): keys=%s (attempt %s)",
                            lat,
                            lon,
                            list(data.keys()),
                            attempt,
                        )
                        return data
                    except Exception as e:
                        logger.warning("Error parsing reverse geocode JSON: %s", e)
                        continue
                elif response.status == 429:
                    retry_after = int(
                        response.headers.get("Retry-After", backoff_factor * 5)
                    )
                    await asyncio.sleep(retry_after)
                    continue
                else:
                    logger.warning(
                        "Unexpected reverse geocode status: %s", response.status
                    )
        except (ClientResponseError, ClientConnectorError) as e:
            logger.warning(
                "Reverse geocode error (attempt %s) for (%s, %s): %s",
                attempt,
                lat,
                lon,
                e,
                exc_info=True,
            )
            if attempt < retries:
                await asyncio.sleep(backoff_factor * (2 ** (attempt - 1)))
                continue
        except Exception as e:
            logger.error("Unexpected reverse geocode error: %s", e, exc_info=True)
            if attempt < retries:
                await asyncio.sleep(backoff_factor * (2 ** (attempt - 1)))
                continue
    logger.error(
        "Failed to reverse geocode (%s, %s) after %s attempts.", lat, lon, retries
    )
    return None


def get_trip_timezone(trip: Dict[str, Any]) -> str:
    try:
        gps_data = trip.get("gps")
        if isinstance(gps_data, str):
            gps_data = geojson_loads(gps_data)
        coords = gps_data.get("coordinates", [])
        if not coords:
            return "UTC"
        if gps_data.get("type") == "Point":
            lon, lat = coords
        else:
            lon, lat = coords[0]
        tz = tf.timezone_at(lng=lon, lat=lat)
        return tz or "UTC"
    except Exception as e:
        logger.error("Error getting trip timezone: %s", e, exc_info=True)
        return "UTC"


def parse_gps(gps) -> dict:
    if isinstance(gps, str):
        try:
            return json.loads(gps)
        except Exception as e:
            logger.error("Error parsing gps data: %s", e)
            return {}
    return gps
