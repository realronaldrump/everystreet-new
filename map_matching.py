import json
import math
import logging
import asyncio
import aiohttp
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads
import os
from typing import List, Dict, Any, Optional, Tuple

from utils import validate_trip_data, reverse_geocode_nominatim
from db import matched_trips_collection

MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")
if not MAPBOX_ACCESS_TOKEN:
    logging.warning("MAPBOX_ACCESS_TOKEN environment variable is not set")

MAX_MAPBOX_COORDINATES = 100

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)


def haversine_single(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """
    Calculate the great circle distance between two points
    on the earth (specified in decimal degrees).
    """
    R = 6371000.0  # Earth radius in meters
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


async def map_match_coordinates(
    coordinates: List[List[float]],
    chunk_size: int = 100,
    overlap: int = 10,
    max_retries: int = 2,
    min_sub_chunk: int = 20,
    jump_threshold_m: float = 200.0,
) -> Dict[str, Any]:
    """
    Match a list of coordinates to the road network using Mapbox API.

    Args:
        coordinates: List of [longitude, latitude] pairs
        chunk_size: Maximum number of coordinates to send in a single request
        overlap: Number of overlapping coordinates between chunks
        max_retries: Maximum number of times to retry failed requests
        min_sub_chunk: Minimum size of a sub-chunk when splitting failed chunks
        jump_threshold_m: Distance threshold in meters to detect jumps

    Returns:
        Dictionary with matching results or error information
    """
    if not MAPBOX_ACCESS_TOKEN:
        return {
            "code": "Error",
            "message": "MAPBOX_ACCESS_TOKEN is not set",
        }

    if len(coordinates) < 2:
        logger.warning("Insufficient coordinates for map matching.")
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }

    # Ensure coordinates are within valid ranges
    for i, (lon, lat) in enumerate(coordinates):
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            logger.warning(f"Invalid coordinate at index {i}: {lon}, {lat}")
            return {
                "code": "Error",
                "message": f"Invalid coordinate at index {i}: {lon}, {lat}",
            }

    semaphore = asyncio.Semaphore(2)
    async with aiohttp.ClientSession() as session:

        async def call_mapbox_api(
            coords: List[List[float]], attempt: int = 1
        ) -> Dict[str, Any]:
            """Call the Mapbox Map Matching API with the given coordinates."""
            if not coords:
                return {"code": "Error", "message": "Empty coordinates list"}

            base_url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
            coords_str = ";".join(f"{lon},{lat}" for lon, lat in coords)
            url = base_url + coords_str
            params = {
                "access_token": MAPBOX_ACCESS_TOKEN,
                "geometries": "geojson",
                "radiuses": ";".join("25" for _ in coords),
                "overview": "full",
            }
            max_attempts_for_429 = 5
            backoff_seconds = 2
            async with semaphore:
                for current_attempt in range(1, max_attempts_for_429 + 1):
                    try:
                        async with session.get(
                            url, params=params, timeout=30
                        ) as response:
                            if response.status == 429:
                                logger.warning(
                                    "Received 429 Too Many Requests. Attempt=%d",
                                    current_attempt,
                                )
                                retry_after = response.headers.get("Retry-After")
                                wait_time = (
                                    float(retry_after)
                                    if retry_after is not None
                                    else backoff_seconds * current_attempt
                                )
                                if current_attempt < max_attempts_for_429:
                                    logger.info(
                                        "Sleeping %.1f sec before retry... (attempt %d/%d)",
                                        wait_time,
                                        current_attempt,
                                        max_attempts_for_429,
                                    )
                                    await asyncio.sleep(wait_time)
                                    continue
                                raise ClientResponseError(
                                    response.request_info,
                                    response.history,
                                    status=429,
                                    message="Too Many Requests",
                                )
                            response.raise_for_status()
                            return await response.json()
                    except (
                        ClientResponseError,
                        ClientConnectorError,
                        asyncio.TimeoutError,
                    ) as e:
                        logger.warning("Mapbox API error: %s", str(e))
                        if (
                            current_attempt >= max_attempts_for_429
                            or not isinstance(e, ClientResponseError)
                            or e.status != 429
                        ):
                            raise
                return {
                    "code": "Error",
                    "message": "Failed after multiple retry attempts",
                }

        async def match_chunk(
            chunk_coords: List[List[float]], depth: int = 0
        ) -> Optional[List[List[float]]]:
            """Process a chunk of coordinates for map matching, with recursive retry capability."""
            if len(chunk_coords) < 2:
                return []

            try:
                data = await call_mapbox_api(chunk_coords)
                if (
                    data.get("code") == "Ok"
                    and data.get("matchings")
                    and data["matchings"]
                ):
                    return data["matchings"][0]["geometry"]["coordinates"]
                logger.warning("Mapbox error: %s", data.get("message", "Unknown error"))
            except Exception as e:
                logger.warning(f"Error matching chunk: {str(e)}")

            # If we're here, the request failed - try to split the chunk
            if depth < max_retries and len(chunk_coords) > min_sub_chunk:
                mid = len(chunk_coords) // 2
                first_half = chunk_coords[:mid]
                second_half = chunk_coords[mid - 1 :]  # Include overlap point

                m1 = await match_chunk(first_half, depth + 1)
                m2 = await match_chunk(second_half, depth + 1)

                if m1 is not None and m2 is not None:
                    # Merge the results, avoiding duplicates
                    if m1 and m2 and m1[-1] == m2[0]:
                        m2 = m2[1:]
                    return m1 + m2

            logger.error(
                "Chunk of size %d failed after %d retries.", len(chunk_coords), depth
            )
            return None

        # Split coordinates into overlapping chunks
        n = len(coordinates)
        chunk_indices: List[Tuple[int, int]] = []
        start_idx = 0

        while start_idx < n:
            end_idx = min(start_idx + chunk_size, n)
            chunk_indices.append((start_idx, end_idx))
            if end_idx == n:
                break
            start_idx = end_idx - overlap

        final_matched: List[List[float]] = []

        for start_i, end_i in chunk_indices:
            chunk_coords = coordinates[start_i:end_i]
            result = await match_chunk(chunk_coords, depth=0)

            if result is None:
                msg = f"Chunk from index {start_i} to {end_i} failed map matching."
                logger.error(msg)
                return {"code": "Error", "message": msg}

            if not final_matched:
                final_matched = result
            else:
                # Avoid duplicate points when connecting chunks
                if final_matched and result and final_matched[-1] == result[0]:
                    result = result[1:]
                final_matched.extend(result)

        def detect_big_jumps(
            coords: List[List[float]], threshold_m: float = 200
        ) -> List[int]:
            """Detect unrealistic jumps in the matched route."""
            indices = []
            for i in range(len(coords) - 1):
                if (
                    haversine_single(
                        coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]
                    )
                    > threshold_m
                ):
                    indices.append(i)
            return indices

        # Fix jumps in the matched route
        max_jump_passes = 2
        for pass_num in range(max_jump_passes):
            jumps = detect_big_jumps(final_matched, jump_threshold_m)
            if not jumps:
                break

            logger.info(f"Jump fix pass {pass_num+1}: Found {len(jumps)} jumps")
            new_coords = final_matched[:]
            offset = 0

            for j in jumps:
                i = j + offset
                if i < 1 or i >= len(new_coords) - 1:
                    continue

                # Create a sub-chunk around the jump
                sub = new_coords[i - 1 : i + 2]
                local = await match_chunk(sub, depth=0)

                if local and len(local) >= 2:
                    # Replace the jump with better matched points
                    new_coords = new_coords[: i - 1] + local + new_coords[i + 2 :]
                    offset += len(local) - 3

            final_matched = new_coords

        if not final_matched:
            return {"code": "Error", "message": "Failed to match any coordinates"}

        logger.info("Final matched coordinates count: %d", len(final_matched))
        return {
            "code": "Ok",
            "matchings": [
                {"geometry": {"type": "LineString", "coordinates": final_matched}}
            ],
        }


