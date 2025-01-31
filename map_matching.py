import json
import math
import logging
import aiohttp
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads, dumps as geojson_dumps
from dotenv import load_dotenv
import os
from datetime import datetime, timedelta
import asyncio

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

MAX_MAPBOX_COORDINATES = 100

# Logging Configuration
logging.basicConfig(level=logging.INFO,  # Set default level to INFO
                    format='%(asctime)s - %(levelname)s - %(name)s - %(message)s')
logger = logging.getLogger(__name__)


async def map_match_coordinates(coordinates):
    """
    Given a list of [lon, lat] coordinate pairs, calls Mapbox's map matching API
    in chunks if necessary, and combines them into a single matched geometry.

    Now any chunk bigger than MAX_MAPBOX_COORDINATES is further chunked.

    Returns a dict of the form:
    {
      "code": "Ok" or "Error",
      "message": "...",
      "matchings": [{
         "geometry": { "type": "LineString", "coordinates": [...] }
      }]
    }
    """
    if len(coordinates) < 2:
        logger.warning("Insufficient coordinates for map matching.")
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }

    url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
    chunks = [
        coordinates[i : i + MAX_MAPBOX_COORDINATES]
        for i in range(0, len(coordinates), MAX_MAPBOX_COORDINATES)
    ]
    matched_geometries = []

    async with aiohttp.ClientSession() as client_session:
        for chunk_index, chunk in enumerate(chunks):
            coordinates_str = ";".join(f"{lon},{lat}" for lon, lat in chunk)
            url_with_coords = url + coordinates_str
            params = {
                "access_token": MAPBOX_ACCESS_TOKEN,
                "geometries": "geojson",
                # The "radiuses" param can help handle GPS inaccuracy
                "radiuses": ";".join(["25"] * len(chunk)),
            }

            try:
                async with client_session.get(url_with_coords, params=params) as response:
                    response.raise_for_status()
                    data = await response.json()
                    if data["code"] == "Ok":
                        # Take the first matching geometry
                        matched_part = data["matchings"][0]["geometry"]["coordinates"]
                        matched_geometries.extend(matched_part)
                        logger.debug(
                            f"Map matching succeeded for chunk {chunk_index+1}/{len(chunks)} "
                            f"with {len(chunk)} coords."
                        )
                    else:
                        msg = data.get("message", "Mapbox API error")
                        logger.error(f"Map Matching API error chunk {chunk_index+1}: {msg}")
                        return {
                            "code": "Error",
                            "message": msg,
                        }

            except ClientResponseError as e:
                error_data = None
                if e.response and e.response.content_type == "application/json":
                    error_data = await e.response.json()
                logger.error(
                    f"Map Matching API ClientResponseError chunk {chunk_index+1}: "
                    f"{e.status} - {e.message}, URL: {e.request_info.url}, Response: {error_data}",
                    exc_info=True
                )
                return {
                    "code": "Error",
                    "message": error_data.get("message", f"Mapbox error {e.status}") if error_data else str(e),
                }
            except ClientConnectorError as e:
                logger.error(f"Map Matching API ClientConnectorError: {e}, chunk {chunk_index+1}", exc_info=True)
                return {
                    "code": "Error",
                    "message": f"Connection error to Mapbox: {str(e)}",
                }
            except asyncio.TimeoutError:
                logger.error(f"Map Matching API TimeoutError chunk {chunk_index+1}", exc_info=True)
                return {
                    "code": "Error",
                    "message": "Mapbox API request timed out.",
                }
            except Exception as e:
                logger.error(f"Map Matching API Exception chunk {chunk_index+1}: {e}", exc_info=True)
                return {
                    "code": "Error",
                    "message": str(e),
                }

    # Combine matched chunks into one linestring
    return {
        "code": "Ok",
        "matchings": [
            {
                "geometry": {
                    "type": "LineString",
                    "coordinates": matched_geometries
                }
            }
        ]
    }


