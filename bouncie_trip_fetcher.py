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
from utils import validate_trip_data, reverse_geocode_nominatim, get_trip_timezone
from map_matching import process_and_map_match_trip
from aiohttp.client_exceptions import ClientConnectorError, ClientResponseError
from db import trips_collection, archived_live_trips_collection

# Logging Configuration
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Global progress data for tracking task status
progress_data = {
    "fetch_and_store_trips": {"status": "idle", "progress": 0, "message": ""},
    "periodic_fetch_trips": {"status": "idle", "progress": 0, "message": ""},
    "preprocess_streets": {"status": "idle", "progress": 0, "message": ""},
}

# Bouncie API & Environment configuration
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
AUTHORIZED_DEVICES = [d for d in os.getenv(
    "AUTHORIZED_DEVICES", "").split(",") if d]
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
        async with client_session.post(AUTH_URL, data=payload) as auth_response:
            auth_response.raise_for_status()  # Raise error for bad responses
            data = await auth_response.json()
            access_token = data.get("access_token")
            if not access_token:
                logger.error("Access token not found in response: %s", data)
                return None
            logger.info(
                "Successfully retrieved access token from Bouncie API.")
            return access_token
    except ClientResponseError as e:
        logger.error(
            "ClientResponseError retrieving access token: %s - %s",
            e.status,
            e.message,
            exc_info=True,
        )
        return None
    except ClientConnectorError as e:
        logger.error(
            "ClientConnectorError retrieving access token: %s", e, exc_info=True
        )
        return None
    except Exception as e:
        logger.error(
            "Unexpected error retrieving access token: %s", e, exc_info=True)
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
        async with session.get(url, headers=headers, params=params) as response:
            response.raise_for_status()
            trips = await response.json()
            for trip in trips:
                try:
                    trip["startTime"] = date_parser.isoparse(trip["startTime"]).replace(
                        tzinfo=timezone.utc
                    )
                    trip["endTime"] = date_parser.isoparse(trip["endTime"]).replace(
                        tzinfo=timezone.utc
                    )
                except Exception as te:
                    logger.error(
                        "Timestamp parsing error for trip %s: %s",
                        trip.get("transactionId", "?"),
                        te,
                        exc_info=True,
                    )
            logger.info(
                "Fetched %s trips for device %s from %s to %s.",
                len(trips),
                imei,
                start_dt.isoformat(),
                end_dt.isoformat(),
            )
            return trips
    except Exception as e:
        logger.error("Error fetching trips for device %s: %s",
                     imei, e, exc_info=True)
        return []


