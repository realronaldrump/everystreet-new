"""Bouncie_trip_fetcher.py.

Fetches trip data from the Bouncie API, processes and validates each trip using
the unified TripProcessor, and stores trips in MongoDB.
"""

import asyncio
import logging
from datetime import datetime, timedelta

import aiohttp

from config import API_BASE_URL, AUTH_URL, MAPBOX_ACCESS_TOKEN, get_bouncie_config
from date_utils import parse_timestamp
from trip_service import TripService
from utils import get_session, retry_async

logger = logging.getLogger(__name__)

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


@retry_async(max_retries=3, retry_delay=1.5)
async def get_access_token(
    session: aiohttp.ClientSession,
    credentials: dict,
) -> str:
    """Get an access token from the Bouncie API using OAuth.

    Args:
        session: aiohttp session to use for the request
        credentials: Dictionary containing client_id, client_secret,
                    authorization_code, and redirect_uri
    """
    payload = {
        "client_id": credentials.get("client_id"),
        "client_secret": credentials.get("client_secret"),
        "grant_type": "authorization_code",
        "code": credentials.get("authorization_code"),
        "redirect_uri": credentials.get("redirect_uri"),
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


@retry_async(max_retries=3, retry_delay=1.5)
async def fetch_trips_for_device(
    session: aiohttp.ClientSession,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime,
) -> list:
    """Fetch trips for a single device between start_dt and end_dt."""
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
            url,
            headers=headers,
            params=params,
        ) as response:
            response.raise_for_status()
            trips = await response.json()

            for trip in trips:
                if "startTime" in trip:
                    trip["startTime"] = parse_timestamp(trip["startTime"])
                if "endTime" in trip:
                    trip["endTime"] = parse_timestamp(trip["endTime"])

            if trips:
                logger.info(
                    "Fetched %d trips for device %s",
                    len(trips),
                    imei,
                )
            else:
                # Demote noisy 0-trip events to debug to avoid log spam
                logger.info(
                    "Fetched 0 trips for device %s",
                    imei,
                )
            return trips
    except Exception as e:
        logger.error(
            "Error fetching trips for device %s: %s",
            imei,
            e,
        )
        return []


async def fetch_bouncie_trips_in_range(
    start_dt: datetime,
    end_dt: datetime,
    do_map_match: bool = False,
    task_progress: dict = None,
) -> list:
    # Parallel chunk processing across devices and 7-day windows
    all_new_trips = []
    progress_tracker = task_progress if task_progress is not None else progress_data
    if progress_tracker is not None:
        progress_tracker["fetch_and_store_trips"]["status"] = "running"
        progress_tracker["fetch_and_store_trips"]["progress"] = 0
        progress_tracker["fetch_and_store_trips"]["message"] = "Starting trip fetch"
    try:
        # Get Bouncie credentials from database or environment
        credentials = await get_bouncie_config()
        authorized_devices = credentials.get("authorized_devices", [])

        if not authorized_devices:
            logger.error("No authorized devices configured; aborting fetch")
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["status"] = "failed"
                progress_tracker["fetch_and_store_trips"][
                    "message"
                ] = "No authorized devices configured"
            return all_new_trips

        session = await get_session()
        token = await get_access_token(session, credentials)
        if not token:
            logger.error("Failed to obtain access token; aborting fetch")
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["status"] = "failed"
                progress_tracker["fetch_and_store_trips"][
                    "message"
                ] = "Failed to obtain access token"
            return all_new_trips

        # Initialize TripService once
        trip_service = TripService(MAPBOX_ACCESS_TOKEN)

        # Build chunk windows (7-day slices per device)
        chunk_windows: list[tuple[str, datetime, datetime]] = []
        for imei in authorized_devices:
            current_start = start_dt
            while current_start < end_dt:
                current_end = min(current_start + timedelta(days=7), end_dt)
                chunk_windows.append((imei, current_start, current_end))
                current_start = current_end

        if not chunk_windows:
            return all_new_trips

        # Concurrency control - get from credentials config
        max_concurrency = credentials.get("fetch_concurrency", 12)
        if not isinstance(max_concurrency, int) or max_concurrency < 1:
            max_concurrency = 12
        semaphore = asyncio.Semaphore(max_concurrency)
        completed_chunks = 0
        progress_lock = asyncio.Lock()
        total_chunks = len(chunk_windows)

        async def process_chunk(imei: str, s: datetime, e: datetime) -> list[dict]:
            async with semaphore:
                try:
                    raw_trips_chunk = await fetch_trips_for_device(
                        session,
                        token,
                        imei,
                        s,
                        e,
                    )
                    if raw_trips_chunk:
                        logger.info(
                            "Processing %s fetched trips for device %s (do_map_match=%s)...",
                            len(raw_trips_chunk),
                            imei,
                            do_map_match,
                        )
                        processed_transaction_ids = (
                            await trip_service.process_bouncie_trips(
                                raw_trips_chunk,
                                do_map_match=do_map_match,
                                progress_tracker=progress_tracker,
                            )
                        )
                        return [
                            {"transactionId": t.get("transactionId"), "imei": imei}
                            for t in raw_trips_chunk
                            if t.get("transactionId") in processed_transaction_ids
                        ]
                    else:
                        logger.info(
                            "Fetched 0 trips for device %s in range %s to %s",
                            imei,
                            s,
                            e,
                        )
                    return []
                finally:
                    nonlocal completed_chunks
                    async with progress_lock:
                        completed_chunks += 1
                        if progress_tracker is not None and total_chunks:
                            pct = (completed_chunks / total_chunks) * 100
                            progress_tracker["fetch_and_store_trips"]["progress"] = pct
                            progress_tracker["fetch_and_store_trips"][
                                "message"
                            ] = f"Processed {completed_chunks}/{total_chunks} chunks"

        # Kick off tasks in parallel
        tasks = [process_chunk(imei, s, e) for (imei, s, e) in chunk_windows]
        results = await asyncio.gather(*tasks, return_exceptions=False)

        # Flatten results
        for lst in results:
            if lst:
                all_new_trips.extend(lst)
    except Exception as e:
        logger.error(
            "Error in fetch_bouncie_trips_in_range: %s",
            e,
            exc_info=True,
        )
        if progress_tracker is not None:
            progress_tracker["fetch_and_store_trips"]["status"] = "failed"
            progress_tracker["fetch_and_store_trips"]["message"] = f"Error: {e}"
    finally:
        if (
            progress_tracker is not None
            and progress_tracker["fetch_and_store_trips"]["status"] != "failed"
        ):
            progress_tracker["fetch_and_store_trips"]["status"] = "completed"
            progress_tracker["fetch_and_store_trips"]["progress"] = 100
            progress_tracker["fetch_and_store_trips"][
                "message"
            ] = f"Completed fetch and processing. Found {len(all_new_trips)} new/updated trips."
    logger.info(
        "fetch_bouncie_trips_in_range finished, returning %d trips.", len(all_new_trips)
    )
    return all_new_trips