def filter_outliers_by_distance(coordinates, max_speed_m_s=60.0):
    """
    Remove points that imply physically impossible speeds between consecutive points.

    max_speed_m_s: max speed in m/s. 
      (60 m/s ~ 134 mph. Adjust as needed.)

    Return a new list of cleaned [lon, lat, time]
    where time is the datetime object or None if not known.
    """
    if len(coordinates) < 2:
        return coordinates

    # We expect each item to be [lon, lat, timestamp?].
    # We will store them as a list of (lon, lat, dt) internally.
    cleaned = [coordinates[0]]
    for i in range(1, len(coordinates)):
        prev = cleaned[-1]
        curr = coordinates[i]

        # If we have times, parse them; otherwise skip speed check
        if len(prev) < 3 or len(curr) < 3:
            # We can't do a speed check.  Just accept.
            cleaned.append(curr)
            continue

        lon1, lat1, t1 = prev
        lon2, lat2, t2 = curr

        if not isinstance(t1, datetime) or not isinstance(t2, datetime):
            # We can't do a speed check
            cleaned.append(curr)
            continue

        # Calculate distance (m) and time (s)
        dist_m = haversine_distance_meters((lon1, lat1), (lon2, lat2))
        dt_s = (t2 - t1).total_seconds()
        if dt_s <= 0:
            # Weird time ordering
            continue

        speed_m_s = dist_m / dt_s
        if speed_m_s < max_speed_m_s:
            cleaned.append(curr)
        else:
            logger.debug(
                f"Discarding outlier point: speed {speed_m_s:.2f} m/s > {max_speed_m_s} m/s"
            )

    return cleaned


