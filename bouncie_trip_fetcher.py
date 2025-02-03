"""
bouncie_trip_fetcher.py

This module fetches trip data from the Bouncie API for all authorized devices,
processes and validates each trip (including reverse geocoding), stores new trips in MongoDB,
and (optionally) triggers map matching on the newly inserted trips.
"""

import os
import json
import pytz
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from dateutil import parser as date_parser
import aiohttp
from dateutil import parser
from geojson import dumps as geojson_dumps, loads as geojson_loads
from pymongo import MongoClient

# Import shared utilities and map matching function
from utils import validate_trip_data, reverse_geocode_nominatim, get_trip_timezone
from map_matching import process_and_map_match_trip
from aiohttp.client_exceptions import ClientConnectorError, ClientResponseError

# -----------------------------------------------------------------------------
# Logging Configuration
# -----------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

# -----------------------------------------------------------------------------
# Bouncie API & Environment configuration
# -----------------------------------------------------------------------------
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
AUTHORIZED_DEVICES = os.getenv("AUTHORIZED_DEVICES", "").split(",")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")

# -----------------------------------------------------------------------------
# MongoDB configuration
# -----------------------------------------------------------------------------
MONGO_URI = os.getenv("MONGO_URI")
mongo_client = MongoClient(MONGO_URI)
db = mongo_client["every_street"]
trips_collection = db["trips"]

# -----------------------------------------------------------------------------
# API Functions
# -----------------------------------------------------------------------------


async def get_access_token(client_session):
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
        async with client_session.post(AUTH_URL, data=payload) as auth_response:
            auth_response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
            data = await auth_response.json()
            access_token = data.get("access_token")
            if not access_token:
                # Log if token is missing
                logger.error(f"Access token not found in response: {data}")
                return None
            logger.info(
                "Successfully retrieved access token from Bouncie API.")
            return access_token
    except ClientResponseError as e:
        # Log ClientResponseError with details
        logger.error(
            f"ClientResponseError retrieving access token: {e.status} - {e.message}", exc_info=True)
        return None
    except ClientConnectorError as e:
        # Log ClientConnectorError
        logger.error(
            f"ClientConnectorError retrieving access token: {e}", exc_info=True)
        return None
    except Exception as e:
        # Log any other exceptions
        logger.error(
            f"Unexpected error retrieving access token: {e}", exc_info=True)
        return None


