"""Bouncie API trip fetcher module.

Fetches trip data from the Bouncie API, processes and validates each trip using
the unified TripProcessor, and stores trips in MongoDB with optimized error handling
and progress tracking.
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

import aiohttp
from dateutil import parser as date_parser

from trip_processor import TripProcessor, TripState
from utils import get_session

logger = logging.getLogger(__name__)

# Configuration constants
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

# API constants
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
CHUNK_SIZE_DAYS = 7  # Process trips in 7-day chunks to avoid large responses

# Parse authorized devices once at module level
AUTHORIZED_DEVICES = [
    device.strip()
    for device in os.getenv("AUTHORIZED_DEVICES", "").split(",")
    if device.strip()
]

# Progress tracking structure
DEFAULT_PROGRESS_DATA = {
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


class ProgressTracker:
    """Utility class for managing progress tracking."""

    def __init__(self, progress_data: Optional[Dict] = None):
        self.progress_data = progress_data or DEFAULT_PROGRESS_DATA.copy()

    def update_status(
        self,
        operation: str,
        status: str,
        progress: float = None,
        message: str = "",
    ):
        """Update progress status for an operation."""
        if operation in self.progress_data:
            self.progress_data[operation]["status"] = status
            if progress is not None:
                self.progress_data[operation]["progress"] = progress
            if message:
                self.progress_data[operation]["message"] = message

    def set_running(self, operation: str, message: str = ""):
        """Set operation status to running."""
        self.update_status(operation, "running", 0, message)

    def set_progress(self, operation: str, progress: float, message: str = ""):
        """Update progress percentage."""
        self.update_status(operation, "running", progress, message)

    def set_completed(self, operation: str, message: str = ""):
        """Set operation status to completed."""
        self.update_status(operation, "completed", 100, message)

    def set_failed(self, operation: str, error_message: str):
        """Set operation status to failed."""
        self.update_status(
            operation, "failed", message=f"Error: {error_message}"
        )


async def get_access_token(session: aiohttp.ClientSession) -> Optional[str]:
    """Get an access token from the Bouncie API using OAuth.

    Args:
        session: Aiohttp client session

    Returns:
        Access token string or None if failed
    """
    if not all([CLIENT_ID, CLIENT_SECRET, AUTH_CODE, REDIRECT_URI]):
        logger.error("Missing required OAuth configuration")
        return None

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

            access_token = data.get("access_token")
            if not access_token:
                logger.error("Access token not found in response: %s", data)
                return None

            logger.debug("Successfully obtained access token")
            return access_token

    except aiohttp.ClientError as e:
        logger.error("HTTP error retrieving access token: %s", e)
        return None
    except Exception as e:
        logger.error("Unexpected error retrieving access token: %s", e)
        return None


def parse_trip_timestamps(trip: Dict) -> Dict:
    """Parse and convert trip timestamps to UTC.

    Args:
        trip: Trip dictionary with timestamp fields

    Returns:
        Trip dictionary with parsed timestamps
    """
    timestamp_fields = ["startTime", "endTime"]

    for field in timestamp_fields:
        if field in trip and isinstance(trip[field], str):
            try:
                parsed_time = date_parser.isoparse(trip[field])
                trip[field] = parsed_time.astimezone(timezone.utc)
            except (ValueError, TypeError) as e:
                logger.warning("Failed to parse %s for trip: %s", field, e)

    return trip


async def fetch_trips_for_device(
    session: aiohttp.ClientSession,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime,
) -> List[Dict]:
    """Fetch trips for a single device between start_dt and end_dt.

    Args:
        session: Aiohttp client session
        token: OAuth access token
        imei: Device IMEI
        start_dt: Start datetime
        end_dt: End datetime

    Returns:
        List of trip dictionaries
    """
    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_dt.isoformat(),
        "ends-before": end_dt.isoformat(),
    }
    url = f"{API_BASE_URL}/trips"

    try:
        async with session.get(
            url, headers=headers, params=params
        ) as response:
            response.raise_for_status()
            trips = await response.json()

            # Parse timestamps for all trips
            parsed_trips = [parse_trip_timestamps(trip) for trip in trips]

            logger.info(
                "Fetched %d trips for device %s", len(parsed_trips), imei
            )
            return parsed_trips

    except aiohttp.ClientError as e:
        logger.error("HTTP error fetching trips for device %s: %s", imei, e)
        return []
    except Exception as e:
        logger.error(
            "Unexpected error fetching trips for device %s: %s", imei, e
        )
        return []


async def process_single_trip(
    trip: Dict, do_map_match: bool = False
) -> Optional[str]:
    """Process a single trip using TripProcessor.

    Args:
        trip: Trip data dictionary
        do_map_match: Whether to perform map matching

    Returns:
        Saved trip ID or None if failed
    """
    transaction_id = trip.get("transactionId", "unknown")

    # Validate required fields
    if not trip.get("endTime"):
        logger.warning("Skipping trip %s: missing endTime", transaction_id)
        return None

    try:
        processor = TripProcessor(
            mapbox_token=MAPBOX_ACCESS_TOKEN, source="api"
        )
        processor.set_trip_data(trip)
        await processor.process(do_map_match=do_map_match)

        if processor.state == TripState.FAILED:
            status_info = processor.get_processing_status()
            logger.error(
                "Trip processing failed for %s. State: %s, Errors: %s",
                transaction_id,
                processor.state.value,
                status_info.get("errors", {}),
            )
            return None

        saved_id = await processor.save(map_match_result=do_map_match)

        if saved_id:
            map_matched = (
                do_map_match and "matchedGps" in processor.processed_data
            )
            logger.info(
                "Successfully processed trip %s (Map Matched: %s) with ID %s",
                transaction_id,
                "Yes" if map_matched else "No",
                saved_id,
            )
            return saved_id
        else:
            logger.error(
                "Trip %s processed but could not be saved", transaction_id
            )
            return None

    except Exception as e:
        logger.exception(
            "Unexpected error processing trip %s: %s", transaction_id, e
        )
        return None


async def fetch_device_trips_in_chunks(
    session: aiohttp.ClientSession,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime,
) -> List[Dict]:
    """Fetch trips for a device in time chunks to handle large date ranges.

    Args:
        session: Aiohttp client session
        token: OAuth access token
        imei: Device IMEI
        start_dt: Start datetime
        end_dt: End datetime

    Returns:
        List of all trips for the device
    """
    all_trips = []
    current_start = start_dt

    while current_start < end_dt:
        current_end = min(
            current_start + timedelta(days=CHUNK_SIZE_DAYS), end_dt
        )

        trips_chunk = await fetch_trips_for_device(
            session, token, imei, current_start, current_end
        )
        all_trips.extend(trips_chunk)
        current_start = current_end

    return all_trips


async def fetch_bouncie_trips_in_range(
    start_dt: datetime,
    end_dt: datetime,
    do_map_match: bool = False,
    task_progress: Optional[Dict] = None,
) -> List[Dict]:
    """Fetch and process Bouncie trips for all authorized devices in date range.

    Args:
        start_dt: Start datetime for trip fetching
        end_dt: End datetime for trip fetching
        do_map_match: Whether to perform map matching on trips
        task_progress: Optional progress tracking dictionary

    Returns:
        List of successfully processed trip dictionaries
    """
    if not AUTHORIZED_DEVICES:
        logger.warning("No authorized devices configured")
        return []

    progress = ProgressTracker(task_progress)
    progress.set_running("fetch_and_store_trips", "Starting trip fetch")

    all_new_trips = []
    total_devices = len(AUTHORIZED_DEVICES)

    try:
        session = await get_session()
        token = await get_access_token(session)

        if not token:
            error_msg = "Failed to obtain access token"
            logger.error(error_msg)
            progress.set_failed("fetch_and_store_trips", error_msg)
            return all_new_trips

        logger.info(
            "Processing %d devices for date range %s to %s",
            total_devices,
            start_dt.isoformat(),
            end_dt.isoformat(),
        )

        for device_index, imei in enumerate(AUTHORIZED_DEVICES, start=1):
            progress.set_progress(
                "fetch_and_store_trips",
                (device_index - 1) / total_devices * 100,
                f"Processing device {device_index} of {total_devices}: {imei}",
            )

            # Fetch all trips for this device
            device_trips = await fetch_device_trips_in_chunks(
                session, token, imei, start_dt, end_dt
            )

            logger.info(
                "Processing %d trips for device %s (do_map_match=%s)",
                len(device_trips),
                imei,
                do_map_match,
            )

            # Process each trip
            for trip in device_trips:
                saved_id = await process_single_trip(trip, do_map_match)
                if saved_id:
                    all_new_trips.append(trip)

        # Complete successfully
        completion_message = f"Completed fetch and processing. Found {len(all_new_trips)} new/updated trips."
        progress.set_completed("fetch_and_store_trips", completion_message)

    except Exception as e:
        error_msg = f"Error in fetch_bouncie_trips_in_range: {e}"
        logger.error(error_msg, exc_info=True)
        progress.set_failed("fetch_and_store_trips", str(e))

    logger.info(
        "fetch_bouncie_trips_in_range completed. Processed %d trips.",
        len(all_new_trips),
    )
    return all_new_trips


# Maintain backward compatibility
progress_data = DEFAULT_PROGRESS_DATA
