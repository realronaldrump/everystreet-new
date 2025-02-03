import os
import sys
import json
import argparse
import asyncio
import logging
from datetime import datetime, timezone

import requests
import aiohttp
from pymongo import MongoClient
from shapely.geometry import LineString, mapping, Point
from shapely.ops import transform
import pyproj
from dotenv import load_dotenv

from utils import validate_location_osm

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

# MongoDB setup
MONGO_URI = os.getenv("MONGO_URI")
mongo_client = MongoClient(MONGO_URI)
db = mongo_client["every_street"]
streets_collection = db["streets"]
coverage_metadata_collection = db["coverage_metadata"]

# Overpass API endpoint
OVERPASS_URL = "http://overpass-api.de/api/interpreter"

# Coordinate reference systems and transformers
wgs84 = pyproj.CRS("EPSG:4326")
utm = pyproj.CRS("EPSG:32610")  # Adjust UTM zone as needed
project_to_utm = pyproj.Transformer.from_crs(wgs84, utm, always_xy=True).transform
project_to_wgs84 = pyproj.Transformer.from_crs(utm, wgs84, always_xy=True).transform


def fetch_osm_data(location, streets_only=True):
    """
    Asynchronously fetch OSM data for the given location using the Overpass API.
    This function runs an async fetch using asyncio.run().
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
            async with session.get(OVERPASS_URL, params={"data": query}) as response:
                response.raise_for_status()
                return await response.json()

    try:
        return asyncio.run(_fetch())
    except Exception as e:
        logger.error(f"Error fetching OSM data from Overpass for {location['display_name']}: {e}", exc_info=True)
        raise


def segment_street(line, segment_length_meters=100):
    """
    Split a LineString into segments each roughly segment_length_meters long.
    """
    segments = []
    length = line.length
    if length <= segment_length_meters:
        return [line]
    for i in range(0, int(length), segment_length_meters):
        segment = cut(line, i, min(i + segment_length_meters, length))
        if segment:
            segments.append(segment)
    return segments


def cut(line, start_distance, end_distance):
    """
    Cut a LineString between start_distance and end_distance.
    Returns a new LineString for the cut segment or None if invalid.
    """
    if start_distance < 0 or end_distance > line.length or start_distance >= end_distance:
        return None
    coords = list(line.coords)
    if start_distance == 0 and end_distance == line.length:
        return line

    segment_coords = []
    if start_distance > 0:
        start_point = line.interpolate(start_distance)
        segment_coords.append((start_point.x, start_point.y))
    for coord in coords:
        point = Point(coord)
        if start_distance < line.project(point) < end_distance:
            segment_coords.append(coord)
    if end_distance < line.length:
        end_point = line.interpolate(end_distance)
        segment_coords.append((end_point.x, end_point.y))
    return LineString(segment_coords) if len(segment_coords) >= 2 else None


def process_osm_data(osm_data, location):
    """
    Process OSM elements: segment each street (way) and store them in MongoDB.
    Also update coverage metadata.
    """
    features = []
    total_length = 0
    for element in osm_data.get("elements", []):
        if element.get("type") != "way":
            continue
        try:
            nodes = [(node["lon"], node["lat"]) for node in element["geometry"]]
            line = transform(project_to_utm, LineString(nodes))
            segments = segment_street(line)
            for i, segment in enumerate(segments):
                segment_wgs84 = transform(project_to_wgs84, segment)
                segment_length = segment.length
                feature = {
                    "type": "Feature",
                    "geometry": mapping(segment_wgs84),
                    "properties": {
                        "street_id": element["id"],
                        "segment_id": f"{element['id']}-{i}",
                        "street_name": element.get("tags", {}).get("name", "Unnamed Street"),
                        "location": location["display_name"],
                        "length": segment_length,
                        "driven": False,
                        "last_updated": None,
                        "matched_trips": []
                    },
                }
                features.append(feature)
                total_length += segment_length
        except Exception as e:
            logger.error(f"Error processing element {element.get('id')}: {e}", exc_info=True)

    if features:
        geojson_data = {"type": "FeatureCollection", "features": features}
        streets_collection.insert_many(geojson_data["features"])
        coverage_metadata_collection.update_one(
            {"location": location["display_name"]},
            {"$set": {
                "total_segments": len(features),
                "driven_segments": 0,
                "total_length": total_length,
                "driven_length": 0,
                "coverage_percentage": 0.0,
                "last_updated": datetime.now(timezone.utc),
            }},
            upsert=True,
        )
        logger.info(f"Stored {len(features)} street segments for {location['display_name']}")


def main():
    """
    Main entry point for command–line street preprocessing.
    Accepts a location query and an optional location type.
    """
    parser = argparse.ArgumentParser(description="Preprocess street data for a given location.")
    parser.add_argument("location", help="Location query (e.g., 'Beverly Hills, TX')")
    parser.add_argument("--type", dest="location_type", default="city",
                        help="Location type (e.g., 'city', 'county', 'state')")
    args = parser.parse_args()
    location_query = args.location
    location_type = args.location_type

    try:
        validated_location = validate_location_osm(location_query, location_type)
        if not validated_location:
            logger.error(f"Location '{location_query}' of type '{location_type}' not found.")
            return
        osm_data = fetch_osm_data(validated_location)
        process_osm_data(osm_data, validated_location)
        logger.info(f"Street preprocessing completed for {validated_location['display_name']}.")
    except Exception as e:
        logger.error(f"Error during street preprocessing: {e}", exc_info=True)


if __name__ == "__main__":
    main()