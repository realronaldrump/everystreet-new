import json
import math
import logging
import asyncio
import aiohttp
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads
from dotenv import load_dotenv
import os
from dateutil import parser
from datetime import datetime, timedelta

from utils import validate_trip_data, reverse_geocode_nominatim
from db import (
    matched_trips_collection,
    trips_collection,
    historical_trips_collection,
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
    Given [lon, lat] coordinate pairs, call Mapbox's map matching API in chunks if needed,
    and return a dict with a matched LineString geometry.
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


def filter_outliers_by_distance(coordinates, max_speed_m_s=60.0):
    """
    Remove points that imply speeds above max_speed_m_s between consecutive points.
    Each coordinate is [lon, lat, timestamp].
    """
    if len(coordinates) < 2:
        return coordinates

    cleaned = [coordinates[0]]
    for i in range(1, len(coordinates)):
        prev = cleaned[-1]
        curr = coordinates[i]
        if len(prev) < 3 or len(curr) < 3:
            cleaned.append(curr)
            continue
        lon1, lat1, t1 = prev
        lon2, lat2, t2 = curr
        if not (isinstance(t1, datetime) and isinstance(t2, datetime)):
            cleaned.append(curr)
            continue

        dt = (t2 - t1).total_seconds()
        if dt <= 0:
            # No time difference, skip
            continue
        speed = haversine_distance_meters((lon1, lat1), (lon2, lat2)) / dt
        if speed < max_speed_m_s:
            cleaned.append(curr)
        else:
            logger.debug(
                "Discarding outlier with speed %.2f m/s > %.2f m/s",
                speed,
                max_speed_m_s,
            )
    return cleaned


def split_trip_on_time_gaps(coords_with_time, max_gap_minutes=15):
    """
    Split a list of [lon, lat, datetime] points into segments where time gaps exceed
    max_gap_minutes.
    """
    if len(coords_with_time) < 2:
        return [coords_with_time]

    segments = []
    current_segment = [coords_with_time[0]]
    for i in range(1, len(coords_with_time)):
        prev, curr = coords_with_time[i - 1], coords_with_time[i]
        gap = (curr[2] - prev[2]).total_seconds() / 60.0
        if gap > max_gap_minutes:
            if len(current_segment) > 1:
                segments.append(current_segment)
            current_segment = [curr]
        else:
            current_segment.append(curr)
    if len(current_segment) > 1:
        segments.append(current_segment)
    return segments


def haversine_distance_meters(coord1, coord2):
    """Return the Haversine distance (in meters) between two [lon, lat] points."""
    R = 6371000  # Earth radius in meters
    lon1, lat1 = math.radians(coord1[0]), math.radians(coord1[1])
    lon2, lat2 = math.radians(coord2[0]), math.radians(coord2[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


async def process_and_map_match_trip(trip):
    """
    Process a single trip (validate + map-match):
      - Validate trip
      - Extract coordinates
      - Filter outliers
      - Split segments
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

        # Distribute timestamps linearly if needed
        start_dt = trip.get("startTime")
        end_dt = trip.get("endTime")
        if isinstance(start_dt, str):
            start_dt = parser.isoparse(start_dt)
        if isinstance(end_dt, str):
            end_dt = parser.isoparse(end_dt)

        if start_dt and end_dt and len(coords) > 1:
            total_secs = (end_dt - start_dt).total_seconds()
            if total_secs <= 0:
                coords_with_time = [[lon, lat] for lon, lat in coords]
            else:
                coords_with_time = []
                for i, (lon, lat) in enumerate(coords):
                    frac = i / (len(coords) - 1)
                    ts = start_dt + timedelta(seconds=(frac * total_secs))
                    coords_with_time.append([lon, lat, ts])
        else:
            coords_with_time = [[lon, lat] for lon, lat in coords]

        # Filter out outliers above some speed threshold
        coords_with_time = filter_outliers_by_distance(
            coords_with_time, max_speed_m_s=60.0
        )

        # Possibly split on time gaps
        segments = [coords_with_time]
        if len(coords_with_time) > 2 and isinstance(coords_with_time[0][-1], datetime):
            segments = split_trip_on_time_gaps(coords_with_time, max_gap_minutes=15)

        matched_coords_combined = []
        for seg_index, seg in enumerate(segments):
            if len(seg) < 2:
                logger.warning(
                    "Skipping segment %d for trip %s: < 2 points",
                    seg_index,
                    trip["transactionId"],
                )
                continue

            # We only need (lon, lat) for the map matching request
            seg_lonlat = [(pt[0], pt[1]) for pt in seg]
            match_result = await map_match_coordinates(seg_lonlat)
            if match_result.get("code") == "Ok":
                part = match_result["matchings"][0]["geometry"]["coordinates"]
                if not matched_coords_combined:
                    matched_coords_combined.extend(part)
                else:
                    # If the last matched coord == first new coord, avoid duplicating
                    if matched_coords_combined[-1] == part[0]:
                        matched_coords_combined.extend(part[1:])
                    else:
                        matched_coords_combined.extend(part)
            else:
                logger.error(
                    "Map matching failed on segment %d of trip %s",
                    seg_index,
                    trip["transactionId"],
                )

        if len(matched_coords_combined) < 2:
            logger.warning(
                "Trip %s resulted in < 2 matched coords after Mapbox",
                trip["transactionId"],
            )
            return

        matched_trip = trip.copy()
        # Convert original gps to string if needed
        if isinstance(matched_trip["gps"], dict):
            matched_trip["gps"] = json.dumps(matched_trip["gps"])

        matched_trip["matchedGps"] = {
            "type": "LineString",
            "coordinates": matched_coords_combined,
        }

        # Optionally update location via reverse geocode for the first matched point
        try:
            first_lon, first_lat = matched_coords_combined[0]
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
            len(matched_coords_combined),
        )

    except Exception as e:
        logger.error(
            "Error in process_and_map_match_trip for trip %s: %s",
            trip.get("transactionId"),
            e,
            exc_info=True,
        )


def haversine_distance(coord1, coord2):
    """
    Return the Haversine distance in miles between two [lon, lat] points.
    """
    R_km = 6371
    lat1, lon1 = math.radians(coord1[1]), math.radians(coord1[0])
    lat2, lon2 = math.radians(coord2[1]), math.radians(coord2[0])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R_km * c * 0.621371
