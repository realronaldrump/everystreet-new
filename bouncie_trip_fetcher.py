"""
bouncie_trip_fetcher.py

This module centralizes fetching trips from the Bouncie API for all authorized devices,
processes and validates them, performs reverse geocoding, stores them in MongoDB,
and (optionally) triggers map matching on the newly inserted trips.
"""

import os
import json
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from dateutil import parser

import aiohttp
from geojson import dumps as geojson_dumps, loads as geojson_loads
from pymongo import MongoClient

# Import shared utilities.
from utils import validate_trip_data, reverse_geocode_nominatim

# Import map matching function.
from map_matching import process_and_map_match_trip

# -----------------------------------------------------------------------------
# Logging configuration
# -----------------------------------------------------------------------------
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(name)s - %(message)s'
)

# -----------------------------------------------------------------------------
# Bouncie API configuration
# -----------------------------------------------------------------------------
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"

# Authorized devices (IMEIs), provided as a comma‐separated string in your env.
AUTHORIZED_DEVICES = os.getenv("AUTHORIZED_DEVICES", "").split(",")

# -----------------------------------------------------------------------------
# MongoDB configuration
# -----------------------------------------------------------------------------
MONGO_URI = os.getenv("MONGO_URI")
mongo_client = MongoClient(MONGO_URI)
db = mongo_client["every_street"]
trips_collection = db["trips"]
# (If you have additional collections for matched trips or historical data, add them here)

# -----------------------------------------------------------------------------
# Function: get_access_token
# -----------------------------------------------------------------------------
async def get_access_token(session):
    """
    Retrieve a fresh access token from Bouncie using OAuth 2.0.
    """
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": AUTH_CODE,
        "redirect_uri": REDIRECT_URI,
    }
    try:
        async with session.post(AUTH_URL, json=payload) as response:
            response.raise_for_status()
            data = await response.json()
            token = data.get("access_token")
            if not token:
                logger.error("Access token not found in response.")
            return token
    except Exception as e:
        logger.error(f"Error retrieving access token: {e}", exc_info=True)
        return None

# -----------------------------------------------------------------------------
# Function: fetch_trips_for_device
# -----------------------------------------------------------------------------
async def fetch_trips_for_device(session, token, imei, start_dt, end_dt):
    """
    Fetch trips from the Bouncie API for a single device (IMEI) between start_dt and end_dt.
    """
    headers = {
        "Authorization": token,
        "Content-Type": "application/json"
    }
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_dt.isoformat(),
        "ends-before": end_dt.isoformat(),
    }
    try:
        async with session.get(f"{API_BASE_URL}/trips", headers=headers, params=params) as response:
            response.raise_for_status()
            trips = await response.json()
            # Parse and normalize timestamps
            for trip in trips:
                try:
                    trip["startTime"] = parser.isoparse(trip["startTime"]).replace(tzinfo=timezone.utc)
                    trip["endTime"] = parser.isoparse(trip["endTime"]).replace(tzinfo=timezone.utc)
                except Exception as te:
                    logger.error(f"Timestamp parsing error in trip {trip.get('transactionId')}: {te}")
            logger.info(f"Fetched {len(trips)} trips for device {imei} from {start_dt.isoformat()} to {end_dt.isoformat()}.")
            return trips
    except Exception as e:
        logger.error(f"Error fetching trips for device {imei}: {e}", exc_info=True)
        return []

# -----------------------------------------------------------------------------
# Function: store_trip
# -----------------------------------------------------------------------------
async def store_trip(trip):
    """
    Validate, process, and store a single trip in the trips_collection.
    Returns True if the trip was inserted; otherwise, returns False.
    """
    transaction_id = trip.get("transactionId")
    # Check for duplicate entry
    if trips_collection.find_one({"transactionId": transaction_id}):
        logger.info(f"Trip {transaction_id} already exists. Skipping insertion.")
        return False

    # Validate the trip data
    is_valid, err_msg = validate_trip_data(trip)
    if not is_valid:
        logger.error(f"Trip {transaction_id} failed validation: {err_msg}")
        return False

    # Ensure gps data is stored as a GeoJSON string
    if isinstance(trip.get("gps"), dict):
        trip["gps"] = geojson_dumps(trip["gps"])

    # Reverse geocode start and destination locations if not already set
    try:
        gps = geojson_loads(trip["gps"])
        coordinates = gps.get("coordinates", [])
        if coordinates and len(coordinates) >= 2:
            start_coords = coordinates[0]
            end_coords = coordinates[-1]
            if not trip.get("startLocation"):
                geo_data = await reverse_geocode_nominatim(start_coords[1], start_coords[0])
                trip["startLocation"] = geo_data.get("display_name", "")
            if not trip.get("destination"):
                geo_data = await reverse_geocode_nominatim(end_coords[1], end_coords[0])
                trip["destination"] = geo_data.get("display_name", "")
        else:
            logger.warning(f"Trip {transaction_id} has insufficient coordinate data.")
    except Exception as e:
        logger.error(f"Error during reverse geocoding for trip {transaction_id}: {e}", exc_info=True)

    # Insert the trip document into MongoDB
    try:
        trips_collection.insert_one(trip)
        logger.info(f"Inserted trip {transaction_id} into the database.")
        return True
    except Exception as e:
        logger.error(f"Error inserting trip {transaction_id}: {e}", exc_info=True)
        return False

# -----------------------------------------------------------------------------
# Function: fetch_bouncie_trips_in_range
# -----------------------------------------------------------------------------
async def fetch_bouncie_trips_in_range(start_dt, end_dt, do_map_match=False, progress_data=None):
    """
    For each authorized device, fetch trips between start_dt and end_dt in 7-day intervals.
    Process and store each trip. Optionally trigger map matching on the new trips.
    
    :param start_dt: Start datetime (timezone-aware)
    :param end_dt: End datetime (timezone-aware)
    :param do_map_match: If True, run map matching on the newly inserted trips.
    :param progress_data: (Optional) A dict to update progress information.
    :return: A list of all newly inserted trip documents.
    """
    async with aiohttp.ClientSession() as session:
        token = await get_access_token(session)
        if not token:
            logger.error("Failed to retrieve access token; aborting fetch.")
            if progress_data is not None:
                progress_data["status"] = "failed"
            return []

        all_new_trips = []
        # Loop over each authorized device.
        for device_index, imei in enumerate(AUTHORIZED_DEVICES, 1):
            device_new_trips = []
            current_start = start_dt
            # Break the overall time range into 7-day chunks.
            while current_start < end_dt:
                current_end = min(current_start + timedelta(days=7), end_dt)
                trips = await fetch_trips_for_device(session, token, imei, current_start, current_end)
                for trip in trips:
                    inserted = await store_trip(trip)
                    if inserted:
                        device_new_trips.append(trip)
                # Optionally update progress (e.g., progress_data["progress"] from 0 to 50 over devices)
                if progress_data is not None:
                    progress_data["progress"] = int((device_index / len(AUTHORIZED_DEVICES)) * 50)
                current_start = current_end
            all_new_trips.extend(device_new_trips)
            logger.info(f"Device {imei}: {len(device_new_trips)} new trips inserted.")
        
        # If requested, run map matching on all newly inserted trips.
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

# -----------------------------------------------------------------------------
# Standalone testing
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    # Example usage: fetch trips for the last 30 days for all authorized devices.
    start_date = datetime.now(timezone.utc) - timedelta(days=30)
    end_date = datetime.now(timezone.utc)
    loop = asyncio.get_event_loop()
    new_trips = loop.run_until_complete(
        fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=True)
    )
    logger.info(f"Total new trips inserted: {len(new_trips)}")