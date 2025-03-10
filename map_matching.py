"""
Map matching module.
Divides trip coordinate sequences into overlapping chunks,
calls Mapbox API with retries and fallback splitting, performs jump detection,
and stores the matched trip.
"""

import json
import logging
import asyncio
import aiohttp
import time
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads
from dotenv import load_dotenv
import os
from typing import List, Dict, Any, Optional, Tuple

from utils import validate_trip_data, reverse_geocode_nominatim, haversine
from db import matched_trips_collection, db_manager

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

MAX_MAPBOX_COORDINATES = 100

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Rate limiting configuration
MAX_REQUESTS_PER_MINUTE = 60  # Mapbox free tier limit
RATE_LIMIT_WINDOW = 60  # seconds
MAPBOX_REQUEST_COUNT = 0
MAPBOX_WINDOW_START = time.time()
RATE_LIMIT_LOCK = asyncio.Lock()


async def check_rate_limit() -> Tuple[bool, float]:
    """
    Check if we're about to exceed the rate limit.
    Returns (True, wait_time) if we need to wait, (False, 0) otherwise.
    """
    global MAPBOX_REQUEST_COUNT, MAPBOX_WINDOW_START

    async with RATE_LIMIT_LOCK:
        current_time = time.time()
        elapsed = current_time - MAPBOX_WINDOW_START

        # Reset window if it's been longer than the window duration
        if elapsed > RATE_LIMIT_WINDOW:
            MAPBOX_REQUEST_COUNT = 0
            MAPBOX_WINDOW_START = current_time
            return False, 0

        # Check if we're about to exceed the rate limit
        if MAPBOX_REQUEST_COUNT >= MAX_REQUESTS_PER_MINUTE:
            # Calculate time to wait until the window resets
            wait_time = RATE_LIMIT_WINDOW - elapsed
            return True, max(0.1, wait_time)

        # Increment the request count
        MAPBOX_REQUEST_COUNT += 1
        return False, 0


