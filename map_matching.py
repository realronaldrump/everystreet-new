import json
import math
import logging
import asyncio
import aiohttp
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads, dumps as geojson_dumps
from dotenv import load_dotenv
import os
from datetime import datetime, timedelta

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")
MAX_MAPBOX_COORDINATES = 100

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)


async def map_match_coordinates(coordinates):
    """
    Given a list of [lon, lat] coordinate pairs, call Mapbox’s map matching API
    in chunks if needed and return a dict with a matched LineString geometry.
    """
    if len(coordinates) < 2:
        logger.warning("Insufficient coordinates for map matching.")
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }

    base_url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
    # Break coordinates into chunks
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
                            f"Chunk {index+1}/{len(chunks)}: Map matching succeeded with {len(chunk)} coords."
                        )
                    else:
                        msg = data.get("message", "Mapbox API error")
                        logger.error(f"Chunk {index+1}: Map Matching API error: {msg}")
                        return {"code": "Error", "message": msg}
            except ClientResponseError as e:
                error_data = None
                if e.response and e.response.content_type == "application/json":
                    error_data = await e.response.json()
                logger.error(
                    f"Chunk {index+1}: ClientResponseError {e.status} - {e.message}, URL: {e.request_info.url}, Response: {error_data}",
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
                    f"Chunk {index+1}: ClientConnectorError: {e}", exc_info=True
                )
                return {
                    "code": "Error",
                    "message": f"Connection error to Mapbox: {str(e)}",
                }
            except asyncio.TimeoutError:
                logger.error(
                    f"Chunk {index+1}: Mapbox API request timed out.", exc_info=True
                )
                return {"code": "Error", "message": "Mapbox API request timed out."}
            except Exception as e:
                logger.error(f"Chunk {index+1}: Unexpected error: {e}", exc_info=True)
                return {"code": "Error", "message": str(e)}

    return {
        "code": "Ok",
        "matchings": [
            {"geometry": {"type": "LineString", "coordinates": matched_geometries}}
        ],
    }


