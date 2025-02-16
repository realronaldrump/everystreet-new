import os
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any

import aiohttp
from motor.motor_asyncio import AsyncIOMotorClient
from shapely.geometry import LineString, mapping, Point
from shapely.ops import transform
import pyproj
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# MongoDB setup using Motor (asynchronous)
MONGO_URI = os.getenv("MONGO_URI")
client = AsyncIOMotorClient(MONGO_URI, tz_aware=True)
db = client["every_street"]
streets_collection = db["streets"]
coverage_metadata_collection = db["coverage_metadata"]

# Overpass API endpoint
OVERPASS_URL = "http://overpass-api.de/api/interpreter"

# Coordinate reference systems and transformers
wgs84 = pyproj.CRS("EPSG:4326")
# For segmentation purposes, we define a default UTM projection.
default_utm = pyproj.CRS("EPSG:32610")  # Adjust the UTM zone as needed.
project_to_utm = pyproj.Transformer.from_crs(
    wgs84, default_utm, always_xy=True
).transform
project_to_wgs84 = pyproj.Transformer.from_crs(
    default_utm, wgs84, always_xy=True
).transform


async def fetch_osm_data(
    location: Dict[str, Any], streets_only: bool = True
) -> Dict[str, Any]:
    """
    Asynchronously fetch OSM data for the given location using the Overpass API.

    Args:
        location: Dictionary containing location data with osm_id and osm_type.
        streets_only: If True, only fetch street data. If False, fetch all data.

    Returns:
        Dictionary containing the OSM data response.

    Raises:
        aiohttp.ClientError: If there's an error fetching the data.
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
    async with (
        aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=30)
        ) as session,
        session.get(OVERPASS_URL, params={"data": query}) as response,
    ):
        response.raise_for_status()
        osm_data = await response.json()
        return osm_data


def segment_street(
    line: LineString, segment_length_meters: float = 100
) -> List[LineString]:
    """
    Split a LineString into segments each roughly segment_length_meters long.

    Args:
        line: The LineString to segment.
        segment_length_meters: Target length for each segment in meters.

    Returns:
        List of LineString segments.
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


def cut(
    line: LineString, start_distance: float, end_distance: float
) -> Optional[LineString]:
    """
    Cut a LineString between start_distance and end_distance.

    Args:
        line: The LineString to cut.
        start_distance: Starting distance along the line.
        end_distance: Ending distance along the line.

    Returns:
        A new LineString for the cut segment or None if invalid.
    """
    if (
        start_distance < 0
        or end_distance > line.length
        or start_distance >= end_distance
    ):
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


async def process_osm_data(
    osm_data: Dict[str, Any], location: Dict[str, Any]
) -> None:
    """
    Process OSM elements: segment each street (way) and store them in MongoDB.
    Also update coverage metadata for the location.

    Args:
        osm_data: Dictionary containing OSM data response.
        location: Dictionary containing location information.
    """
    features = []
    total_length = 0.0  # Explicitly declare as float

    for element in osm_data.get("elements", []):
        if element.get("type") != "way":
            continue
        try:
            nodes = [
                (node["lon"], node["lat"]) for node in element["geometry"]
            ]
            line = LineString(nodes)
            # Project to UTM for segmentation
            projected_line = transform(project_to_utm, line)
            segments = segment_street(projected_line)

            for i, segment in enumerate(segments):
                # Reproject each segment back to WGS84
                segment_wgs84 = transform(project_to_wgs84, segment)
                segment_length = (
                    segment.length
                )  # Length in meters (UTM units)

                feature = {
                    "type": "Feature",
                    "geometry": mapping(segment_wgs84),
                    "properties": {
                        "street_id": element["id"],
                        "segment_id": f"{element['id']}-{i}",
                        "street_name": element.get("tags", {}).get(
                            "name", "Unnamed Street"
                        ),
                        "location": location["display_name"],
                        "length": segment_length,
                        "driven": False,
                        "last_updated": None,
                        "matched_trips": [],
                    },
                }
                features.append(feature)
                total_length += segment_length
        except Exception as e:
            logger.error(
                "Error processing element %s: %s",
                element.get("id"),
                e,
                exc_info=True,
            )

    if features:
        try:
            await streets_collection.insert_many(features)
            await coverage_metadata_collection.update_one(
                {"location.display_name": location.get("display_name")},
                {
                    "$set": {
                        "location": location,
                        "total_segments": len(features),
                        "total_length": total_length,
                        "driven_length": 0,
                        "coverage_percentage": 0.0,
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
                upsert=True,
            )
            logger.info(
                "Stored %d street segments for %s.",
                len(features),
                location["display_name"],
            )
        except Exception as e:
            logger.error("Error storing data: %s", e, exc_info=True)
    else:
        logger.info(
            "No valid street segments found for %s.", location["display_name"]
        )


async def preprocess_streets(validated_location: Dict[str, Any]) -> None:
    """
    Asynchronously preprocess street data for a given validated location.

    Args:
        validated_location: Dictionary containing validated location data.

    This function performs:
        1. Asynchronously fetching OSM data for the location.
        2. Processing the OSM data (segmenting streets) and inserting the segments into
        MongoDB.
        3. Updating the coverage metadata for the location.
    """
    try:
        logger.info(
            "Starting street preprocessing for %s",
            validated_location["display_name"],
        )

        # Update status to indicate processing has started
        await coverage_metadata_collection.update_one(
            {"location.display_name": validated_location["display_name"]},
            {
                "$set": {
                    "status": "processing",
                    "last_updated": datetime.now(timezone.utc),
                }
            },
        )

        osm_data = await fetch_osm_data(validated_location)
        await process_osm_data(osm_data, validated_location)

        logger.info(
            "Street preprocessing completed for %s.",
            validated_location["display_name"],
        )
    except Exception as e:
        logger.error(
            "Error during street preprocessing: %s", e, exc_info=True
        )
        # Update status to indicate error
        await coverage_metadata_collection.update_one(
            {"location.display_name": validated_location["display_name"]},
            {
                "$set": {
                    "status": "error",
                    "last_error": str(e),
                    "last_updated": datetime.now(timezone.utc),
                }
            },
        )
        raise


if __name__ == "__main__":
    logger.info(
        "This module is not meant to be run independently. Use it via your application."
    )
