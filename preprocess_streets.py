import logging
import os
from datetime import datetime, timezone
import argparse

import requests
from dotenv import load_dotenv
from pymongo import MongoClient
from shapely.geometry import LineString, mapping, Point
from shapely.ops import transform
import pyproj
import aiohttp
import asyncio

# Import validate_location_osm from utils.py
from utils import validate_location_osm

load_dotenv()

# Logging
logging.basicConfig(level=logging.INFO,  # Set default level to INFO
                    format='%(asctime)s - %(levelname)s - %(name)s - %(message)s')
logger = logging.getLogger(__name__)

# MongoDB
MONGO_URI = os.getenv("MONGO_URI")
mongo_client = MongoClient(MONGO_URI)
db = mongo_client["every_street"]
streets_collection = db["streets"]
coverage_metadata_collection = db["coverage_metadata"]

# Overpass API
OVERPASS_URL = "http://overpass-api.de/api/interpreter"

# WGS84 (EPSG:4326) and UTM Zone 10N (EPSG:32610) -  Adjust the UTM zone if needed
wgs84 = pyproj.CRS("EPSG:4326")
# You might need to change this based on your location
utm = pyproj.CRS("EPSG:32610")

project_to_utm = pyproj.Transformer.from_crs(
    wgs84, utm, always_xy=True).transform
project_to_wgs84 = pyproj.Transformer.from_crs(
    utm, wgs84, always_xy=True).transform


def fetch_osm_data(location, streets_only=True):
    """
    Fetches OSM data for the given location using the Overpass API asynchronously.
    This function uses asyncio.run() since it is called in a synchronous command‐line script.
    """
    area_id = int(location["osm_id"])
    if location["osm_type"] == "relation":
        area_id += 3600000000

    if streets_only:
        query = f"""
        [out:json];
        area({area_id})->.searchArea;
        (
          way["highway"](area.searchArea);
        );
        (._;>;);
        out geom;
        """
    else:
        query = f"""
        [out:json];
        ({location['osm_type']}({location['osm_id']});
        >;
        );
        out geom;
        """
    async def _fetch():
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.get("http://overpass-api.de/api/interpreter", params={"data": query}) as response:
                response.raise_for_status()
                return await response.json()
    try:
        return asyncio.run(_fetch())
    except Exception as e:
        logger.error(f"Error fetching OSM data from Overpass for location {location['display_name']}: {e}", exc_info=True)
        raise


def segment_street(line, segment_length_meters=100):
    """
    Splits a LineString into segments of a specified length.

    Args:
        line: A Shapely LineString object.
        segment_length_meters: The desired length of each segment in meters.

    Returns:
        A list of Shapely LineString objects representing the segments.
    """
    segments = []
    length = line.length

    if length <= segment_length_meters:
        return [line]

    for i in range(0, int(length), segment_length_meters):
        segment = cut(line, i, min(i + segment_length_meters, length))
        if segment:  # Only add the segment if it's not None
            segments.append(segment)

    return segments


def cut(line, start_distance, end_distance):
    """
    Cuts a LineString at specified distances from the start.

    Args:
        line: A Shapely LineString object.
        start_distance: The distance from the start at which to start the cut.
        end_distance: The distance from the start at which to end the cut.

    Returns:
        A Shapely LineString object representing the cut segment.
    """
    if start_distance < 0 or end_distance > line.length or start_distance >= end_distance:
        return None

    coords = list(line.coords)
    if start_distance == 0 and end_distance == line.length:
        return line

    segment_coords = []

    # Add the start point only if it's not the very beginning of the line
    if start_distance > 0:
        start_point = line.interpolate(start_distance)
        segment_coords.append((start_point.x, start_point.y))

    # Add intermediate coordinates that fall within the segment
    for coord in coords:
        point = Point(coord)
        point_distance = line.project(point)
        if start_distance < point_distance < end_distance:
            segment_coords.append(coord)

    # Add the end point only if it's not the very end of the line
    if end_distance < line.length:
        end_point = line.interpolate(end_distance)
        segment_coords.append((end_point.x, end_point.y))

    # Ensure there are at least two points to form a valid line segment
    if len(segment_coords) < 2:
        return None

    return LineString(segment_coords)


def process_osm_data(osm_data, location):
    """Processes OSM data, segments streets, and stores them in MongoDB."""
    features = []
    total_length = 0  # Initialize total_length
    for element in osm_data["elements"]:
        if element["type"] == "way":
            try:
                # Project to UTM for accurate length calculation
                line = transform(project_to_utm, LineString(
                    [(node["lon"], node["lat"]) for node in element["geometry"]]))

                # Segment the street
                segments = segment_street(line)

                for i, segment in enumerate(segments):
                    # Project back to WGS84 for storage
                    segment_wgs84 = transform(project_to_wgs84, segment)

                    # Calculate the length of the segment in meters
                    segment_length = segment.length

                    feature = {
                        "type": "Feature",
                        "geometry": mapping(segment_wgs84),
                        "properties": {
                            "street_id": element["id"],
                            "segment_id": f"{element['id']}-{i}",
                            "street_name": element["tags"].get("name", "Unnamed Street"),
                            "location": location["display_name"],
                            "length": segment_length,  # Store the calculated length
                            "driven": False,
                            "last_updated": None,
                            "matched_trips": []
                        },
                    }
                    features.append(feature)
                    total_length += segment_length  # Accumulate the total length
            except Exception as e:
                logger.error(f"Error processing element {element['id']} (way): {e}", exc_info=True) # Include element ID in log

    if features:
        # Convert features to GeoJSON and insert into MongoDB
        geojson_data = {
            "type": "FeatureCollection",
            "features": features,
        }
        streets_collection.insert_many(geojson_data["features"])

        # Update or insert coverage metadata
        coverage_metadata_collection.update_one(
            {"location": location["display_name"]},
            {
                "$set": {
                    "total_segments": len(features),
                    "driven_segments": 0,
                    "total_length": total_length,
                    "driven_length": 0,
                    "coverage_percentage": 0.0,
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        logger.info(
            f"Processed and stored {len(features)} street segments for {location['display_name']}")


def main():
    """
    Main function to preprocess street data for a given location.
    Now accepts location and location_type as command-line arguments.
    """
    parser = argparse.ArgumentParser(
        description="Preprocess street data for a given location.")
    parser.add_argument(
        "location", help="Location query (e.g., 'Beverly Hills, TX')")
    parser.add_argument(
        "--type",
        dest="location_type",
        default="city",
        help="Location type (e.g., 'city', 'county', 'state')",
    )
    args = parser.parse_args()

    location_query = args.location
    location_type = args.location_type

    try: # Wrap main logic in try-except for top-level error handling
        # Validate the location using Nominatim
        validated_location = validate_location_osm(location_query, location_type)
        if not validated_location:
            logger.error(f"Location '{location_query}' of type '{location_type}' not found.") # Log invalid location
            return

        # Fetch OSM data
        osm_data = fetch_osm_data(validated_location)

        # Process OSM data and store in MongoDB
        process_osm_data(osm_data, validated_location)

        logger.info(f"Street preprocessing completed for {validated_location['display_name']}.") # Log completion
    except Exception as e: # Catch any exceptions in main function
        logger.error(f"Error in main function during street preprocessing: {e}", exc_info=True) # Log top-level exceptions


if __name__ == "__main__":
    main()