def filter_outliers_by_distance(coordinates, max_speed_m_s=60.0):
    """
    Remove points that imply speeds above max_speed_m_s between consecutive points.
    Expects each coordinate to be a list of [lon, lat, timestamp] (if available).
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
            continue
        speed = haversine_distance_meters((lon1, lat1), (lon2, lat2)) / dt
        if speed < max_speed_m_s:
            cleaned.append(curr)
        else:
            logger.debug(
                f"Discarding outlier: {speed:.2f} m/s exceeds {max_speed_m_s} m/s"
            )
    return cleaned


def split_trip_on_time_gaps(coords_with_time, max_gap_minutes=15):
    """
    Split a list of [lon, lat, datetime] points into segments where time gaps exceed max_gap_minutes.
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
    """
    Compute the Haversine distance (in meters) between two [lon, lat] points.
    """
    R = 6371000  # meters
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
    Process a single trip document: validate, extract (and if needed, generate) timestamped coordinates,
    filter out outliers, split the trip on large time gaps, map–match each segment via Mapbox,
    and store the combined matched geometry in matched_trips_collection.
    """
    try:
        from app import (
            matched_trips_collection,
            historical_trips_collection,
            trips_collection,
            validate_trip_data,
            reverse_geocode_nominatim,
        )

        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(
                f"Trip {trip.get('transactionId', '?')} failed validation: {error_message}"
            )
            return

        if matched_trips_collection.find_one({"transactionId": trip["transactionId"]}):
            logger.info(f"Trip {trip['transactionId']} already matched. Skipping.")
            return

        source_collection = (
            historical_trips_collection
            if trip.get("imei") == "HISTORICAL"
            else trips_collection
        )

        # Extract GPS data
        if isinstance(trip["gps"], dict):
            gps_data = trip["gps"]
        else:
            gps_data = geojson_loads(trip["gps"])
        coords = gps_data.get("coordinates", [])
        if not coords or len(coords) < 2:
            logger.warning(
                f"Trip {trip['transactionId']} has insufficient coordinates."
            )
            return

        # Distribute timestamps linearly if possible
        start_dt = trip.get("startTime")
        end_dt = trip.get("endTime")
        if isinstance(start_dt, str):
            from dateutil import parser

            start_dt = parser.isoparse(start_dt)
        if isinstance(end_dt, str):
            from dateutil import parser

            end_dt = parser.isoparse(end_dt)
        if start_dt and end_dt and len(coords) > 1:
            total_secs = (end_dt - start_dt).total_seconds()
            if total_secs <= 0:
                coords_with_time = [[lon, lat] for lon, lat in coords]
            else:
                coords_with_time = [
                    [
                        lon,
                        lat,
                        start_dt
                        + timedelta(seconds=(i / (len(coords) - 1)) * total_secs),
                    ]
                    for i, (lon, lat) in enumerate(coords)
                ]
        else:
            coords_with_time = [[lon, lat] for lon, lat in coords]

        coords_with_time = filter_outliers_by_distance(
            coords_with_time, max_speed_m_s=60.0
        )
        if len(coords_with_time) > 2 and isinstance(coords_with_time[0][-1], datetime):
            segments = split_trip_on_time_gaps(coords_with_time, max_gap_minutes=15)
        else:
            segments = [coords_with_time]

        matched_coords_combined = []
        for seg_index, segment in enumerate(segments):
            if len(segment) < 2:
                logger.warning(
                    f"Skipping segment {seg_index} (trip {trip['transactionId']}): fewer than 2 points."
                )
                continue
            coords_lonlat = [(pt[0], pt[1]) for pt in segment]
            match_result = await map_match_coordinates(coords_lonlat)
            if match_result.get("code") == "Ok":
                part = match_result["matchings"][0]["geometry"]["coordinates"]
                if not matched_coords_combined:
                    matched_coords_combined.extend(part)
                else:
                    # Avoid duplicate boundary point
                    if matched_coords_combined[-1] == part[0]:
                        matched_coords_combined.extend(part[1:])
                    else:
                        matched_coords_combined.extend(part)
            else:
                logger.error(
                    f"Map matching failed on segment {seg_index} of trip {trip['transactionId']}"
                )
                continue

        if len(matched_coords_combined) < 2:
            logger.warning(
                f"Trip {trip['transactionId']} resulted in fewer than 2 matched coordinates."
            )
            return

        matched_trip = trip.copy()
        matched_trip["gps"] = (
            json.dumps(trip["gps"]) if isinstance(trip["gps"], dict) else trip["gps"]
        )
        matched_trip["matchedGps"] = geojson_dumps(
            {"type": "LineString", "coordinates": matched_coords_combined}
        )

        # Optionally update location via reverse geocode
        try:
            if matched_coords_combined:
                first_lon, first_lat = matched_coords_combined[0]
                city_info = await reverse_geocode_nominatim(first_lat, first_lon)
                if city_info:
                    matched_trip["location"] = city_info.get("display_name", "Unknown")
        except Exception as geocode_err:
            logger.warning(
                f"Reverse geocode error for trip {trip.get('transactionId', '?')}: {geocode_err}"
            )

        matched_trips_collection.insert_one(matched_trip)
        logger.info(
            f"Stored map–matched trip {trip['transactionId']} with {len(matched_coords_combined)} coordinates."
        )

    except Exception as e:
        logger.error(
            f"Error in process_and_map_match_trip for trip {trip.get('transactionId', 'Unknown')}: {e}",
            exc_info=True,
        )


def is_valid_coordinate(coord):
    """Return True if [lon, lat] is within valid WGS84 bounds."""
    lon, lat = coord
    return -180 <= lon <= 180 and -90 <= lat <= 90


def haversine_distance(coord1, coord2):
    """Return the Haversine distance in miles between two [lon, lat] points."""
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