def split_trip_on_time_gaps(coords_with_time, max_gap_minutes=15):
    """
    If there's a big time gap between consecutive points, 
    split the trip at that gap and return multiple segments.

    coords_with_time is a list of [lon, lat, datetime].
    Return a list of segments, each a list of [lon, lat, datetime].
    """
    if len(coords_with_time) < 2:
        return [coords_with_time]

    segments = []
    current_segment = [coords_with_time[0]]

    for i in range(1, len(coords_with_time)):
        prev = coords_with_time[i - 1]
        curr = coords_with_time[i]

        t_prev = prev[2]
        t_curr = curr[2]
        gap = (t_curr - t_prev).total_seconds() / 60.0  # in minutes

        if gap > max_gap_minutes:
            # Start a new segment
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
    Haversine distance in meters between two [lon, lat] points.
    """
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
    distance_m = R * c
    return distance_m


async def process_and_map_match_trip(trip):
    """
    Processes a single trip doc, performs outlier filtering,
    splits into sub-trips for large time gaps, calls map matching for each sub-segment,
    then combines results into one matched geometry.

    Store the final matched result in matched_trips_collection.

    (Replace your existing function with this entire version.)
    """
    try:
        from app import (
            matched_trips_collection,
            historical_trips_collection,
            trips_collection,
            validate_trip_data,
            reverse_geocode_nominatim,
            update_street_coverage,
        )

        # Step 1: Validate basic trip data
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(f"Invalid trip data for {trip.get('transactionId')}: {error_message}")
            return

        # Step 2: Check if we've already matched
        existing = matched_trips_collection.find_one({"transactionId": trip["transactionId"]})
        if existing:
            logger.info(f"Trip {trip['transactionId']} already matched. Skipping.")
            return

        # Step 3: Figure out if it's historical or regular
        if trip.get("imei") == "HISTORICAL":
            source_collection = historical_trips_collection
        else:
            source_collection = trips_collection

        # Step 4: Extract coordinates/time from 'gps'
        if isinstance(trip["gps"], dict):
            gps_data = trip["gps"]
        else:
            gps_data = geojson_loads(trip["gps"])

        coords = gps_data.get("coordinates", [])
        if not coords or len(coords) < 2:
            logger.warning(f"Trip {trip['transactionId']} has no coords or only 1 point.")
            return

        # We expect each coordinate to be [lon, lat].
        # Let's see if there's a time array or not.
        # We can add timestamps from startTime -> endTime if needed, or from a known property.
        # For simplicity, assume we do not have a separate time array in the geometry.
        # Instead, we attempt to read 'startTime' and distribute times linearly, or skip.
        start_dt = trip.get("startTime")
        end_dt = trip.get("endTime")

        # Convert to python datetime if strings
        if isinstance(start_dt, str):
            from dateutil import parser
            start_dt = parser.isoparse(start_dt)
        if isinstance(end_dt, str):
            from dateutil import parser
            end_dt = parser.isoparse(end_dt)

        coords_with_time = []
        if start_dt and end_dt and len(coords) > 1:
            total_secs = (end_dt - start_dt).total_seconds()
            if total_secs <= 0:
                # fallback: no valid time range
                coords_with_time = [[lon, lat] for lon, lat in coords]
            else:
                # Distribute times linearly
                for i, (lon, lat) in enumerate(coords):
                    frac = i / (len(coords) - 1)
                    t = start_dt + timedelta(seconds=(frac * total_secs))
                    coords_with_time.append([lon, lat, t])
        else:
            # We do not have consistent times, so we simply store them as [lon, lat]
            # We can't do speed-based outlier filtering or time-based splitting properly
            coords_with_time = [[lon, lat] for (lon, lat) in coords]

        # Step 5: Filter out obvious outliers by speed (if we have times)
        coords_with_time = filter_outliers_by_distance(coords_with_time, max_speed_m_s=60.0)

        # Step 6: Split into sub-segments by large time gaps
        # (If we have time data. If not, it's just one segment.)
        if len(coords_with_time) > 2 and isinstance(coords_with_time[0][-1], datetime):
            segments = split_trip_on_time_gaps(coords_with_time, max_gap_minutes=15)
        else:
            segments = [coords_with_time]

        # Step 7: Map-match each segment
        matched_coords_combined = []
        for seg_index, segment in enumerate(segments):
            # If segment is < 2 points, skip
            if len(segment) < 2:
                logger.warning(f"Skipping segment {seg_index} with <2 points, trip {trip['transactionId']}")
                continue

            # Extract just [lon, lat] for the API
            coords_lonlat = [(c[0], c[1]) for c in segment]

            match_result = await map_match_coordinates(coords_lonlat)
            if match_result["code"] == "Ok":
                part = match_result["matchings"][0]["geometry"]["coordinates"]
                # If the first segment was empty, just add all
                if not matched_coords_combined:
                    matched_coords_combined.extend(part)
                else:
                    # Attempt to avoid duplication of the boundary point
                    if matched_coords_combined[-1] == part[0]:
                        matched_coords_combined.extend(part[1:])
                    else:
                        matched_coords_combined.extend(part)
            else:
                logger.error(f"Map matching failed on segment {seg_index} of trip {trip['transactionId']}")
                continue

        # Step 8: Construct final matched geometry
        if len(matched_coords_combined) < 2:
            logger.warning(f"Trip {trip['transactionId']} ended up with <2 matched coords after all segments.")
            return

        matched_trip = trip.copy()
        # Store the original gps as JSON string
        if isinstance(trip["gps"], dict):
            matched_trip["gps"] = json.dumps(trip["gps"])
        else:
            matched_trip["gps"] = trip["gps"]

        # The final matched geometry
        matched_trip["matchedGps"] = geojson_dumps({
            "type": "LineString",
            "coordinates": matched_coords_combined
        })

        # Optionally, do a final reverse geocode or location name
        # e.g. find city from the first or last point of matched_coords_combined
        try:
            if matched_coords_combined:
                first_lon, first_lat = matched_coords_combined[0]
                city_info = await reverse_geocode_nominatim(first_lat, first_lon)
                if city_info:
                    location_name = city_info.get("display_name", "Unknown")
                    matched_trip["location"] = location_name
        except Exception as geocode_err:
            logger.warning(f"reverse_geocode_nominatim error: {geocode_err}")

        # Step 9: Insert into matched_trips_collection
        matched_trips_collection.insert_one(matched_trip)
        logger.info(f"Map-matched trip {trip['transactionId']} stored with {len(matched_coords_combined)} coords.")

        # Step 10: Update street coverage if we have location
        if matched_trip.get("location"):
            try:
                await update_street_coverage(matched_trip["location"])
            except Exception as e:
                logger.error(f"Error updating street coverage for {matched_trip['location']}: {e}", exc_info=True)

    except Exception as e:
        logger.error(
            f"Error processing map matching for trip {trip.get('transactionId', 'Unknown')}: {str(e)}",
            exc_info=True
        )
        return

def is_valid_coordinate(coord):
    """Check if a coordinate pair [lon, lat] is within valid WGS84 boundaries."""
    lon, lat = coord
    return -180 <= lon <= 180 and -90 <= lat <= 90



def haversine_distance(coord1, coord2):
    """Haversine distance in miles between two [lon, lat] points (WGS84)."""
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
    distance_km = R_km * c
    distance_miles = distance_km * 0.621371
    return distance_miles
