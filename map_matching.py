"""
Map matching module.
Divides trip coordinate sequences into overlapping chunks,
calls Mapbox API with retries and fallback splitting, performs jump detection,
and stores the matched trip.
"""

import json
import math
import logging
import asyncio
import aiohttp
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads
from dotenv import load_dotenv
import os
from typing import List, Dict, Any, Optional
from dateutil import parser as dateutil_parse

from utils import validate_trip_data, reverse_geocode_nominatim
from db import matched_trips_collection

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

MAX_MAPBOX_COORDINATES = 100

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


def haversine_single(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    R = 6371000.0  # Earth's radius in meters
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
    if len(coordinates) < 2:
        logger.warning("Insufficient coordinates for map matching.")
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }
    semaphore = asyncio.Semaphore(2)
    async with aiohttp.ClientSession() as session:

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
            backoff_seconds = 2
            async with semaphore:
                while True:
                    try:
                        async with session.get(url, params=params) as response:
                            if response.status == 429:
                                logger.warning(
                                    "Received 429 Too Many Requests. Attempt=%d",
                                    attempt,
                                )
                                retry_after = response.headers.get("Retry-After")
                                wait_time = (
                                    float(retry_after)
                                    if retry_after is not None
                                    else backoff_seconds * attempt
                                )
                                if attempt < max_attempts_for_429:
                                    logger.info(
                                        "Sleeping %.1f sec before retry... (attempt %d/%d)",
                                        wait_time,
                                        attempt,
                                        max_attempts_for_429,
                                    )
                                    await asyncio.sleep(wait_time)
                                    attempt += 1
                                    continue
                                else:
                                    logger.error(
                                        "Gave up after %d attempts for 429 errors.",
                                        attempt,
                                    )
                                    raise ClientResponseError(
                                        response.request_info,
                                        response.history,
                                        status=429,
                                        message="Too Many Requests (exceeded max attempts)",
                                    )
                            response.raise_for_status()
                            data = await response.json()
                            return data
                    except ClientResponseError as e:
                        if e.status != 429:
                            raise
                        else:
                            raise
                    except (ClientConnectorError, asyncio.TimeoutError) as e:
                        logger.warning("Mapbox network error for chunk: %s", str(e))
                        raise

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
                else:
                    msg = data.get("message", "Mapbox API error (code != Ok)")
                    logger.warning("Mapbox chunk error: %s", msg)
            except ClientResponseError as cre:
                if cre.status == 429:
                    logger.error(
                        "Still receiving 429 after backoff. Failing chunk of size %d.",
                        len(chunk_coords),
                    )
                else:
                    logger.warning("Mapbox HTTP error for chunk: %s", str(cre))
            except Exception as exc:
                logger.warning("Unexpected error in mapbox chunk: %s", str(exc))
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
                msg = f"Chunk {cindex} of {len(chunk_indices)} failed map matching."
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
                if haversine_single(lon1, lat1, lon2, lat2) > threshold_m:
                    suspicious_indices.append(i)
            return suspicious_indices

        max_jump_passes = 2
        pass_count = 0
        while pass_count < max_jump_passes:
            big_jumps = detect_big_jumps(final_matched, jump_threshold_m)
            if not big_jumps:
                break
            logger.info(
                "Found %d suspicious jump(s) on pass %d", len(big_jumps), pass_count + 1
            )
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
                        "Local re-match for sub-segment around index %d failed, leaving as is",
                        i,
                    )
            final_matched = new_coords
            pass_count += 1
            if fix_count == 0:
                break

        logger.info(
            "Final matched coords after jump detection: %d points", len(final_matched)
        )
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
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(
                "Trip %s failed validation: %s",
                trip.get("transactionId", "?"),
                error_message,
            )
            return
        existing = await matched_trips_collection.find_one(
            {"transactionId": trip["transactionId"]}
        )
        if existing:
            logger.info("Trip %s is already matched; skipping.", trip["transactionId"])
            return
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
        match_result = await map_match_coordinates(coords)
        if match_result.get("code") != "Ok":
            logger.error(
                "Map matching failed for trip %s: %s",
                trip.get("transactionId"),
                match_result.get("message", "Unknown error"),
            )
            return
        matched_trip = trip.copy()
        matched_trip.pop("_id", None)
        if not isinstance(matched_trip["gps"], str):
            matched_trip["gps"] = json.dumps(matched_trip["gps"])
        matched_trip["matchedGps"] = match_result["matchings"][0]["geometry"]
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
