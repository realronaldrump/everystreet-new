import json
import math
import logging
import asyncio
import aiohttp
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads
import os
from typing import List, Dict, Any, Optional

from utils import validate_trip_data, reverse_geocode_nominatim
from db import matched_trips_collection

MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")
MAX_MAPBOX_COORDINATES = 100

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)


def haversine_single(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    R = 6371000.0
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
                                        # skipcq: FLK-E501
                                        "Sleeping %.1f sec before retry... (attempt %d/%d)",
                                        wait_time,
                                        attempt,
                                        max_attempts_for_429,
                                    )
                                    await asyncio.sleep(wait_time)
                                    attempt += 1
                                    continue
                                raise ClientResponseError(
                                    response.request_info,
                                    response.history,
                                    status=429,
                                    message="Too Many Requests",
                                )
                            response.raise_for_status()
                            return await response.json()
                    except ClientResponseError as e:
                        if e.status != 429:
                            raise
                        raise
                    except (ClientConnectorError, asyncio.TimeoutError) as e:
                        logger.warning("Mapbox network error: %s", str(e))
                        raise

        async def match_chunk(
            chunk_coords: List[List[float]], depth: int = 0
        ) -> Optional[List[List[float]]]:
            if len(chunk_coords) < 2:
                return []
            try:
                data = await call_mapbox_api(chunk_coords)
                if data.get("code") == "Ok" and data.get("matchings"):
                    return data["matchings"][0]["geometry"]["coordinates"]
                logger.warning("Mapbox error: %s", data.get("message", "Unknown error"))
            except Exception:
                pass
            if depth < max_retries and len(chunk_coords) > min_sub_chunk:
                mid = len(chunk_coords) // 2
                first_half = chunk_coords[:mid]
                second_half = chunk_coords[mid:]
                m1 = await match_chunk(first_half, depth + 1)
                m2 = await match_chunk(second_half, depth + 1)
                if m1 is not None and m2 is not None:
                    if m1 and m2 and m1[-1] == m2[0]:
                        m2 = m2[1:]
                    return m1 + m2
            logger.error(
                "Chunk of size %d failed after %d retries.", len(chunk_coords), depth
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
                if final_matched[-1] == result[0]:
                    result = result[1:]
                final_matched.extend(result)

        def detect_big_jumps(
            coords: List[List[float]], threshold_m: float = 200
        ) -> List[int]:
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

        max_jump_passes = 2
        for _ in range(max_jump_passes):
            jumps = detect_big_jumps(final_matched, jump_threshold_m)
            if not jumps:
                break
            new_coords = final_matched[:]
            offset = 0
            for j in jumps:
                i = j + offset
                if i < 1 or i >= len(new_coords) - 1:
                    continue
                sub = new_coords[i - 1 : i + 2]
                local = await match_chunk(sub, depth=0)
                if local and len(local) >= 2:
                    new_coords = new_coords[: i - 1] + local + new_coords[i + 2 :]
                    offset += len(local) - 3
            final_matched = new_coords

        logger.info("Final matched coordinates count: %d", len(final_matched))
        return {
            "code": "Ok",
            "matchings": [
                {"geometry": {"type": "LineString", "coordinates": final_matched}}
            ],
        }


async def process_and_map_match_trip(trip: Dict[str, Any]) -> None:
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
            logger.info("Trip %s already matched; skipping.", trip["transactionId"])
            return
        gps = (
            trip["gps"] if isinstance(trip["gps"], dict) else geojson_loads(trip["gps"])
        )
        coords = gps.get("coordinates", [])
        if len(coords) < 2:
            logger.warning(
                "Trip %s has insufficient coordinates for map matching.",
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
            "Stored map–matched trip %s with %d coordinates.",
            trip["transactionId"],
            len(match_result["matchings"][0]["geometry"]["coordinates"]),
        )
    except Exception as e:
        logger.error(
            "Error processing map match for trip %s: %s",
            trip.get("transactionId"),
            e,
            exc_info=True,
        )