async def process_and_map_match_trip(trip: Dict[str, Any]) -> Dict[str, Any]:
    """
    Process a trip and match its GPS coordinates to the road network.

    Args:
        trip: Dictionary containing trip data

    Returns:
        Dictionary with processing status information
    """
    try:
        # Validate the trip data
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(
                "Trip %s failed validation: %s",
                trip.get("transactionId", "?"),
                error_message,
            )
            return {"status": "error", "message": error_message}

        # Check if the trip has already been processed
        transaction_id = trip.get("transactionId")
        if not transaction_id:
            return {"status": "error", "message": "Missing transactionId"}

        existing = await matched_trips_collection.find_one(
            {"transactionId": transaction_id}
        )
        if existing:
            logger.info("Trip %s already matched; skipping.", transaction_id)
            return {"status": "skipped", "message": "Trip already processed"}

        # Extract and validate GPS coordinates
        try:
            gps = (
                trip["gps"]
                if isinstance(trip["gps"], dict)
                else geojson_loads(trip["gps"])
            )
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            logger.error(
                f"Failed to parse GPS data for trip {transaction_id}: {str(e)}"
            )
            return {"status": "error", "message": f"Invalid GPS data: {str(e)}"}

        coords = gps.get("coordinates", [])
        if len(coords) < 2:
            logger.warning(
                "Trip %s has insufficient coordinates for map matching.",
                transaction_id,
            )
            return {"status": "error", "message": "Insufficient coordinates"}

        # Perform map matching
        match_result = await map_match_coordinates(coords)
        if match_result.get("code") != "Ok":
            logger.error(
                "Map matching failed for trip %s: %s",
                transaction_id,
                match_result.get("message", "Unknown error"),
            )
            return {
                "status": "error",
                "message": match_result.get("message", "Map matching failed"),
            }

        # Create a copy of the trip with the matched coordinates
        matched_trip = trip.copy()
        matched_trip.pop("_id", None)  # Remove MongoDB's _id if present

        # Ensure GPS data is serialized as a string
        if not isinstance(matched_trip["gps"], str):
            matched_trip["gps"] = json.dumps(matched_trip["gps"])

        # Add the matched GPS coordinates
        matched_trip["matchedGps"] = match_result["matchings"][0]["geometry"]

        # Add location information via reverse geocoding
        try:
            coordinates = match_result["matchings"][0]["geometry"]["coordinates"]
            if coordinates:
                first_lon, first_lat = coordinates[0]
                city_info = await reverse_geocode_nominatim(first_lat, first_lon)
                if city_info:
                    matched_trip["location"] = city_info.get("display_name", "Unknown")
            else:
                logger.warning(f"No matched coordinates for trip {transaction_id}")
        except Exception as ge_err:
            logger.warning(
                "Reverse geocode error for trip %s: %s",
                transaction_id,
                ge_err,
            )

        # Store the matched trip
        await matched_trips_collection.insert_one(matched_trip)
        logger.info(
            "Stored map-matched trip %s with %d coordinates.",
            transaction_id,
            len(match_result["matchings"][0]["geometry"]["coordinates"]),
        )

        return {
            "status": "success",
            "message": "Trip successfully processed",
            "coordinates_count": len(
                match_result["matchings"][0]["geometry"]["coordinates"]
            ),
        }

    except Exception as e:
        logger.error(
            "Error processing map match for trip %s: %s",
            trip.get("transactionId", "?"),
            e,
            exc_info=True,
        )
        return {"status": "error", "message": f"Processing error: {str(e)}"}
