"""
bouncie_trip_fetcher.py

This module fetches trip data from the Bouncie API for all authorized devices,
processes and validates each trip (including reverse geocoding), stores new trips in
MongoDB,
and (optionally) triggers map matching on the newly inserted trips.
"""

import os
import pytz
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from motor.motor_asyncio import AsyncIOMotorClient
from dateutil import parser as date_parser
import aiohttp
from geojson import dumps as geojson_dumps, loads as geojson_loads

# Import shared utilities and map matching function
from utils import (
    validate_trip_data,
    reverse_geocode_nominatim,
    get_trip_timezone,
)
from map_matching import process_and_map_match_trip
from aiohttp.client_exceptions import (
    ClientConnectorError,
    ClientResponseError,
)

# Logging Configuration
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Global progress data for tracking task status
progress_data = {
    "periodic_fetch_trips": {
        "status": "idle",
        "progress": 0,
        "message": "",
    },
    "preprocess_streets": {
        "status": "idle",
        "progress": 0,
        "message": "",
    },
}

# Bouncie API & Environment configuration
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
AUTHORIZED_DEVICES = [
    d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d
]
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")

# MongoDB configuration
MONGO_URI = os.getenv("MONGO_URI")
client = AsyncIOMotorClient(MONGO_URI, tz_aware=True)
db = client["every_street"]
trips_collection = db["trips"]


async def get_access_token(client_session: aiohttp.ClientSession) -> str:
    """
    Retrieves an access token from the Bouncie API using OAuth.
    """
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": AUTH_CODE,
        "redirect_uri": REDIRECT_URI,
    }
    try:
        async with client_session.post(
            AUTH_URL, data=payload
        ) as auth_response:
            auth_response.raise_for_status()  # Raise error for bad responses
            data = await auth_response.json()
            access_token = data.get("access_token")
            if not access_token:
                logger.error("Access token not found in response: %s", data)
                return None
            logger.info(
                "Successfully retrieved access token from Bouncie API."
            )
            return access_token
    except ClientResponseError as e:
        logger.error(
            "ClientResponseError retrieving access token: %d - %s",
            e.status,
            e.message,
            exc_info=True,
        )
        return None
    except ClientConnectorError as e:
        logger.error(
            "ClientConnectorError retrieving access token: %s",
            e,
            exc_info=True,
        )
        return None
    except Exception as e:
        logger.error(
            "Unexpected error retrieving access token: %s", e, exc_info=True
        )
        return None


async def fetch_trips_for_device(
    session: aiohttp.ClientSession,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime,
) -> list:
    """
    Fetch trips for a single device (identified by IMEI) between start_dt and end_dt.
    Normalizes trip timestamps to timezone‑aware datetime objects.
    """
    headers = {"Authorization": token, "Content-Type": "application/json"}
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_dt.isoformat(),
        "ends-before": end_dt.isoformat(),
    }
    try:
        url = f"{API_BASE_URL}/trips"
        async with session.get(
            url, headers=headers, params=params
        ) as response:
            response.raise_for_status()
            trips = await response.json()
            for trip in trips:
                try:
                    # Parse startTime if present
                    if "startTime" in trip:
                        trip["startTime"] = date_parser.isoparse(
                            trip["startTime"]
                        ).replace(tzinfo=timezone.utc)
                    # Parse endTime only if present
                    if "endTime" in trip:
                        trip["endTime"] = date_parser.isoparse(
                            trip["endTime"]
                        ).replace(tzinfo=timezone.utc)
                    else:
                        logger.debug(
                            "Trip %s has no endTime - may be in progress",
                            trip.get("transactionId", "?"),
                        )
                        continue  # Skip this trip since it's incomplete
                except Exception as te:
                    logger.error(
                        "Timestamp parsing error for trip %s: %s",
                        trip.get("transactionId", "?"),
                        te,
                        exc_info=True,
                    )
            logger.info(
                "Fetched %d trips for device %s from %s to %s.",
                len(trips),
                imei,
                start_dt.isoformat(),
                end_dt.isoformat(),
            )
            return trips
    except Exception as e:
        logger.error(
            "Error fetching trips for device %s: %s", imei, e, exc_info=True
        )
        return []