async def fetch_trips_for_device(
    session: aiohttp.ClientSession,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime
) -> list:
    """
    Fetch trips for a single device (identified by IMEI) between start_dt and end_dt.
    Timestamps in the returned trips are normalized as timezone‑aware datetime objects.
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
        async with session.get(url, headers=headers, params=params) as response:
            response.raise_for_status()
            trips = await response.json()
            for trip in trips:
                try:
                    trip["startTime"] = date_parser.isoparse(
                        trip["startTime"]).replace(tzinfo=timezone.utc)
                    trip["endTime"] = date_parser.isoparse(
                        trip["endTime"]).replace(tzinfo=timezone.utc)
                except Exception as te:
                    logger.error(
                        f"Timestamp parsing error for trip {trip.get('transactionId', '?')}: {te}", exc_info=True)
            logger.info(
                f"Fetched {len(trips)} trips for device {imei} from {start_dt.isoformat()} to {end_dt.isoformat()}.")
            return trips
    except Exception as e:
        logger.error(
            f"Error fetching trips for device {imei}: {e}", exc_info=True)
        return []


async def store_trip(trip: dict) -> bool:
    """
    Validate and store a single trip document in MongoDB.
    Returns True if the trip was inserted, otherwise False.
    """
    transaction_id = trip.get("transactionId")
    if trips_collection.find_one({"transactionId": transaction_id}):
        logger.info(
            f"Trip {transaction_id} already exists. Skipping insertion.")
        return False

    is_valid, error_msg = validate_trip_data(trip)
    if not is_valid:
        logger.error(f"Trip {transaction_id} failed validation: {error_msg}")
        return False

    # Ensure GPS data is stored as a JSON string
    if isinstance(trip.get("gps"), dict):
        trip["gps"] = geojson_dumps(trip["gps"])

    # Attempt reverse geocoding for start and destination if not provided
    try:
        gps = geojson_loads(trip["gps"])
        coordinates = gps.get("coordinates", [])
        if coordinates and len(coordinates) >= 2:
            start_coords, end_coords = coordinates[0], coordinates[-1]
            if not trip.get("startLocation"):
                geo_data = await reverse_geocode_nominatim(start_coords[1], start_coords[0])
                trip["startLocation"] = geo_data.get("display_name", "")
            if not trip.get("destination"):
                geo_data = await reverse_geocode_nominatim(end_coords[1], end_coords[0])
                trip["destination"] = geo_data.get("display_name", "")
        else:
            logger.warning(
                f"Trip {transaction_id} has insufficient coordinate data.")
    except Exception as e:
        logger.error(
            f"Error during reverse geocoding for trip {transaction_id}: {e}", exc_info=True)

    try:
        trips_collection.insert_one(trip)
        logger.info(f"Inserted trip {transaction_id} into the database.")
        return True
    except Exception as e:
        logger.error(
            f"Error inserting trip {transaction_id}: {e}", exc_info=True)
        return False


async def fetch_bouncie_trips_in_range(
    start_dt: datetime,
    end_dt: datetime,
    do_map_match: bool = False,
    progress_data: dict = None
) -> list:
    """
    For each authorized device, fetch trips in 7‑day intervals between start_dt and end_dt.
    Process and store each trip. Optionally, trigger map matching on new trips.
    If progress_data is provided, update its status and progress.
    Returns a list of all newly inserted trips.
    """
    async with aiohttp.ClientSession() as session:
        token = await get_access_token(session)
        if not token:
            logger.error("Failed to retrieve access token; aborting fetch.")
            if progress_data is not None:
                progress_data["status"] = "failed"
            return []

        all_new_trips = []
        total_devices = len(AUTHORIZED_DEVICES)
        for device_index, imei in enumerate(AUTHORIZED_DEVICES, start=1):
            device_new_trips = []
            current_start = start_dt
            while current_start < end_dt:
                current_end = min(current_start + timedelta(days=7), end_dt)
                trips = await fetch_trips_for_device(session, token, imei, current_start, current_end)
                for trip in trips:
                    if await store_trip(trip):
                        device_new_trips.append(trip)
                if progress_data is not None:
                    progress_data["progress"] = int(
                        (device_index / total_devices) * 50)
                current_start = current_end
            all_new_trips.extend(device_new_trips)
            logger.info(
                f"Device {imei}: {len(device_new_trips)} new trips inserted.")

        if do_map_match and all_new_trips:
            logger.info("Starting map matching for new trips...")
            try:
                await asyncio.gather(*(process_and_map_match_trip(trip) for trip in all_new_trips))
                logger.info("Map matching completed for all new trips.")
            except Exception as e:
                logger.error(f"Error during map matching: {e}", exc_info=True)

        if progress_data is not None:
            progress_data["progress"] = 100
            progress_data["status"] = "completed"

        return all_new_trips


async def get_trips_from_api(client_session, access_token, imei, start_date, end_date):
    """
    Pulls trips from Bouncie's /trips endpoint, for a device IMEI and date range.
    """
    headers = {"Authorization": access_token,
               "Content-Type": "application/json"}
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
            # Attempt localizing times
            for trip in trips:
                tz_str = get_trip_timezone(trip)
                timezone_obj = pytz.timezone(tz_str)

                if "startTime" in trip and isinstance(trip["startTime"], str):
                    parsed = parser.isoparse(trip["startTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    local_time = parsed.astimezone(timezone_obj)
                    trip["startTime"] = local_time
                    trip["timeZone"] = tz_str

                if "endTime" in trip and isinstance(trip["endTime"], str):
                    parsed = parser.isoparse(trip["endTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    local_time = parsed.astimezone(timezone_obj)
                    trip["endTime"] = local_time

            logger.info(
                f"Successfully fetched {len(trips)} trips from Bouncie API for IMEI: {imei}, date range: {start_date} to {end_date}")
            return trips
    except ClientResponseError as e:
        logger.error(
            f"ClientResponseError fetching trips from Bouncie API: {e.status} - {e.message}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
        return []
    except ClientConnectorError as e:
        logger.error(
            f"ClientConnectorError fetching trips from Bouncie API: {e}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
        return []
    except Exception as e:
        logger.error(
            f"Unexpected error fetching trips from Bouncie API: {e}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
        return []

    #############################
# API calls to Bouncie
#############################


async def get_trips_from_api(client_session, access_token, imei, start_date, end_date):
    """
    Pulls trips from Bouncie's /trips endpoint, for a device IMEI and date range.
    """
    headers = {"Authorization": access_token,
               "Content-Type": "application/json"}
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
            # Attempt localizing times
            for trip in trips:
                tz_str = get_trip_timezone(trip)
                timezone_obj = pytz.timezone(tz_str)

                if "startTime" in trip and isinstance(trip["startTime"], str):
                    parsed = parser.isoparse(trip["startTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    local_time = parsed.astimezone(timezone_obj)
                    trip["startTime"] = local_time
                    trip["timeZone"] = tz_str

                if "endTime" in trip and isinstance(trip["endTime"], str):
                    parsed = parser.isoparse(trip["endTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    local_time = parsed.astimezone(timezone_obj)
                    trip["endTime"] = local_time

            logger.info(
                f"Successfully fetched {len(trips)} trips from Bouncie API for IMEI: {imei}, date range: {start_date} to {end_date}")
            return trips
    except ClientResponseError as e:
        logger.error(
            f"ClientResponseError fetching trips from Bouncie API: {e.status} - {e.message}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
        return []
    except ClientConnectorError as e:
        logger.error(
            f"ClientConnectorError fetching trips from Bouncie API: {e}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
        return []
    except Exception as e:
        logger.error(
            f"Unexpected error fetching trips from Bouncie API: {e}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
        return []


async def fetch_trips_in_intervals(main_session, access_token, imei, start_date, end_date):
    """
    Breaks the date range into 7-day intervals to avoid hitting any Bouncie restrictions.
    """
    all_trips = []
    current_start = start_date.replace(tzinfo=timezone.utc)
    end_date = end_date.replace(tzinfo=timezone.utc)

    while current_start < end_date:
        current_end = min(current_start + timedelta(days=7), end_date)
        try:
            trips = await get_trips_from_api(main_session, access_token, imei, current_start, current_end)
            all_trips.extend(trips)
        except Exception as e:
            # Log interval specific errors
            logger.error(
                f"Error fetching trips for interval {current_start} to {current_end}: {e}", exc_info=True)
        current_start = current_end

    return all_trips