async def map_match_coordinates(
    coordinates: List[List[float]],
    chunk_size: int = 100,
    overlap: int = 10,
    max_retries: int = 3,
    min_sub_chunk: int = 20,
    jump_threshold_m: float = 200.0,
) -> Dict[str, Any]:
    if len(coordinates) < 2:
        logger.warning("Insufficient coordinates for map matching.")
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }

    # Use a smaller semaphore to limit concurrent API calls
    semaphore = asyncio.Semaphore(3)

    # Create a session with proper configuration
    timeout = aiohttp.ClientTimeout(
        total=30,
        connect=10,
        sock_connect=10,
        sock_read=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:

        async def call_mapbox_api(
            coords: List[List[float]], attempt: int = 1
        ) -> Dict[str, Any]:
            base_url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
            coords_str = ";".join(f"{lon},{lat}" for lon, lat in coords)
            url = base_url + coords_str
            params = {
                "access_token": MAPBOX_ACCESS_TOKEN,
                "geometries": "geojson",
                "radiuses": ";".join("25" for _ in coords),
            }

            max_attempts_for_429 = 5
            min_backoff_seconds = 2

            async with semaphore:
                for retry_attempt in range(1, max_attempts_for_429 + 1):
                    # Check rate limiting before making request
                    should_wait, wait_time = await check_rate_limit()
                    if should_wait:
                        logger.info(
                            "Rate limit approaching - waiting %.2f seconds before API call", wait_time, )
                        await asyncio.sleep(wait_time)

                    try:
                        async with session.get(url, params=params) as response:
                            if response.status == 429:
                                logger.warning(
                                    "Received 429 Too Many Requests. Attempt=%d", retry_attempt, )
                                retry_after = response.headers.get(
                                    "Retry-After")
                                wait_time = (
                                    float(retry_after)
                                    if retry_after is not None
                                    else min_backoff_seconds
                                    * (2 ** (retry_attempt - 1))
                                )
                                if retry_attempt < max_attempts_for_429:
                                    logger.info(
                                        "Sleeping %.1f seconds before retry... (attempt %d/%d)",
                                        wait_time,
                                        retry_attempt,
                                        max_attempts_for_429,
                                    )
                                    await asyncio.sleep(wait_time)
                                    continue
                                else:
                                    logger.error(
                                        "Gave up after %d attempts for 429 errors.", retry_attempt, )
                                    raise ClientResponseError(
                                        response.request_info,
                                        response.history,
                                        status=429,
                                        message="Too Many Requests (exceeded max attempts)",
                                    )

                            # Check for other error responses
                            if 400 <= response.status < 500:
                                error_text = await response.text()
                                logger.warning(
                                    "Mapbox API client error: %d - %s",
                                    response.status,
                                    error_text,
                                )
                                return {
                                    "code": "Error",
                                    "message": f"Mapbox API error: {
                                        response.status}",
                                    "details": error_text,
                                }

                            # Handle server errors with retries
                            if response.status >= 500:
                                if retry_attempt < max_attempts_for_429:
                                    wait_time = min_backoff_seconds * (
                                        2 ** (retry_attempt - 1)
                                    )
                                    logger.warning(
                                        "Mapbox server error %d, retrying in %f seconds", response.status, wait_time, )
                                    await asyncio.sleep(wait_time)
                                    continue
                                else:
                                    error_text = await response.text()
                                    return {
                                        "code": "Error",
                                        "message": f"Mapbox server error: {
                                            response.status}",
                                        "details": error_text,
                                    }

                            response.raise_for_status()
                            data = await response.json()
                            return data

                    except ClientResponseError as e:
                        if e.status != 429:
                            if retry_attempt < max_attempts_for_429 and e.status >= 500:
                                # Retry on server errors
                                wait_time = min_backoff_seconds * (
                                    2 ** (retry_attempt - 1)
                                )
                                logger.warning(
                                    "Mapbox server error %d, retrying in %f seconds", e.status, wait_time, )
                                await asyncio.sleep(wait_time)
                                continue
                            logger.error("Mapbox API error: %s", e)
                            raise
                        else:
                            # Continue the retry loop for 429 errors
                            continue
                    except (ClientConnectorError, asyncio.TimeoutError) as e:
                        logger.warning(
                            "Mapbox network error for chunk: %s", str(e))
                        if retry_attempt < max_attempts_for_429:
                            wait_time = min_backoff_seconds * \
                                (2 ** (retry_attempt - 1))
                            logger.warning(
                                "Network error, retrying in %f seconds (attempt %d/%d)",
                                wait_time,
                                retry_attempt,
                                max_attempts_for_429,
                            )
                            await asyncio.sleep(wait_time)
                            continue
                        raise

                # This should only be reached if all retry attempts failed but
                # no exception was raised
                return {
                    "code": "Error",
                    "message": "All retry attempts failed"}

        async def match_chunk(
            chunk_coords: List[List[float]], depth: int = 0
        ) -> Optional[List[List[float]]]:
            if len(chunk_coords) < 2:
                return []
            if len(chunk_coords) > 100:
                logger.error("match_chunk received >100 coords unexpectedly.")
                return []
            try:
                data = await call_mapbox_api(chunk_coords)
                if data.get("code") == "Ok" and data.get("matchings"):
                    return data["matchings"][0]["geometry"]["coordinates"]

                # Handle different types of errors
                msg = data.get("message", "Mapbox API error (code != Ok)")
                logger.warning("Mapbox chunk error: %s", msg)

                # Special handling for invalid input
                if "invalid coordinates" in msg.lower():
                    # Try to clean up coordinates
                    filtered_coords = filter_invalid_coordinates(chunk_coords)
                    if len(filtered_coords) >= 2 and len(
                            filtered_coords) < len(chunk_coords):
                        logger.info(
                            "Retrying with %d filtered coordinates",
                            len(filtered_coords),
                        )
                        return await match_chunk(filtered_coords, depth)

            except ClientResponseError as cre:
                if cre.status == 429:
                    logger.error(
                        "Still receiving 429 after backoff. Failing chunk of size %d.",
                        len(chunk_coords),
                    )
                else:
                    logger.warning("Mapbox HTTP error for chunk: %s", str(cre))
            except Exception as exc:
                logger.warning(
                    "Unexpected error in mapbox chunk: %s", str(exc))

            # Fallback to splitting if needed and allowed
            if depth < max_retries and len(chunk_coords) > min_sub_chunk:
                mid = len(chunk_coords) // 2
                first_half = chunk_coords[:mid]
                second_half = chunk_coords[mid:]
                logger.info(
                    "Retry chunk of size %d by splitting into halves (%d, %d) at depth %d",
                    len(chunk_coords),
                    len(first_half),
                    len(second_half),
                    depth,
                )
                matched_first = await match_chunk(first_half, depth + 1)
                matched_second = await match_chunk(second_half, depth + 1)
                if matched_first is not None and matched_second is not None:
                    if (
                        matched_first
                        and matched_second
                        and matched_first[-1] == matched_second[0]
                    ):
                        matched_second = matched_second[1:]
                    return matched_first + matched_second

            logger.error(
                "Chunk of size %d failed after %d retries, giving up.",
                len(chunk_coords),
                depth,
            )
            return None

        def filter_invalid_coordinates(
                coords: List[List[float]]) -> List[List[float]]:
            """Filter out potentially invalid coordinates."""
            valid_coords = []
            for coord in coords:
                # Check for basic validity
                if (
                    len(coord) >= 2
                    and isinstance(coord[0], (int, float))
                    and isinstance(coord[1], (int, float))
                    and -180 <= coord[0] <= 180
                    and -90 <= coord[1] <= 90
                ):
                    valid_coords.append(coord)

            return valid_coords

        n = len(coordinates)
        chunk_indices = []
        start_idx = 0
        while start_idx < n:
            end_idx = min(start_idx + chunk_size, n)
            chunk_indices.append((start_idx, end_idx))
            if end_idx == n:
                break
            start_idx = end_idx - overlap

        logger.info(
            "Splitting %d coords into %d chunks (chunk_size=%d, overlap=%d)",
            n,
            len(chunk_indices),
            chunk_size,
            overlap,
        )
        final_matched: List[List[float]] = []
        for cindex, (start_i, end_i) in enumerate(chunk_indices, 1):
            chunk_coords = coordinates[start_i:end_i]
            logger.debug(
                "Matching chunk %d/%d with %d coords",
                cindex,
                len(chunk_indices),
                len(chunk_coords),
            )
            result = await match_chunk(chunk_coords, depth=0)
            if result is None:
                msg = f"Chunk {cindex} of {
                    len(chunk_indices)} failed map matching."
                logger.error(msg)
                return {"code": "Error", "message": msg}
            if not final_matched:
                final_matched = result
            else:
                if final_matched[-1] == result[0]:
                    result = result[1:]
                final_matched.extend(result)

        logger.info(
            "Stitched matched coords from all chunks, total points=%d",
            len(final_matched),
        )

        def detect_big_jumps(
            coords: List[List[float]], threshold_m: float = 200
        ) -> List[int]:
            suspicious_indices = []
            for i in range(len(coords) - 1):
                lon1, lat1 = coords[i]
                lon2, lat2 = coords[i + 1]
                distance = haversine(lon1, lat1, lon2, lat2, unit="meters")
                if distance > threshold_m:
                    suspicious_indices.append(i)
            return suspicious_indices

        max_jump_passes = 2
        pass_count = 0
        while pass_count < max_jump_passes:
            big_jumps = detect_big_jumps(final_matched, jump_threshold_m)
            if not big_jumps:
                break
            logger.info(
                "Found %d suspicious jump(s) on pass %d",
                len(big_jumps),
                pass_count + 1)
            fix_count = 0
            new_coords = final_matched[:]
            offset = 0
            for j_idx in big_jumps:
                i = j_idx + offset
                if i < 1 or i >= len(new_coords) - 1:
                    continue
                start_sub = i - 1
                end_sub = i + 2
                sub_coords = new_coords[start_sub:end_sub]
                if len(sub_coords) < 2:
                    continue
                local_match = await match_chunk(sub_coords, depth=0)
                if local_match and len(local_match) >= 2:
                    logger.info(
                        "Re-matched sub-segment around index %d, replaced %d points",
                        i,
                        (end_sub - start_sub),
                    )
                    new_coords = (
                        new_coords[:start_sub] + local_match + new_coords[end_sub:]
                    )
                    offset += len(local_match) - (end_sub - start_sub)
                    fix_count += 1
                else:
                    logger.info(
                        "Local re-match for sub-segment around index %d failed, leaving as is", i, )
            final_matched = new_coords
            pass_count += 1
            if fix_count == 0:
                break

        logger.info(
            "Final matched coords after jump detection: %d points",
            len(final_matched))
        return {
            "code": "Ok",
            "matchings": [
                {"geometry": {"type": "LineString", "coordinates": final_matched}}
            ],
        }


