import json
import math
import logging
import asyncio
import aiohttp
import numpy as np
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads
from dotenv import load_dotenv
import os
from dateutil import parser
from datetime import datetime, timedelta

from utils import validate_trip_data, reverse_geocode_nominatim
from db import matched_trips_collection

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

# We'll keep this set to 100, but we'll chunk manually with overlap
MAX_MAPBOX_COORDINATES = 100

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


def haversine_single(lon1, lat1, lon2, lat2):
    """
    Simple haversine distance between two points in meters.
    """
    R = 6371000.0  # radius of Earth in meters
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
    coordinates,
    chunk_size=100,
    overlap=10,
    max_retries=2,
    min_sub_chunk=20,
    jump_threshold_m=200.0,
):
    """
    Map-match coordinates via the Mapbox API, with:
      - Overlapping chunks
      - Retry-based sub-chunk splitting if chunk fails
      - Final jump detection & local re-match to remove big diagonal lines

    :param coordinates: List of [lon, lat] pairs
    :param chunk_size:  Max # of points to send to Mapbox per chunk (<= 100)
    :param overlap:     # of overlapping points between consecutive chunks
    :param max_retries: Times to retry chunk splitting if an API call fails
    :param min_sub_chunk: Minimum sub-chunk size during fallback splitting
    :param jump_threshold_m: Gap distance (in meters) that we consider a suspicious jump
    :return: dict with "code": "Ok" or "Error", and on success "matchings" -> geometry
    """
    if len(coordinates) < 2:
        logger.warning("Insufficient coordinates for map matching.")
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }

    async def call_mapbox_api(coords):
        """
        Call the Mapbox Map Matching API for a single chunk of coords.
        coords is a list of [lon, lat].
        Returns the API JSON or raises an Exception if there's an error.
        """
        base_url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
        coords_str = ";".join(f"{lon},{lat}" for lon, lat in coords)
        url = base_url + coords_str
        params = {
            "access_token": MAPBOX_ACCESS_TOKEN,
            "geometries": "geojson",
            # We'll keep radius=25 to ensure we only match close to the real road
            "radiuses": ";".join("25" for _ in coords),
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as response:
                response.raise_for_status()
                data = await response.json()
                return data

    async def match_chunk(chunk_coords, depth=0):
        """
        Recursively attempt to map-match the given chunk. If it fails:
          - we split the chunk into sub-chunks (2 halves) and try again
          - up to max_retries times
        Returns None on total failure, or a list of [lon, lat] for the matched geometry.
        """
        if len(chunk_coords) < 2:
            return []
        if len(chunk_coords) > 100:
            logger.error("Logic error: match_chunk got >100 coords unexpectedly.")
            return []

        try:
            data = await call_mapbox_api(chunk_coords)
            if data.get("code") == "Ok":
                # We'll just use the first matching from the results.
                matched_coords = data["matchings"][0]["geometry"]["coordinates"]
                return matched_coords
            else:
                msg = data.get("message", "Mapbox error (code != Ok)")
                logger.warning("Mapbox chunk error: %s", msg)
        except (ClientResponseError, ClientConnectorError) as e:
            logger.warning("Mapbox chunk network error: %s", str(e))
        except asyncio.TimeoutError:
            logger.warning("Mapbox chunk request timed out.")
        except Exception as exc:
            logger.warning("Unexpected error in mapbox chunk: %s", str(exc))

        # If we reach here, we had an error or non-Ok result.
        if depth < max_retries and len(chunk_coords) > min_sub_chunk:
            # We'll attempt sub-splitting the chunk into two halves.
            mid = len(chunk_coords) // 2
            first_half = chunk_coords[:mid]
            second_half = chunk_coords[mid:]
            logger.info(
                "Retry chunk of size %d by splitting into sub-chunks: %d, %d (depth=%d)",
                len(chunk_coords),
                len(first_half),
                len(second_half),
                depth,
            )
            matched_first = await match_chunk(first_half, depth + 1)
            matched_second = await match_chunk(second_half, depth + 1)
            if matched_first is not None and matched_second is not None:
                # Stitch them by removing duplicate boundary if needed
                if matched_first and matched_second:
                    if matched_first[-1] == matched_second[0]:
                        matched_second = matched_second[1:]
                return matched_first + matched_second

        # Total fail
        logger.error(
            "Chunk of size %d failed after %d retries, giving up.",
            len(chunk_coords),
            depth,
        )
        return None

    # Step 1: Build chunk indices with overlap
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
        "Splitting %d coords into %d chunk(s) w/ chunk_size=%d overlap=%d",
        n,
        len(chunk_indices),
        chunk_size,
        overlap,
    )

    # Step 2: Map-match each chunk, stitch them carefully
    final_matched = []
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
            # If a chunk absolutely fails, we bail out
            msg = f"Chunk {cindex} of {len(chunk_indices)} failed map matching."
            logger.error(msg)
            return {"code": "Error", "message": msg}

        if not final_matched:
            # first chunk
            final_matched = result
        else:
            # Attempt to remove any overlap duplication
            if final_matched[-1] == result[0]:
                result = result[1:]
            final_matched.extend(result)

    logger.info(
        "Stitched matched coords from all chunks, total points=%d", len(final_matched)
    )

    # Step 3: “Jump Detection” – detect large leaps, attempt local re-match
    # We scan final_matched for suspicious big jumps. If found, we attempt
    # a smaller re-match from i-1 to i+1 around that jump.
    # We'll do this in a loop until no large jumps remain or we exceed max passes.
    def detect_big_jumps(coords, threshold_m=200):
        """
        Return list of indices i where distance from coords[i] to coords[i+1] > threshold_m
        """
        suspicious_indices = []
        for i in range(len(coords) - 1):
            lon1, lat1 = coords[i]
            lon2, lat2 = coords[i + 1]
            dist_m = haversine_single(lon1, lat1, lon2, lat2)
            if dist_m > threshold_m:
                suspicious_indices.append(i)
        return suspicious_indices

    max_jump_passes = 2
    pass_count = 0

    while pass_count < max_jump_passes:
        big_jumps = detect_big_jumps(final_matched, jump_threshold_m)
        if not big_jumps:
            break  # no suspicious leaps, done
        logger.info(
            "Found %d suspicious jump(s) on pass %d", len(big_jumps), pass_count + 1
        )

        # We'll fix them from left to right. But each fix might change indexing,
        # so we'll keep track of how many we've done.
        fix_count = 0
        new_coords = final_matched[:]
        offset = 0  # offset in new_coords indexing
        for j_idx in big_jumps:
            i = j_idx + offset
            if i < 1 or i >= len(new_coords) - 1:
                # can't fix a jump at boundary
                continue

            # We'll try re-matching the sub-segment from i-1..i+2 if that exists
            start_sub = i - 1
            end_sub = i + 2
            if end_sub > len(new_coords):
                end_sub = len(new_coords)

            sub_coords = new_coords[start_sub:end_sub]
            if len(sub_coords) < 2:
                continue

            # attempt local re-match
            local_match = await match_chunk(sub_coords, depth=0)
            if local_match and len(local_match) >= 2:
                logger.info(
                    "Re-matched sub-segment around index %d, replaced %d points",
                    i,
                    (end_sub - start_sub),
                )
                # We'll splice local_match in place of sub_coords
                new_coords = new_coords[:start_sub] + local_match + new_coords[end_sub:]
                # Adjust offset so further jump indices are correct
                offset += len(local_match) - (end_sub - start_sub)
                fix_count += 1
            else:
                logger.info(
                    "Local re-match for sub-segment around index %d failed, leaving it as is",
                    i,
                )

        final_matched = new_coords
        pass_count += 1
        if fix_count == 0:
            # No fixes were performed; no reason to keep looping
            break

    # Done jump detection attempts
    logger.info(
        "Final matched coords after jump detection: %d points", len(final_matched)
    )

    return {
        "code": "Ok",
        "matchings": [
            {
                "geometry": {
                    "type": "LineString",
                    "coordinates": final_matched,
                },
            }
        ],
    }