async def store_trip(trip: dict) -> bool:
    """
    Validate and store a single trip document in MongoDB.  Determines the
    correct collection based on the 'source' field.

    Args:
        trip: The trip dictionary to store.

    Returns:
        True if the trip was stored successfully, False otherwise.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info("Storing trip %s ...", transaction_id)

    is_valid, error_msg = validate_trip_data(trip)  # Keep validation
    if not is_valid:
        logger.error("Trip %s failed validation: %s",
                     transaction_id, error_msg)
        return False

    # Ensure GPS data is stored as a JSON string
    if isinstance(trip.get("gps"), dict):
        trip["gps"] = geojson_dumps(trip["gps"])

    # Parse startTime and endTime if they are strings (should be handled by process_trip_data, but keep for safety)
    for field in ["startTime", "endTime"]:
        if field in trip and isinstance(trip[field], str):
            trip[field] = date_parser.isoparse(trip[field])

    # Determine the correct collection based on 'source'
    if trip.get("source") == "webhook":
        collection = archived_live_trips_collection
    else:
        collection = trips_collection  # Default to trips_collection

    update_data = {"$set": trip}  # Simplified update
    try:
        result = await collection.update_one(
            {"transactionId": transaction_id}, update_data, upsert=True
        )
        logger.info(
            "Stored trip %s successfully in %s. Modified count: %s, Upserted: %s",
            transaction_id,
            collection.name,  # Log the collection name
            result.modified_count,
            result.upserted_id is not None,
        )
        return True
    except Exception as e:
        logger.error("Error storing trip %s: %s",
                     transaction_id, e, exc_info=True)
        return False


async def fetch_bouncie_trips_in_range(
    start_dt: datetime,
    end_dt: datetime,
    do_map_match: bool = False,
    progress_data: dict = None,
) -> list:
    """
    Fetches trips from the Bouncie API for all authorized devices within a given
    date range. Processes each trip using process_trip_data to handle custom
    places and geocoding, and then stores the trip in the appropriate MongoDB
    collection.

    Args:
        start_dt: The start datetime for the trip range.
        end_dt: The end datetime for the trip range.
        do_map_match: Whether to perform map matching on the fetched trips.
        progress_data:  An optional dictionary to update with progress information.

    Returns:
        A list of all newly inserted/updated trips.
    """
    async with aiohttp.ClientSession() as session:
        token = await get_access_token(session)
        if not token:
            logger.error(
                "Failed to obtain access token; aborting fetch_and_store_trips."
            )
            if progress_data is not None:
                progress_data["fetch_and_store_trips"]["status"] = "failed"
            return []

        all_new_trips = []
        total_devices = len(AUTHORIZED_DEVICES)
        for device_index, imei in enumerate(AUTHORIZED_DEVICES, start=1):
            if progress_data is not None:
                progress_data["fetch_and_store_trips"][
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
                    # *** KEY CHANGE: Process the trip data HERE ***
                    processed_trip = await process_trip_data(trip)
                    if processed_trip:  # Only store if processing succeeds
                        if await store_trip(processed_trip):  # Pass collection
                            device_new_trips.append(processed_trip)

                if progress_data is not None:
                    progress_data["fetch_and_store_trips"]["progress"] = int(
                        (device_index / total_devices) * 50
                    )
                current_start = current_end
            all_new_trips.extend(device_new_trips)
            logger.info(
                "Device %s: %s new trips inserted.", imei, len(
                    device_new_trips)
            )

        if do_map_match and all_new_trips:
            logger.info("Starting map matching for new trips...")
            try:
                await asyncio.gather(
                    *(process_and_map_match_trip(trip) for trip in all_new_trips)
                )
                logger.info("Map matching completed for all new trips.")
            except Exception as e:
                logger.error("Error during map matching: %s", e, exc_info=True)

        if progress_data is not None:
            progress_data["fetch_and_store_trips"]["progress"] = 100
            progress_data["fetch_and_store_trips"]["status"] = "completed"

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
            # Localize times
            for trip in trips:
                tz_str = get_trip_timezone(trip)
                timezone_obj = pytz.timezone(tz_str)
                if "startTime" in trip and isinstance(trip["startTime"], str):
                    parsed = parser.isoparse(trip["startTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    trip["startTime"] = parsed.astimezone(timezone_obj)
                    trip["timeZone"] = tz_str
                if "endTime" in trip and isinstance(trip["endTime"], str):
                    parsed = parser.isoparse(trip["endTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    trip["endTime"] = parsed.astimezone(timezone_obj)
            logger.info(
                "Successfully fetched %s trips from Bouncie API for IMEI: %s, date range: %s to %s",
                len(trips),
                imei,
                start_date,
                end_date,
            )
            return trips
    except ClientResponseError as e:
        logger.error(
            "ClientResponseError fetching trips: %s - %s, IMEI: %s, date range: %s to %s",
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


async def fetch_and_store_trips():
    """
    For all authorized devices, fetch the last four years of trips from Bouncie
    and store them in the 'trips' collection.
    Updates the global progress_data accordingly.
    """
    global progress_data
    progress_data["fetch_and_store_trips"]["status"] = "running"
    progress_data["fetch_and_store_trips"]["progress"] = 0
    progress_data["fetch_and_store_trips"]["message"] = "Starting fetch"

    try:
        async with aiohttp.ClientSession() as client_session:
            access_token = await get_access_token(client_session)
            if not access_token:
                logger.error(
                    "Failed to obtain access token, aborting fetch_and_store_trips."
                )
                progress_data["fetch_and_store_trips"]["status"] = "failed"
                progress_data["fetch_and_store_trips"][
                    "message"
                ] = "Failed to obtain access token"
                return

            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=365 * 4)

            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for device_count, imei in enumerate(AUTHORIZED_DEVICES, start=1):
                progress_data["fetch_and_store_trips"][
                    "message"
                ] = f"Fetching trips for device {device_count} of {total_devices}"
                device_trips = await fetch_trips_in_intervals(
                    client_session, access_token, imei, start_date, end_date
                )
                all_trips.extend(device_trips)
                # Update progress (first 50% for fetching)
                progress = int((device_count / total_devices) * 50)
                progress_data["fetch_and_store_trips"]["progress"] = progress

            # Now store each trip
            progress_data["fetch_and_store_trips"][
                "message"
            ] = "Storing trips in database"
            total_trips = len(all_trips)
            for index, trip in enumerate(all_trips):
                try:
                    existing = await trips_collection.find_one(
                        {"transactionId": trip["transactionId"]}
                    )
                    if existing:
                        continue  # Skip if already exists

                    ok, errmsg = validate_trip_data(trip)
                    if not ok:
                        logger.error(
                            "Skipping invalid trip %s: %s",
                            trip.get("transactionId"),
                            errmsg,
                        )
                        continue

                    # Ensure startTime and endTime are datetime objects
                    if isinstance(trip["startTime"], str):
                        trip["startTime"] = parser.isoparse(trip["startTime"])
                    if isinstance(trip["endTime"], str):
                        trip["endTime"] = parser.isoparse(trip["endTime"])

                    # Convert gps to JSON string if needed
                    if isinstance(trip["gps"], dict):
                        trip["gps"] = geojson_dumps(trip["gps"])

                    # Add reverse geocode for start/destination
                    gps_data = geojson_loads(trip["gps"])
                    start_pt = gps_data["coordinates"][0]
                    end_pt = gps_data["coordinates"][-1]
                    trip["startGeoPoint"] = start_pt
                    trip["destinationGeoPoint"] = end_pt

                    trip["destination"] = await reverse_geocode_nominatim(
                        end_pt[1], end_pt[0]
                    )
                    trip["startLocation"] = await reverse_geocode_nominatim(
                        start_pt[1], start_pt[0]
                    )

                    # Upsert the trip document
                    await trips_collection.update_one(
                        {"transactionId": trip["transactionId"]},
                        {"$set": trip},
                        upsert=True,
                    )
                    logger.debug(
                        "Trip %s processed and stored/updated.",
                        trip.get("transactionId"),
                    )

                    # Update progress (final 50% for storing)
                    progress = int(50 + (index / total_trips) * 50)
                    progress_data["fetch_and_store_trips"]["progress"] = progress
                except Exception as e:
                    logger.error(
                        "Error inserting/updating trip %s: %s",
                        trip.get("transactionId"),
                        e,
                        exc_info=True,
                    )

            progress_data["fetch_and_store_trips"]["status"] = "completed"
            progress_data["fetch_and_store_trips"]["progress"] = 100
            progress_data["fetch_and_store_trips"][
                "message"
            ] = "Fetch and store completed"

    except Exception as e:
        logger.error("Error in fetch_and_store_trips: %s", e, exc_info=True)
        progress_data["fetch_and_store_trips"]["status"] = "failed"
        progress_data["fetch_and_store_trips"]["message"] = f"Error: {e}"