async def process_and_map_match_trip(trip: Dict[str, Any]) -> None:
    """
    Process a trip: validate, extract GPS, map-match via Mapbox, reverse geocode,
    and store the matched trip.
    """
    try:
        transaction_id = trip.get("transactionId", "?")

        # Skip if already processed
        async def check_existing():
            return await matched_trips_collection.find_one(
                {"transactionId": transaction_id}, {"_id": 1}
            )

        existing = await db_manager.execute_with_retry(
            check_existing,
            operation_name=f"check for existing matched trip {transaction_id}",
        )

        if existing:
            logger.info(
                "Trip %s is already matched; skipping.",
                transaction_id)
            return

        # Validate trip data
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(
                "Trip %s failed validation: %s",
                transaction_id,
                error_message,
            )
            return

        # Extract GPS data
        if isinstance(trip["gps"], dict):
            gps_data = trip["gps"]
        else:
            try:
                gps_data = geojson_loads(trip["gps"])
            except Exception as e:
                logger.error(
                    "Error parsing GPS data for trip %s: %s", transaction_id, e
                )
                return

        coords = gps_data.get("coordinates", [])
        if not coords or len(coords) < 2:
            logger.warning(
                "Trip %s has insufficient coords for map matching",
                transaction_id)
            return

        # Perform map matching with retries
        match_result = await map_match_coordinates(coords)
        if match_result.get("code") != "Ok":
            logger.error(
                "Map matching failed for trip %s: %s",
                transaction_id,
                match_result.get("message", "Unknown error"),
            )

            # Store the failure reason
            error_info = {
                "map_matching_failed": True,
                "error_message": match_result.get("message", "Unknown error"),
                "attempted_at": time.time(),
            }

            async def update_trip_with_error():
                return await matched_trips_collection.update_one(
                    {"transactionId": transaction_id}, {"$set": error_info}, upsert=True
                )

            await db_manager.execute_with_retry(
                update_trip_with_error,
                operation_name=f"update trip {transaction_id} with error info",
            )

            return

        # Create matched trip document
        matched_trip = trip.copy()
        matched_trip.pop("_id", None)

        if not isinstance(matched_trip["gps"], str):
            matched_trip["gps"] = json.dumps(matched_trip["gps"])

        matched_trip["matchedGps"] = match_result["matchings"][0]["geometry"]
        matched_trip["matched_at"] = time.time()

        # Reverse geocode if needed
        try:
            first_lon, first_lat = match_result["matchings"][0]["geometry"][
                "coordinates"
            ][0]
            city_info = await reverse_geocode_nominatim(first_lat, first_lon)
            if city_info:
                matched_trip["location"] = city_info.get(
                    "display_name", "Unknown")
        except Exception as ge_err:
            logger.warning(
                "Reverse geocode error for trip %s: %s",
                transaction_id,
                ge_err,
            )

        # Store matched trip
        async def insert_matched_trip():
            return await matched_trips_collection.insert_one(matched_trip)

        await db_manager.execute_with_retry(
            insert_matched_trip, operation_name=f"insert matched trip {transaction_id}"
        )

        logger.info(
            "Stored map–matched trip %s with %d coords in matched_trips.",
            transaction_id,
            len(match_result["matchings"][0]["geometry"]["coordinates"]),
        )
    except Exception as e:
        logger.error(
            "Error in process_and_map_match_trip for trip %s: %s",
            trip.get("transactionId"),
            e,
            exc_info=True,
        )
