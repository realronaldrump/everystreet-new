# map_matching.py
import json
import math
import logging
import aiohttp
from geojson import loads as geojson_loads, dumps as geojson_dumps
from shapely.geometry import Point
from dotenv import load_dotenv
import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

MAX_MAPBOX_COORDINATES = 100


async def map_match_coordinates(coordinates):
    """
    Given a list of [lon, lat] coordinate pairs, calls Mapbox's map matching API 
    in chunks if necessary, and combines them into a single matched geometry.
    """
    if len(coordinates) < 2:
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }

    url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
    chunks = [
        coordinates[i: i + MAX_MAPBOX_COORDINATES]
        for i in range(0, len(coordinates), MAX_MAPBOX_COORDINATES)
    ]
    matched_geometries = []

    async with aiohttp.ClientSession() as client_session:
        for chunk in chunks:
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
                    if response.status == 200:
                        data = await response.json()
                        if data["code"] == "Ok":
                            # Take the first matching geometry
                            matched_geometries.extend(
                                data["matchings"][0]["geometry"]["coordinates"]
                            )
                        else:
                            logger.error(
                                f"Map Matching error: {data.get('message', 'No message')}"
                            )
                            return {
                                "code": "Error",
                                "message": data.get("message", "Map Matching API Error"),
                            }
                    elif response.status == 422:
                        error_data = await response.json()
                        logger.error(
                            f"422 error matching chunk, coords: {chunk}, message={error_data}"
                        )
                        return {
                            "code": "Error",
                            "message": error_data.get("message", "Mapbox 422 error"),
                        }
                    else:
                        logger.error(
                            f"Map Matching API request failed, status={response.status}"
                        )
                        return {
                            "code": "Error",
                            "message": f"Map Matching request failed with {response.status}",
                        }
            except Exception as e:
                logger.error(f"Exception requesting Mapbox: {e}")
                return {
                    "code": "Error",
                    "message": f"Exception in map matching: {str(e)}",
                }

    # Combine matched chunks
    return {
        "code": "Ok",
        "matchings": [
            {"geometry": {"coordinates": matched_geometries, "type": "LineString"}}
        ],
    }


def is_valid_coordinate(coord):
    """Check if a coordinate pair [lon, lat] is within valid WGS84 boundaries."""
    lon, lat = coord
    return -180 <= lon <= 180 and -90 <= lat <= 90


async def process_and_map_match_trip(trip):
    """
    Processes a single trip from the database, performs map matching on its coords,
    and stores or updates the matched result in matched_trips_collection.
    """
    try:
        from app import matched_trips_collection, trips_collection, historical_trips_collection, validate_trip_data, update_street_coverage, reverse_geocode_nominatim

        # Validate trip data
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(
                f"Invalid trip data for map matching: {error_message}")
            return None

        existing_matched = matched_trips_collection.find_one(
            {"transactionId": trip["transactionId"]}
        )
        if existing_matched:
            logger.info(
                f"Trip {trip['transactionId']} already map-matched. Skipping.")
            return

        # Decide which collection the original trip is from
        if trip.get("imei") == "HISTORICAL":
            source_collection = historical_trips_collection
        else:
            source_collection = trips_collection

        # Normalize GPS data into dict form
        if isinstance(trip["gps"], dict):
            gps_data = trip["gps"]
            coordinates = gps_data["coordinates"]
        else:
            gps_data = geojson_loads(trip["gps"])
            coordinates = gps_data["coordinates"]

        # Validate coords
        if not coordinates:
            logger.error(
                f"Trip {trip['transactionId']} has no coordinates. Skipping.")
            return
        if not all(is_valid_coordinate(c) for c in coordinates):
            logger.error(
                f"Trip {trip['transactionId']} has invalid coords out of [-180,180]/[-90,90]."
            )
            return

        # Perform the map matching
        map_match_result = await map_match_coordinates(coordinates)
        if map_match_result["code"] == "Ok":
            matched_trip = trip.copy()
            # Ensure gps is stored as string
            matched_trip["gps"] = (
                json.dumps(trip["gps"]) if isinstance(
                    trip["gps"], dict) else trip["gps"]
            )
            matched_trip["matchedGps"] = geojson_dumps(
                map_match_result["matchings"][0]["geometry"]
            )

            # Add location information using reverse geocoding on matched coordinates
            matched_coords = map_match_result["matchings"][0]["geometry"]["coordinates"]
            if matched_coords:
                start_lon, start_lat = matched_coords[0]
                end_lon, end_lat = matched_coords[-1]

                # Use either start or end location (or both, or a more sophisticated logic)
                location = await reverse_geocode_nominatim(start_lat, start_lon)

                if location and "address" in location:
                    if "city" in location["address"]:
                        location_name = location["address"]["city"]
                    elif "town" in location["address"]:
                        location_name = location["address"]["town"]
                    elif "village" in location["address"]:
                        location_name = location["address"]["village"]
                    else:
                        location_name = location.get("display_name", "")

                    matched_trip["location"] = location_name
                else:
                    location = await reverse_geocode_nominatim(end_lat, end_lon)
                    if location and "address" in location:
                        if "city" in location["address"]:
                            location_name = location["address"]["city"]
                        elif "town" in location["address"]:
                            location_name = location["address"]["town"]
                        elif "village" in location["address"]:
                            location_name = location["address"]["village"]
                        else:
                            location_name = location.get("display_name", "")

                    matched_trip["location"] = location_name

            matched_trips_collection.insert_one(matched_trip)
            logger.info(f"Map-matched trip {trip['transactionId']} stored.")

            # Update street coverage if location information is available
            if matched_trip.get("location"):
                update_street_coverage(matched_trip["location"])

        else:
            logger.error(
                f"Map matching failed for {trip['transactionId']}: {map_match_result['message']}"
            )

    except Exception as e:
        logger.error(
            f"Error processing map matching for trip {trip.get('transactionId', 'Unknown')}: {str(e)}"
        )
        return None


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
