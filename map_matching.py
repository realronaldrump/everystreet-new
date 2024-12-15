# map_matching.py

import json
import math
import logging
import aiohttp
from geojson import (
    loads as geojson_loads,
    dumps as geojson_dumps,
)
from shapely.geometry import Point
from dotenv import load_dotenv
import os

# Assuming matched_trips_collection is accessible here, or you can pass it as an argument

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN")

# Constants
MAX_MAPBOX_COORDINATES = 100

async def map_match_coordinates(coordinates):
    if len(coordinates) < 2:
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
        for chunk in chunks:
            coordinates_str = ";".join([f"{lon},{lat}" for lon, lat in chunk])
            url_with_coords = url + coordinates_str

            params = {
                "access_token": MAPBOX_ACCESS_TOKEN,
                "geometries": "geojson",
                "radiuses": ";".join(["25" for _ in chunk]),
            }

            async with client_session.get(url_with_coords, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    if data["code"] == "Ok":
                        matched_geometries.extend(
                            data["matchings"][0]["geometry"]["coordinates"]
                        )
                    else:
                        print(
                            f"Error map-matching chunk: {data.get('message', 'Map Matching API Error')}"
                        )
                        return {
                            "code": "Error",
                            "message": data.get("message", "Map Matching API Error"),
                        }
                elif response.status == 422:
                    error_data = await response.json()
                    print(
                        f"Error map-matching chunk: Status 422, Message: {error_data.get('message', 'No message')}, Coordinates: {chunk}"
                    )
                    return {
                        "code": "Error",
                        "message": error_data.get(
                            "message", "Map Matching API Error 422"
                        ),
                    }
                else:
                    print(
                        f"Error map-matching chunk: Map Matching API request failed with status {response.status}"
                    )
                    return {
                        "code": "Error",
                        "message": f"Map Matching API request failed with status {response.status}",
                    }

    return {
        "code": "Ok",
        "matchings": [
            {"geometry": {"coordinates": matched_geometries, "type": "LineString"}}
        ],
    }

def is_valid_coordinate(coord):
    """Check if a coordinate pair is valid."""
    lon, lat = coord
    return -180 <= lon <= 180 and -90 <= lat <= 90

async def process_and_map_match_trip(trip):
    """
    Processes a trip, performs map matching on its coordinates, and stores the matched trip.
    """
    try:
        from app import matched_trips_collection, trips_collection, historical_trips_collection, validate_trip_data
        # Validate trip data before processing
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(f"Invalid trip data for map matching: {error_message}")
            return None

        existing_matched_trip = matched_trips_collection.find_one(
            {"transactionId": trip["transactionId"]}
        )
        if existing_matched_trip:
            print(f"Trip {trip['transactionId']} already map-matched. Skipping.")
            return

        # Determine the source collection and get GPS data based on IMEI
        if trip["imei"] == "HISTORICAL":
            source_collection = historical_trips_collection
            gps_data = trip["gps"] if isinstance(trip["gps"], str) else json.dumps(trip["gps"])
            coords = geojson_loads(gps_data)["coordinates"]
            total_distance = 0
            for i in range(len(coords) - 1):
                total_distance += haversine_distance(coords[i], coords[i+1])
            trip["distance"] = total_distance
        else:
            source_collection = trips_collection
            # Handle GPS data consistently
            if isinstance(trip["gps"], dict):
                gps_data = trip["gps"]
                coordinates = gps_data["coordinates"]
            else:
                gps_data = geojson_loads(trip["gps"])
                coordinates = gps_data["coordinates"]

        if not coordinates:
            print(f"Error: Trip {trip['transactionId']} has no coordinates. Skipping.")
            return

        if not all(is_valid_coordinate(coord) for coord in coordinates):
            print(f"Error: Trip {trip['transactionId']} has invalid coordinates. Skipping.")
            return

        map_match_result = await map_match_coordinates(coordinates)

        if map_match_result["code"] == "Ok":
            matched_trip = trip.copy()
            # Ensure GPS data is stored as a string
            matched_trip["gps"] = json.dumps(trip["gps"]) if isinstance(trip["gps"], dict) else trip["gps"]
            matched_trip["matchedGps"] = geojson_dumps(map_match_result["matchings"][0]["geometry"])
            matched_trips_collection.insert_one(matched_trip)
            print(f"Trip {trip['transactionId']} map-matched and stored.")
        else:
            print(f"Error map-matching trip {trip['transactionId']}: {map_match_result['message']}")

    except Exception as e:
        logger.error(
            f"Error processing and map-matching trip {trip.get('transactionId', 'Unknown')}: {str(e)}"
        )
        return None

def haversine_distance(coord1, coord2):
    R = 6371  # Radius of the Earth in kilometers
    lat1, lon1 = math.radians(coord1[1]), math.radians(coord1[0])
    lat2, lon2 = math.radians(coord2[1]), math.radians(coord2[0])

    dlon = lon2 - lon1
    dlat = lat2 - lat1

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    distance = R * c
    return distance * 0.621371  # Convert to miles