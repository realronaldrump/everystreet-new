"""
bouncie_trip_fetcher.py

Fetches trip data from the Bouncie API for all authorized devices,
processes and validates each trip (including reverse geocoding),
stores new trips in MongoDB, and optionally triggers map matching on
the newly inserted trips.
"""

import os
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from dateutil import parser as date_parser
import aiohttp
from geojson import dumps as geojson_dumps
from aiohttp.client_exceptions import (
    ClientConnectorError,
    ClientResponseError,
)

# Local imports
from db import trips_collection
from utils import (
    validate_trip_data,
)
from map_matching import process_and_map_match_trip
from trip_processing import process_trip_data

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Progress data for tracking (used by tasks that call fetch_bouncie_trips_in_range)
progress_data = {
    "fetch_and_store_trips": {
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

# Bouncie API & environment config
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
AUTHORIZED_DEVICES = [d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d]
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")


# For demonstration, we create a short-lived client here; in practice, you
# might want to use a shared session from `utils.py` or a central session manager.
async def get_access_token(client_session: aiohttp.ClientSession) -> str:
    """
    Retrieves an access token from the Bouncie API using OAuth.
    Returns None if unable to retrieve.
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
            auth_response.raise_for_status()
            data = await auth_response.json()
            access_token = data.get("access_token")
            if not access_token:
                logger.error("Access token not found in response: %s", data)
                return None
            logger.info("Successfully retrieved access token from Bouncie API.")
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
        logger.error("Unexpected error retrieving access token: %s", e, exc_info=True)
        return None


async def fetch_trips_for_device(
    session: aiohttp.ClientSession,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime,
) -> list:
    """
    Fetch trips for a single device IMEI between start_dt and end_dt.
    Normalizes trip timestamps to timezone‑aware datetime objects in UTC.
    """
    headers = {"Authorization": token, "Content-Type": "application/json"}
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_dt.isoformat(),
        "ends-before": end_dt.isoformat(),
    }
    url = f"{API_BASE_URL}/trips"
    try:
        async with session.get(url, headers=headers, params=params) as response:
            response.raise_for_status()
            trips = await response.json()
            for trip in trips:
                try:
                    # Parse startTime if present
                    if "startTime" in trip:
                        trip["startTime"] = date_parser.isoparse(
                            trip["startTime"]
                        ).replace(tzinfo=timezone.utc)
                    # Parse endTime if present
                    if "endTime" in trip:
                        trip["endTime"] = date_parser.isoparse(trip["endTime"]).replace(
                            tzinfo=timezone.utc
                        )
                    else:
                        # Possibly the trip is in progress; ignore if incomplete.
                        logger.debug(
                            "Trip %s missing endTime - ignoring incomplete trip",
                            trip.get("transactionId", "?"),
                        )
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
        logger.error("Error fetching trips for device %s: %s", imei, e, exc_info=True)
        return []


async def store_trip(trip: dict) -> bool:
    """
    Validate, process (including custom place lookup), and store a single trip document
    in MongoDB.
    - If a trip with the same transactionId exists, it is updated.
    - Otherwise, a new document is inserted.
    Returns True if the trip was stored successfully, False otherwise.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info("Storing trip %s in trips_collection...", transaction_id)

    # 1) Validate the trip data
    is_valid, error_msg = validate_trip_data(trip)
    if not is_valid:
        logger.error("Trip %s failed validation: %s", transaction_id, error_msg)
        return False
    logger.debug("Trip data validation passed for %s.", transaction_id)

    # 2) Process the trip data (e.g. reverse geocoding, custom place lookup)
    trip = await process_trip_data(trip)
    if not trip:
        logger.error("Trip %s could not be fully processed.", transaction_id)
        return False

    # 3) Convert gps to JSON (if it is not already).
    if isinstance(trip.get("gps"), dict):
        trip["gps"] = geojson_dumps(trip["gps"])

    # 4) Upsert into the trips_collection
    try:
        await trips_collection.update_one(
            {"transactionId": transaction_id}, {"$set": trip}, upsert=True
        )
        logger.info("Stored trip %s successfully.", transaction_id)
        return True
    except Exception as e:
        logger.error("Error storing trip %s: %s", transaction_id, e, exc_info=True)
        return False


async def fetch_bouncie_trips_in_range(
    start_dt: datetime,
    end_dt: datetime,
    do_map_match: bool = False,
    task_progress: dict = None,
) -> list:
    """
    For each authorized device, fetch trips in 7‑day intervals between start_dt and
    end_dt. Process/store each trip, optionally trigger map matching on new trips.
    Returns a list of newly inserted trips.
    """
    all_new_trips = []
    total_devices = len(AUTHORIZED_DEVICES)

    # Use the global progress_data if no task_progress is provided
    progress_tracker = task_progress if task_progress is not None else progress_data

    # Update progress status to "running"
    if progress_tracker is not None:
        progress_tracker["fetch_and_store_trips"]["status"] = "running"
        progress_tracker["fetch_and_store_trips"]["progress"] = 0
        progress_tracker["fetch_and_store_trips"]["message"] = "Starting trip fetch"

    async with aiohttp.ClientSession() as session:
        token = await get_access_token(session)
        if not token:
            logger.error("Failed to obtain access token; aborting fetch.")
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["status"] = "failed"
                progress_tracker["fetch_and_store_trips"][
                    "message"
                ] = "Failed to obtain access token"
            return all_new_trips

        # For each device, break up the date range into 7-day slices
        for device_index, imei in enumerate(AUTHORIZED_DEVICES, start=1):
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"][
                    "message"
                ] = f"Fetching trips for device {device_index} of {total_devices}"

            device_new_trips = []
            current_start = start_dt
            while current_start < end_dt:
                current_end = min(current_start + timedelta(days=7), end_dt)
                raw_trips = await fetch_trips_for_device(
                    session, token, imei, current_start, current_end
                )

                # Validate and store each trip
                for raw_trip in raw_trips:
                    if await store_trip(raw_trip):
                        device_new_trips.append(raw_trip)

                if progress_tracker is not None:
                    progress_tracker["fetch_and_store_trips"]["progress"] = int(
                        (device_index / total_devices) * 50
                    )
                current_start = current_end

            all_new_trips.extend(device_new_trips)
            logger.info(
                "Device %s: Inserted %d new trips.",
                imei,
                len(device_new_trips),
            )

        if do_map_match and all_new_trips:
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"][
                    "message"
                ] = f"Map matching {len(all_new_trips)} new trips"
                progress_tracker["fetch_and_store_trips"]["progress"] = 50

            logger.info(
                "Starting map matching for %d new trips...",
                len(all_new_trips),
            )
            try:
                await asyncio.gather(
                    *(process_and_map_match_trip(t) for t in all_new_trips)
                )
                logger.info("Map matching completed for new trips.")
            except Exception as e:
                logger.error("Error during map matching: %s", e, exc_info=True)
                if progress_tracker is not None:
                    progress_tracker["fetch_and_store_trips"][
                        "message"
                    ] = f"Error during map matching: {str(e)}"

        if progress_tracker is not None:
            progress_tracker["fetch_and_store_trips"]["progress"] = 100
            progress_tracker["fetch_and_store_trips"]["status"] = "completed"
            progress_tracker["fetch_and_store_trips"][
                "message"
            ] = f"Completed. Found {len(all_new_trips)} new trips."

    return all_new_trips
