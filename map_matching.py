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
from db import (
    matched_trips_collection,
)

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")
MAX_MAPBOX_COORDINATES = 100

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def map_match_coordinates(coordinates):
    """
    Given [lon, lat] coordinate pairs, call Mapbox's map matching API in chunks if
    needed, and return a dict with a matched LineString geometry.
    """
    if len(coordinates) < 2:
        logger.warning("Insufficient coordinates for map matching.")
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }

    base_url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
    chunks = [
        coordinates[i : i + MAX_MAPBOX_COORDINATES]
        for i in range(0, len(coordinates), MAX_MAPBOX_COORDINATES)
    ]

    matched_geometries = []
    async with aiohttp.ClientSession() as session:
        for index, chunk in enumerate(chunks):
            coords_str = ";".join(f"{lon},{lat}" for lon, lat in chunk)
            url = base_url + coords_str
            params = {
                "access_token": MAPBOX_ACCESS_TOKEN,
                "geometries": "geojson",
                "radiuses": ";".join("25" for _ in chunk),
            }
            try:
                async with session.get(url, params=params) as response:
                    response.raise_for_status()
                    data = await response.json()
                    if data.get("code") == "Ok":
                        part = data["matchings"][0]["geometry"]["coordinates"]
                        matched_geometries.extend(part)
                        logger.debug(
                            "Chunk %s/%s: succeeded with %d coords.",
                            index + 1,
                            len(chunks),
                            len(chunk),
                        )
                    else:
                        msg = data.get("message", "Mapbox API error")
                        logger.error(
                            "Chunk %d: Map Matching API error: %s",
                            index + 1,
                            msg,
                        )
                        return {"code": "Error", "message": msg}

            except ClientResponseError as e:
                error_data = None
                if e.response and e.response.content_type == "application/json":
                    error_data = await e.response.json()
                logger.error(
                    "Chunk %d: ClientResponseError %s - %s, URL: %s, Resp: %s",
                    index + 1,
                    e.status,
                    e.message,
                    e.request_info.url,
                    error_data,
                    exc_info=True,
                )
                return {
                    "code": "Error",
                    "message": (
                        error_data.get("message", f"Mapbox error {e.status}")
                        if error_data
                        else str(e)
                    ),
                }
            except ClientConnectorError as e:
                logger.error(
                    "Chunk %d: ClientConnectorError: %s",
                    index + 1,
                    e,
                    exc_info=True,
                )
                return {
                    "code": "Error",
                    "message": f"Connection error to Mapbox: {str(e)}",
                }
            except asyncio.TimeoutError:
                logger.error(
                    "Chunk %d: Mapbox request timed out.",
                    index + 1,
                    exc_info=True,
                )
                return {
                    "code": "Error",
                    "message": "Mapbox API request timed out.",
                }
            except Exception as e:
                logger.error(
                    "Chunk %d: Unexpected error: %s",
                    index + 1,
                    e,
                    exc_info=True,
                )
                return {"code": "Error", "message": str(e)}

    return {
        "code": "Ok",
        "matchings": [
            {
                "geometry": {
                    "type": "LineString",
                    "coordinates": matched_geometries,
                },
            }
        ],
    }


def haversine_distance_vectorized(
    coords1: np.ndarray, coords2: np.ndarray
) -> np.ndarray:
    """
    Vectorized version of haversine distance calculation that releases the GIL.
    Takes numpy arrays of shape (N, 2) where each row is [lon, lat].
    Returns distances in miles.
    """
    R = 6371.0  # Earth's radius in kilometers

    # Convert to radians
    coords1_rad = np.radians(coords1)
    coords2_rad = np.radians(coords2)

    # Differences in coordinates
    dlat = coords2_rad[:, 1] - coords1_rad[:, 1]
    dlon = coords2_rad[:, 0] - coords1_rad[:, 0]

    # Haversine formula
    a = (
        np.sin(dlat / 2) ** 2
        + np.cos(coords1_rad[:, 1]) * np.cos(coords2_rad[:, 1]) * np.sin(dlon / 2) ** 2
    )
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))

    return R * c * 0.621371  # Convert to miles


def filter_outliers_by_distance(coords_with_time, max_speed_m_s=60.0):
    """
    Filter out coordinates that would require unrealistic speeds to reach.
    Uses vectorized operations for better performance.
    """
    if len(coords_with_time) < 2:
        return coords_with_time

    # Convert coordinates to numpy array for vectorized operations
    coords = np.array([[c[0], c[1]] for c in coords_with_time])

    # Calculate distances between consecutive points
    coords_shifted = np.roll(coords, -1, axis=0)
    distances = (
        haversine_distance_vectorized(coords[:-1], coords_shifted[:-1]) * 1609.34
    )  # Convert miles to meters

    # Calculate time differences if timestamps are available
    if len(coords_with_time[0]) > 2:
        times = np.array([c[2].timestamp() for c in coords_with_time])
        times_shifted = np.roll(times, -1)
        time_diffs = times_shifted[:-1] - times[:-1]
        speeds = distances / np.maximum(time_diffs, 1e-6)  # Avoid division by zero
    else:
        # If no timestamps, assume constant time between points
        speeds = distances / 1.0  # Assume 1 second between points

    # Mark points that exceed max speed
    valid_speeds = speeds <= max_speed_m_s
    valid_indices = np.ones(len(coords_with_time), dtype=bool)
    valid_indices[1:-1] = valid_speeds

    return [
        coords_with_time[i] for i in range(len(coords_with_time)) if valid_indices[i]
    ]


def split_trip_on_time_gaps(coords_with_time, max_gap_minutes=15):
    """
    Split a trip into segments when there are large time gaps between points.
    Uses vectorized operations for better performance.
    """
    if len(coords_with_time) < 2 or not isinstance(coords_with_time[0][-1], datetime):
        return [coords_with_time]

    # Convert timestamps to numpy array
    times = np.array([c[-1].timestamp() for c in coords_with_time])

    # Calculate time differences between consecutive points
    time_diffs = np.diff(times) / 60  # Convert to minutes

    # Find indices where time gaps exceed threshold
    split_indices = np.where(time_diffs > max_gap_minutes)[0] + 1

    # Split the coordinates at the gap points
    if len(split_indices) == 0:
        return [coords_with_time]

    segments = []
    start_idx = 0
    for end_idx in split_indices:
        segments.append(coords_with_time[start_idx:end_idx])
        start_idx = end_idx
    segments.append(coords_with_time[start_idx:])

    return segments


async def process_and_map_match_trip(trip):
    """
    Process a single trip (validate + map-match):
      - Validate trip
      - Extract coordinates
      - Map match each segment
      - Merge matched coords
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
