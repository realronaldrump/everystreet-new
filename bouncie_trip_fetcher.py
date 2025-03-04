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
import sys

# Local imports
from db import trips_collection, db_manager
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
    except OSError as ose:
        if "Cannot allocate memory" in str(ose):
            logger.warning(
                "Memory allocation error while storing trip %s. Attempting recovery...",
                transaction_id,
            )
            # Try to recover from memory error
            recovery_successful = await db_manager.handle_memory_error()
            if recovery_successful:
                # Retry after recovery
                try:
                    await trips_collection.update_one(
                        {"transactionId": transaction_id}, {"$set": trip}, upsert=True
                    )
                    logger.info(
                        "Successfully stored trip %s after memory recovery.",
                        transaction_id,
                    )
                    return True
                except Exception as retry_err:
                    logger.error(
                        "Failed to store trip %s after memory recovery: %s",
                        transaction_id,
                        retry_err,
                    )
                    return False
            else:
                logger.error(
                    "Failed to recover from memory error for trip %s", transaction_id
                )
                return False
        else:
            logger.error(
                "OS error when storing trip %s: %s", transaction_id, ose, exc_info=True
            )
            return False
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

    try:
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

                # Add memory check before processing each device
                try:
                    import psutil

                    process = psutil.Process()
                    memory_percent = process.memory_percent()
                    if memory_percent > 80:  # If memory usage is above 80%
                        logger.warning(
                            "Memory usage high (%.2f%%) before processing device %s, forcing garbage collection",
                            memory_percent,
                            imei,
                        )
                        import gc

                        gc.collect()
                        await asyncio.sleep(1)  # Give system time to reclaim memory
                except ImportError:
                    logger.warning("psutil not installed, skipping memory check")
                except Exception as mem_check_err:
                    logger.warning("Error checking memory usage: %s", mem_check_err)

                while current_start < end_dt:
                    current_end = min(current_start + timedelta(days=7), end_dt)
                    raw_trips = await fetch_trips_for_device(
                        session, token, imei, current_start, current_end
                    )

                    # Process each trip with memory error handling
                    for trip in raw_trips:
                        try:
                            # Store the trip in the database
                            success = await store_trip(trip)
                            if success:
                                device_new_trips.append(trip)
                        except OSError as ose:
                            if "Cannot allocate memory" in str(ose):
                                logger.warning(
                                    "Memory allocation error during trip processing. Attempting recovery..."
                                )
                                recovery_successful = (
                                    await db_manager.handle_memory_error()
                                )
                                if not recovery_successful:
                                    logger.error(
                                        "Failed to recover from memory error, pausing trip processing"
                                    )
                                    # Update progress to show the error
                                    if progress_tracker is not None:
                                        progress_tracker["fetch_and_store_trips"][
                                            "status"
                                        ] = "failed"
                                        progress_tracker["fetch_and_store_trips"][
                                            "message"
                                        ] = "Memory allocation error"
                                    return all_new_trips
                            else:
                                logger.error("OS error processing trip: %s", ose)
                        except Exception as e:
                            logger.error("Error processing trip: %s", str(e))

                    # Move to the next time slice
                    current_start = current_end

                # Optionally trigger map matching for new trips
                if do_map_match and device_new_trips:
                    logger.info(
                        "Running map matching for %d new trips for device %s",
                        len(device_new_trips),
                        imei,
                    )
                    for trip in device_new_trips:
                        try:
                            await process_and_map_match_trip(trip)
                        except OSError as ose:
                            if "Cannot allocate memory" in str(ose):
                                logger.warning(
                                    "Memory allocation error during map matching. Attempting recovery..."
                                )
                                await db_manager.handle_memory_error()
                                # Skip this trip's map matching and continue with the next
                            else:
                                logger.error("OS error during map matching: %s", ose)
                        except Exception as e:
                            logger.error("Error in map matching: %s", str(e))

                all_new_trips.extend(device_new_trips)

                # Update progress after each device is processed
                if progress_tracker is not None:
                    progress_tracker["fetch_and_store_trips"]["progress"] = (
                        device_index / total_devices * 100
                    )

    except OSError as ose:
        if "Cannot allocate memory" in str(ose):
            logger.error(
                "Memory allocation error in main fetch_bouncie_trips_in_range function"
            )
            await db_manager.handle_memory_error()
        else:
            logger.error("OS error in fetch_bouncie_trips_in_range: %s", ose)
    except Exception as e:
        logger.error("Error in fetch_bouncie_trips_in_range: %s", str(e))
    finally:
        # Update final progress
        if progress_tracker is not None:
            if progress_tracker["fetch_and_store_trips"]["status"] != "failed":
                progress_tracker["fetch_and_store_trips"]["status"] = "completed"
                progress_tracker["fetch_and_store_trips"]["progress"] = 100
                progress_tracker["fetch_and_store_trips"][
                    "message"
                ] = f"Completed with {len(all_new_trips)} new trips"

    return all_new_trips
