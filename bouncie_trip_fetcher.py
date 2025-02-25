import os
import pytz
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from dateutil import parser as date_parser
import aiohttp
from geojson import dumps as geojson_dumps
from aiohttp.client_exceptions import ClientConnectorError, ClientResponseError

from db import trips_collection
from utils import get_trip_timezone, validate_trip_data, get_session
from map_matching import process_and_map_match_trip
from trip_processing import process_trip_data

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
AUTHORIZED_DEVICES = [d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d]
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")


async def get_access_token(session: aiohttp.ClientSession) -> str:
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": AUTH_CODE,
        "redirect_uri": REDIRECT_URI,
    }
    try:
        async with session.post(AUTH_URL, data=payload) as response:
            response.raise_for_status()
            data = await response.json()
            token = data.get("access_token")
            if not token:
                logger.error("Access token not found in response: %s", data)
                return None
            logger.info("Successfully retrieved access token.")
            return token
    except (ClientResponseError, ClientConnectorError) as e:
        logger.error("Error retrieving access token: %s", e, exc_info=True)
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
                    if "startTime" in trip:
                        trip["startTime"] = date_parser.isoparse(
                            trip["startTime"]
                        ).replace(tzinfo=timezone.utc)
                    if "endTime" in trip:
                        trip["endTime"] = date_parser.isoparse(trip["endTime"]).replace(
                            tzinfo=timezone.utc
                        )
                    else:
                        logger.debug(
                            "Trip %s missing endTime; skipping incomplete trip",
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
    transaction_id = trip.get("transactionId", "?")
    logger.info("Storing trip %s...", transaction_id)
    is_valid, error_msg = validate_trip_data(trip)
    if not is_valid:
        logger.error("Trip %s failed validation: %s", transaction_id, error_msg)
        return False
    trip = await process_trip_data(trip)
    if not trip:
        logger.error("Trip %s could not be fully processed.", transaction_id)
        return False
    if isinstance(trip.get("gps"), dict):
        trip["gps"] = geojson_dumps(trip["gps"])
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
    all_new_trips = []
    total_devices = len(AUTHORIZED_DEVICES)
    session = await get_session()
    token = await get_access_token(session)
    if not token:
        logger.error("Failed to obtain access token; aborting fetch.")
        if task_progress is not None:
            task_progress["fetch_and_store_trips"]["status"] = "failed"
        return all_new_trips

    for index, imei in enumerate(AUTHORIZED_DEVICES, start=1):
        if task_progress is not None:
            task_progress["fetch_and_store_trips"][
                "message"
            ] = f"Fetching trips for device {index} of {total_devices}"
        device_new_trips = []
        current_start = start_dt
        while current_start < end_dt:
            current_end = min(current_start + timedelta(days=7), end_dt)
            raw_trips = await fetch_trips_for_device(
                session, token, imei, current_start, current_end
            )
            for raw_trip in raw_trips:
                if await store_trip(raw_trip):
                    device_new_trips.append(raw_trip)
            if task_progress is not None:
                task_progress["fetch_and_store_trips"]["progress"] = int(
                    (index / total_devices) * 50
                )
            current_start = current_end
        all_new_trips.extend(device_new_trips)
        logger.info("Device %s: Inserted %d new trips.", imei, len(device_new_trips))
    if do_map_match and all_new_trips:
        logger.info("Starting map matching for %d new trips...", len(all_new_trips))
        try:
            await asyncio.gather(
                *(process_and_map_match_trip(t) for t in all_new_trips)
            )
            logger.info("Map matching completed for new trips.")
        except Exception as e:
            logger.error("Error during map matching: %s", e, exc_info=True)
    if task_progress is not None:
        task_progress["fetch_and_store_trips"]["progress"] = 100
        task_progress["fetch_and_store_trips"]["status"] = "completed"
    return all_new_trips


async def get_trips_from_api(
    session: aiohttp.ClientSession,
    access_token: str,
    imei: str,
    start_date: datetime,
    end_date: datetime,
) -> list:
    headers = {"Authorization": access_token, "Content-Type": "application/json"}
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_date.isoformat(),
        "ends-before": end_date.isoformat(),
    }
    url = f"{API_BASE_URL}/trips"
    try:
        async with session.get(url, headers=headers, params=params) as response:
            response.raise_for_status()
            trips = await response.json()
            for trip in trips:
                tz_str = get_trip_timezone(trip)
                local_tz = pytz.timezone(tz_str)
                if "startTime" in trip and isinstance(trip["startTime"], str):
                    parsed = date_parser.isoparse(trip["startTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    trip["startTime"] = parsed.astimezone(local_tz)
                    trip["timeZone"] = tz_str
                if "endTime" in trip and isinstance(trip["endTime"], str):
                    parsed = date_parser.isoparse(trip["endTime"])
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=pytz.UTC)
                    trip["endTime"] = parsed.astimezone(local_tz)
            logger.info(
                "Fetched %d trips from API for IMEI=%s, range=%s to %s",
                len(trips),
                imei,
                start_date,
                end_date,
            )
            return trips
    except (ClientResponseError, ClientConnectorError) as e:
        logger.error(
            "Error fetching trips from API for IMEI=%s: %s", imei, e, exc_info=True
        )
        return []
    except Exception as e:
        logger.error("Unexpected error fetching trips: %s", e, exc_info=True)
        return []


async def fetch_trips_in_intervals(
    session: aiohttp.ClientSession,
    access_token: str,
    imei: str,
    start_date: datetime,
    end_date: datetime,
) -> list:
    all_trips = []
    current_start = start_date.replace(tzinfo=timezone.utc)
    end_date = end_date.replace(tzinfo=timezone.utc)
    while current_start < end_date:
        current_end = min(current_start + timedelta(days=7), end_date)
        try:
            chunk = await get_trips_from_api(
                session, access_token, imei, current_start, current_end
            )
            all_trips.extend(chunk)
        except Exception as e:
            logger.error(
                "Error fetching interval %s to %s: %s",
                current_start,
                current_end,
                e,
                exc_info=True,
            )
        current_start = current_end
    return all_trips
