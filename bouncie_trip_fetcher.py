"""bouncie_trip_fetcher.py.

Fetches trip data from the Bouncie API, processes and validates each trip using
the unified TripProcessor, and stores trips in MongoDB.
"""

import logging
import os
from datetime import datetime, timedelta, timezone

import aiohttp
from dateutil import parser as date_parser

from trip_processor import TripProcessor, TripState

from utils import get_session

logger = logging.getLogger(__name__)

CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
AUTHORIZED_DEVICES = [
    d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d
]
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")

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


async def get_access_token(session: aiohttp.ClientSession) -> str:
    """Get an access token from the Bouncie API using OAuth."""
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
                logger.error("Access token not found in response")
                return None
            return access_token
    except Exception as e:
        logger.error("Error retrieving access token: %s", e)
        return None


async def fetch_trips_for_device(
    session: aiohttp.ClientSession,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime,
) -> list:
    """Fetch trips for a single device between start_dt and end_dt."""
    headers = {"Authorization": token, "Content-Type": "application/json"}
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

            for trip in trips:
                if "startTime" in trip:
                    trip["startTime"] = date_parser.isoparse(
                        trip["startTime"]
                    ).replace(tzinfo=timezone.utc)
                if "endTime" in trip:
                    trip["endTime"] = date_parser.isoparse(
                        trip["endTime"]
                    ).replace(tzinfo=timezone.utc)

            logger.info("Fetched %d trips for device %s", len(trips), imei)
            return trips
    except Exception as e:
        logger.error("Error fetching trips for device %s: %s", imei, e)
        return []


async def store_trip(trip: dict) -> bool:
    """Store a single trip from historical fetch in MongoDB using the unified TripProcessor.
    Filters out trips missing essential fields like endTime before processing.

    Args:
         trip (dict): The raw trip data fetched from the Bouncie API.

    Returns:
         bool: True if the trip was successfully processed and stored, False otherwise (including skipped trips).
    """
    transaction_id = trip.get("transactionId", "?")

    if not trip.get("endTime"):
        logger.warning(
            "Skipping storing historical trip %s because 'endTime' is missing from fetched data.",
            transaction_id,
        )
        return False

    try:
        processor = TripProcessor(
            mapbox_token=os.getenv("MAPBOX_ACCESS_TOKEN", ""), source="api"
        )

        processor.set_trip_data(trip)

        await processor.process(do_map_match=False)

        if processor.state == TripState.FAILED:
            status_info = processor.get_processing_status()
            logger.error(
                "TripProcessor failed for historical trip %s. State: %s, Errors: %s",
                transaction_id,
                processor.state.value,
                status_info.get("errors"),
            )
            return False

        saved_id = await processor.save()

        if not saved_id:
            logger.error(
                "Historical trip %s processed successfully but could not be saved to 'trips' collection.",
                transaction_id,
            )
            return False

        logger.info(
            "Stored historical trip %s successfully in 'trips' collection with ID %s",
            transaction_id,
            saved_id,
        )
        return True

    except Exception as e:
        logger.exception(
            "Unexpected error storing historical trip %s: %s",
            transaction_id,
            e,
        )
        return False


async def fetch_bouncie_trips_in_range(
    start_dt: datetime,
    end_dt: datetime,
    do_map_match: bool = False,
    task_progress: dict = None,
) -> list:
    """Fetch trips from the Bouncie API for all authorized devices.

    Processes and stores each trip, with optional map matching.
    """
    all_new_trips = []
    total_devices = len(AUTHORIZED_DEVICES)
    progress_tracker = (
        task_progress if task_progress is not None else progress_data
    )

    if progress_tracker is not None:
        progress_tracker["fetch_and_store_trips"]["status"] = "running"
        progress_tracker["fetch_and_store_trips"]["progress"] = 0
        progress_tracker["fetch_and_store_trips"]["message"] = (
            "Starting trip fetch"
        )

    try:
        session = await get_session()
        token = await get_access_token(session)
        if not token:
            logger.error("Failed to obtain access token; aborting fetch")
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["status"] = "failed"
                progress_tracker["fetch_and_store_trips"]["message"] = (
                    "Failed to obtain access token"
                )
            return all_new_trips

        for device_index, imei in enumerate(AUTHORIZED_DEVICES, start=1):
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["message"] = (
                    f"Fetching trips for device {device_index} of {total_devices}"
                )

            device_new_trips = []
            current_start = start_dt

            while current_start < end_dt:
                current_end = min(current_start + timedelta(days=7), end_dt)

                raw_trips = await fetch_trips_for_device(
                    session, token, imei, current_start, current_end
                )

                for trip in raw_trips:
                    try:
                        success = await store_trip(trip)
                        if success:
                            device_new_trips.append(trip)
                    except Exception as e:
                        logger.error("Error processing trip: %s", e)

                current_start = current_end

            if do_map_match and device_new_trips:
                logger.info(
                    "Running map matching for %d new trips",
                    len(device_new_trips),
                )
                for trip in device_new_trips:
                    try:
                        processor = TripProcessor(
                            mapbox_token=os.getenv("MAPBOX_ACCESS_TOKEN", ""),
                            source="api",
                        )

                        processor.set_trip_data(trip)
                        await processor.process(do_map_match=True)
                        await processor.save(map_match_result=True)
                    except Exception as e:
                        logger.error(
                            "Map matching error for trip %s: %s",
                            trip.get("transactionId", "?"),
                            e,
                        )

            all_new_trips.extend(device_new_trips)

            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["progress"] = (
                    device_index / total_devices * 100
                )

    except Exception as e:
        logger.error("Error in fetch_bouncie_trips_in_range: %s", e)
    finally:
        if (
            progress_tracker is not None
            and progress_tracker["fetch_and_store_trips"]["status"] != "failed"
        ):
            progress_tracker["fetch_and_store_trips"]["status"] = "completed"
            progress_tracker["fetch_and_store_trips"]["progress"] = 100
            progress_tracker["fetch_and_store_trips"]["message"] = (
                f"Completed with {len(all_new_trips)} new trips"
            )

    return all_new_trips
