import json
import math
import logging
import aiohttp
from aiohttp import ClientResponseError, ClientConnectorError
from geojson import loads as geojson_loads, dumps as geojson_dumps
from dotenv import load_dotenv
import os
import asyncio

from app import update_street_coverage

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
    """
    if len(coordinates) < 2:
        logger.warning("Insufficient coordinates for map matching.") # Log warning for insufficient coordinates
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
                    response.raise_for_status() # Raise HTTPError for bad responses
                    data = await response.json()
                    if data["code"] == "Ok":
                        # Take the first matching geometry
                        matched_geometries.extend(
                            data["matchings"][0]["geometry"]["coordinates"]
                        )
                        logger.debug(f"Map Matching successful for chunk of {len(chunk)} coordinates.") # Debug log for successful chunk matching
                    else:
                        logger.error(f"Map Matching API error: {data.get('message', 'No message')}, Code: {data['code']}") # Log Mapbox API error with code
                        return {
                            "code": "Error",
                            "message": data.get("message", "Map Matching API Error"),
                        }
                # No need to handle 422 specifically here, raise_for_status handles non-200 responses
            except ClientResponseError as e:
                error_data = await e.response.json() if e.response.content_type == 'application/json' else None
                logger.error(f"Map Matching API ClientResponseError: {e.status} - {e.message}, URL: {e.request_info.url}, Response Data: {error_data}", exc_info=True) # Include URL and response data in log
                return {
                    "code": "Error",
                    "message": error_data.get("message", f"Mapbox API error {e.status}") if error_data else f"Mapbox API error {e.status}",
                }
            except ClientConnectorError as e:
                logger.error(f"Map Matching API ClientConnectorError: {e}, URL: {url_with_coords}", exc_info=True) # Include URL in log
                return {
                    "code": "Error",
                    "message": f"Connection error to Mapbox API: {str(e)}",
                }
            except asyncio.TimeoutError:
                logger.error(f"Map Matching API TimeoutError: Request timed out, URL: {url_with_coords}", exc_info=True) # Log timeout errors
                return {
                    "code": "Error",
                    "message": "Mapbox API request timed out.",
                }
            except Exception as e:
                logger.error(f"Map Matching API Exception: {e}, URL: {url_with_coords}", exc_info=True) # Log unexpected exceptions
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
        from app import matched_trips_collection, trips_collection, historical_trips_collection, validate_trip_data, reverse_geocode_nominatim

        # Validate trip data
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(f"Invalid trip data for map matching (transactionId: {trip.get('transactionId', 'N/A')}): {error_message}") # Include transactionId in log
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
            logger.warning(f"Trip {trip['transactionId']} has no coordinates. Skipping map matching.") # Warning log for no coords
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
            location_name = None  # Initialize location_name to None
            if matched_coords:
                start_lon, start_lat = matched_coords[0]
                end_lon, end_lat = matched_coords[-1]

                # Use either start or end location (or both, or a more sophisticated logic)
                location = await reverse_geocode_nominatim(start_lat, start_lon)  # Await async call

                if location and "address" in location:
                    if "city" in location["address"]:
                        location_name = location["address"]["city"]
                    elif "town" in location["address"]:
                        location_name = location["address"]["town"]
                    elif "village" in location["address"]:
                        location_name = location["address"]["village"]
                    else:
                        location_name = location.get("display_name", "")

                if not location_name:
                    location = await reverse_geocode_nominatim(end_lat, end_lon)  # Await async call
                    if location and "address" in location:
                        if "city" in location["address"]:
                            location_name = location["address"]["city"]
                        elif "town" in location["address"]:
                            location_name = location["address"]["town"]
                        elif "village" in location["address"]:
                            location_name = location["address"]["village"]
                        else:
                            location_name = location.get("display_name", "")

            # Only update if location_name is found
            if location_name:
                matched_trip["location"] = location_name

            matched_trips_collection.insert_one(matched_trip)
            logger.info(f"Map-matched trip {trip['transactionId']} stored.")

            # Update street coverage if location information is available and valid
            if location_name:
                try:
                    await update_street_coverage(location_name)  # Await async call
                except Exception as e:
                    logger.error(
                        f"Error updating street coverage for {location_name}: {e}", exc_info=True)
            else:
                logger.warning(
                    f"Could not determine location for trip {trip['transactionId']}.")

        else:
            logger.error(
                f"Map matching failed for {trip['transactionId']}: {map_match_result['message']}"
            )

    except Exception as e:
        logger.error(
            f"Error processing map matching for trip {trip.get('transactionId', 'Unknown')}: {str(e)}", exc_info=True)
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