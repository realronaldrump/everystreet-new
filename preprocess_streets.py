import os
import json
import asyncio
import logging
from datetime import datetime, timezone

import aiohttp
from pymongo import MongoClient
from shapely.geometry import LineString, mapping, Point, shape, box
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
# For segmentation purposes, we define a default UTM projection.
default_utm = pyproj.CRS("EPSG:32610")  # Adjust the UTM zone as needed.
project_to_utm = pyproj.Transformer.from_crs(wgs84, default_utm, always_xy=True).transform
project_to_wgs84 = pyproj.Transformer.from_crs(default_utm, wgs84, always_xy=True).transform


async def fetch_osm_data(location, streets_only=True):
    """
    Asynchronously fetch OSM data for the given location using the Overpass API.
    This version is fully async (do not use asyncio.run here) so that it works
    within the application's event loop.
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
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        async with session.get(OVERPASS_URL, params={"data": query}) as response:
            response.raise_for_status()
            osm_data = await response.json()
            return osm_data


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
    Also update coverage metadata for the location.
    This function:
      1. Iterates over all elements of type "way" in the OSM data.
      2. Creates a LineString from the node coordinates.
      3. Projects the line using the default transformer (project_to_utm) and segments it.
      4. Reprojects each segment back to WGS84.
      5. Assembles a GeoJSON Feature for each segment with metadata and inserts them into the streets_collection.
      6. Updates the coverage_metadata_collection for the location.
    """
    features = []
    total_length = 0

    for element in osm_data.get("elements", []):
        if element.get("type") != "way":
            continue
        try:
            nodes = [(node["lon"], node["lat"]) for node in element["geometry"]]
            line = LineString(nodes)
            # Project to UTM for segmentation.
            projected_line = transform(project_to_utm, line)
            segments = segment_street(projected_line)
            for i, segment in enumerate(segments):
                # Reproject each segment back to WGS84.
                segment_wgs84 = transform(project_to_wgs84, segment)
                segment_length = segment.length  # length in meters (in UTM units)
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
        try:
            streets_collection.insert_many(geojson_data["features"])
        except Exception as e:
            logger.error(f"Error inserting street segments: {e}", exc_info=True)
        try:
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
        except Exception as e:
            logger.error(f"Error updating coverage metadata: {e}", exc_info=True)
        logger.info(f"Stored {len(features)} street segments for {location['display_name']}.")
    else:
        logger.info(f"No valid street segments found for {location['display_name']}.")


async def preprocess_streets(validated_location):
    """
    Asynchronously preprocess street data for a given validated location.
    This function is designed to be invoked by the application.
    
    It performs the following steps:
      1. Asynchronously fetches OSM data for the location.
      2. Processes the OSM data (segments the streets) and inserts the segments into MongoDB.
      3. Updates coverage metadata for the location.
    """
    try:
        osm_data = await fetch_osm_data(validated_location)
        # Run the synchronous process_osm_data in a thread so as not to block the event loop.
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, process_osm_data, osm_data, validated_location)
        logger.info(f"Street preprocessing completed for {validated_location['display_name']}.")
    except Exception as e:
        logger.error(f"Error during street preprocessing: {e}", exc_info=True)


# This module is intended for import within the application.
if __name__ == "__main__":
    logger.info("This module is not meant to be run independently. Use it via your application.")