async def store_trip(trip: dict) -> bool:
    """
    Validate, process (including custom place lookup), and store a single trip document
    in MongoDB.
    If a trip with the same transactionId exists, it is updated; otherwise, a new
    document is inserted.
    Returns True if the trip was stored successfully.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info("Storing trip %s in trips_collection...", transaction_id)

    # Validate the trip data.
    is_valid, error_msg = validate_trip_data(trip)
    if not is_valid:
        logger.error(
            "Trip %s failed validation: %s", transaction_id, error_msg
        )
        return False
    logger.debug("Trip data validation passed for trip %s.", transaction_id)

    # *** NEW: Process the trip to check for custom places.
    # This function (defined in app.py) will check the start and end points.
    from app import (
        process_trip_data,
    )  # or import from your common module if you refactor it

    trip = await process_trip_data(trip)

    # Ensure the gps field is stored as a JSON string.
    if isinstance(trip.get("gps"), dict):
        logger.debug(
            "Converting gps data to JSON string for trip %s.", transaction_id
        )
        trip["gps"] = geojson_dumps(trip["gps"])

    # Parse startTime and endTime if provided as strings.
    for field in ["startTime", "endTime"]:
        if field in trip and isinstance(trip[field], str):
            logger.debug(
                "Parsing %s from string for trip %s.", field, transaction_id
            )
            trip[field] = date_parser.isoparse(trip[field])

    # (Optional) Do a reverse geocode fallback if process_trip_data did not already
    # set the location.
    try:
        gps = geojson_loads(trip["gps"])
        coordinates = gps.get("coordinates", [])
        if coordinates and len(coordinates) >= 2:
            start_coords, end_coords = coordinates[0], coordinates[-1]
            if not trip.get("startLocation"):
                geo_data = await reverse_geocode_nominatim(
                    start_coords[1], start_coords[0]
                )
                trip["startLocation"] = geo_data.get("display_name", "")
            if not trip.get("destination"):
                geo_data = await reverse_geocode_nominatim(
                    end_coords[1], end_coords[0]
                )
                trip["destination"] = geo_data.get("display_name", "")
        else:
            logger.warning(
                "Trip %s has insufficient coordinate data.", transaction_id
            )
    except Exception as e:
        logger.error(
            "Error during reverse geocoding for trip %s: %s",
            transaction_id,
            e,
            exc_info=True,
        )

    update_data = {
        "$set": {
            **trip,
            "startPlaceId": trip.get("startPlaceId"),
            "destinationPlaceId": trip.get("destinationPlaceId"),
        }
    }
    try:
        result = await trips_collection.update_one(
            {"transactionId": transaction_id}, update_data, upsert=True
        )
        logger.info(
            "Stored trip %s successfully. Modified count: %d, Upserted: %s",
            transaction_id,
            result.modified_count,
            result.upserted_id is not None,
        )
        return True
    except Exception as e:
        logger.error(
            "Error storing trip %s: %s", transaction_id, e, exc_info=True
        )
        return False


async def fetch_bouncie_trips_in_range(
    start_dt: datetime,
    end_dt: datetime,
    do_map_match: bool = False,
    task_progress: dict = None,
) -> list:
    """
    For each authorized device, fetch trips in 7‑day intervals between start_dt and
    end_dt.
    Process and store each trip. Optionally, trigger map matching on new trips.
    If a task_progress dict is provided, update its status and progress.
    Returns a list of all newly inserted trips.
    """
    async with aiohttp.ClientSession() as session:
        token = await get_access_token(session)
        if not token:
            logger.error(
                "Failed to obtain access token; aborting fetch_and_store_trips."
            )
            if task_progress is not None:
                task_progress["fetch_and_store_trips"]["status"] = "failed"
            return []

        all_new_trips = []
        total_devices = len(AUTHORIZED_DEVICES)
        for device_index, imei in enumerate(AUTHORIZED_DEVICES, start=1):
            # Update progress status for this device
            if task_progress is not None:
                task_progress["fetch_and_store_trips"][
                    "message"
                ] = f"Fetching trips for device {device_index} of {total_devices}"
            device_new_trips = []
            current_start = start_dt
            while current_start < end_dt:
                current_end = min(current_start + timedelta(days=7), end_dt)
                trips = await fetch_trips_for_device(
                    session, token, imei, current_start, current_end
                )
                for trip in trips:
                    if await store_trip(trip):
                        device_new_trips.append(trip)
                if task_progress is not None:
                    task_progress["fetch_and_store_trips"]["progress"] = int(
                        (device_index / total_devices) * 50
                    )
                current_start = current_end
            all_new_trips.extend(device_new_trips)
            logger.info(
                "Device %s: %d new trips inserted.",
                imei,
                len(device_new_trips),
            )

        if do_map_match and all_new_trips:
            logger.info("Starting map matching for new trips...")
            try:
                await asyncio.gather(
                    *(
                        process_and_map_match_trip(trip)
                        for trip in all_new_trips
                    )
                )
                logger.info("Map matching completed for all new trips.")
            except Exception as e:
                logger.error(
                    "Error during map matching: %s", e, exc_info=True
                )

        if task_progress is not None:
            task_progress["fetch_and_store_trips"]["progress"] = 100
            task_progress["fetch_and_store_trips"]["status"] = "completed"

        return all_new_trips


async def get_trips_from_api(
    client_session: aiohttp.ClientSession,
    access_token: str,
    imei: str,
    start_date: datetime,
    end_date: datetime,
) -> list:
    """
    Pulls trips from Bouncie's /trips endpoint for a given device IMEI and date range.
    Also converts times to local timezones based on the trip.
    """
    headers = {
        "Authorization": access_token,
        "Content-Type": "application/json",
    }
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_date.isoformat(),
        "ends-before": end_date.isoformat(),
    }
    try:
        async with client_session.get(
            f"{API_BASE_URL}/trips", headers=headers, params=params
        ) as response:
            response.raise_for_status()
            trips = await response.json()
            # Localize times
            for trip in trips:
                tz_str = get_trip_timezone(trip)
                timezone_obj = pytz.timezone(tz_str)
                if "startTime" in trip and isinstance(trip["startTime"], str):
                    parsed = date_parser.isoparse(trip["startTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    trip["startTime"] = parsed.astimezone(timezone_obj)
                    trip["timeZone"] = tz_str
                if "endTime" in trip and isinstance(trip["endTime"], str):
                    parsed = date_parser.isoparse(trip["endTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    trip["endTime"] = parsed.astimezone(timezone_obj)
            logger.info(
                "Successfully fetched %d trips from Bouncie API for IMEI: %s, "
                "date range: %s to %s",
                len(trips),
                imei,
                start_date,
                end_date,
            )
            return trips
    except ClientResponseError as e:
        logger.error(
            "ClientResponseError fetching trips: %d - %s, "
            "IMEI: %s, date range: %s to %s",
            e.status,
            e.message,
            imei,
            start_date,
            end_date,
            exc_info=True,
        )
        return []
    except ClientConnectorError as e:
        logger.error(
            "ClientConnectorError fetching trips: %s, IMEI: %s, date range: %s to %s",
            e,
            imei,
            start_date,
            end_date,
            exc_info=True,
        )
        return []
    except Exception as e:
        logger.error(
            "Unexpected error fetching trips: %s, IMEI: %s, date range: %s to %s",
            e,
            imei,
            start_date,
            end_date,
            exc_info=True,
        )
        return []


async def fetch_trips_in_intervals(
    main_session: aiohttp.ClientSession,
    access_token: str,
    imei: str,
    start_date: datetime,
    end_date: datetime,
) -> list:
    """
    Breaks the given date range into 7-day intervals to avoid Bouncie API restrictions.
    """
    all_trips = []
    current_start = start_date.replace(tzinfo=timezone.utc)
    end_date = end_date.replace(tzinfo=timezone.utc)
    while current_start < end_date:
        current_end = min(current_start + timedelta(days=7), end_date)
        try:
            trips = await get_trips_from_api(
                main_session, access_token, imei, current_start, current_end
            )
            all_trips.extend(trips)
        except Exception as e:
            logger.error(
                "Error fetching trips for interval %s to %s: %s",
                current_start,
                current_end,
                e,
                exc_info=True,
            )
        current_start = current_end
    return all_trips