async def process_and_map_match_trip(trip):
    """
    Process a single trip (validate + map-match):
      - Validate trip
      - Extract coordinates
      - Map match each segment
      - Store matched coords
      - Insert into matched_trips_collection
    """
    try:
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(
                "Trip %s failed validation: %s",
                trip.get("transactionId", "?"),
                error_message,
            )
            return

        # Check if already matched
        existing = await matched_trips_collection.find_one(
            {"transactionId": trip["transactionId"]}
        )
        if existing:
            logger.info("Trip %s is already matched; skipping.", trip["transactionId"])
            return

        # Extract GPS data
        if isinstance(trip["gps"], dict):
            gps_data = trip["gps"]
        else:
            gps_data = geojson_loads(trip["gps"])

        coords = gps_data.get("coordinates", [])
        if not coords or len(coords) < 2:
            logger.warning(
                "Trip %s has insufficient coords for map matching",
                trip.get("transactionId"),
            )
            return

        # Map match the coordinates
        match_result = await map_match_coordinates(coords)
        if match_result.get("code") != "Ok":
            logger.error(
                "Map matching failed for trip %s: %s",
                trip.get("transactionId"),
                match_result.get("message", "Unknown error"),
            )
            return

        matched_trip = trip.copy()
        # Convert original gps to string if needed
        if isinstance(matched_trip["gps"], dict):
            matched_trip["gps"] = json.dumps(matched_trip["gps"])

        matched_trip["matchedGps"] = match_result["matchings"][0]["geometry"]

        # Optionally update location via reverse geocode for the first matched point
        try:
            first_lon, first_lat = match_result["matchings"][0]["geometry"][
                "coordinates"
            ][0]
            city_info = await reverse_geocode_nominatim(first_lat, first_lon)
            if city_info:
                matched_trip["location"] = city_info.get("display_name", "Unknown")
        except Exception as ge_err:
            logger.warning(
                "Reverse geocode error for trip %s: %s",
                trip.get("transactionId", "?"),
                ge_err,
            )

        await matched_trips_collection.insert_one(matched_trip)
        logger.info(
            "Stored map–matched trip %s with %d coords in matched_trips.",
            trip["transactionId"],
            len(match_result["matchings"][0]["geometry"]["coordinates"]),
        )

    except Exception as e:
        logger.error(
            "Error in process_and_map_match_trip for trip %s: %s",
            trip.get("transactionId"),
            e,
            exc_info=True,
        )
