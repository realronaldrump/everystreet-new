import logging
import math
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

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
WGS84 = pyproj.CRS("EPSG:4326")
# For segmentation purposes, we define a default UTM projection (adjust as needed)
DEFAULT_UTM = pyproj.CRS("EPSG:32610")
project_to_utm = pyproj.Transformer.from_crs(
    WGS84, DEFAULT_UTM, always_xy=True
).transform
project_to_wgs84 = pyproj.Transformer.from_crs(
    DEFAULT_UTM, WGS84, always_xy=True
).transform


async def fetch_osm_data(
    location: Dict[str, Any], streets_only: bool = True
) -> Dict[str, Any]:
    """
    Asynchronously fetch OSM data for the given location using the Overpass API.
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
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(
            OVERPASS_URL, params={"data": query}
        ) as response:
            response.raise_for_status()
            osm_data = await response.json()
            return osm_data


def substring(
    line: LineString, start: float, end: float
) -> Optional[LineString]:
    """
    Return a segment (substring) of the LineString between distances start and end.
    """
    if start < 0 or end > line.length or start >= end:
        return None
    coords = list(line.coords)
    if start == 0 and end >= line.length:
        return line

    segment_coords = []
    accumulated = 0.0
    for i in range(len(coords) - 1):
        p0, p1 = coords[i], coords[i + 1]
        seg = LineString([p0, p1])
        seg_length = seg.length

        # Check if this segment contains the start
        if accumulated + seg_length < start:
            accumulated += seg_length
            continue

        # Determine the start point
        if accumulated < start <= accumulated + seg_length:
            fraction = (start - accumulated) / seg_length
            start_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
        else:
            start_point = p0

        # Determine the end point for the current segment
        if accumulated + seg_length >= end:
            fraction = (end - accumulated) / seg_length
            end_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
            if not segment_coords:
                segment_coords.append(start_point)
            else:
                # Ensure continuity if needed
                if segment_coords[-1] != start_point:
                    segment_coords.append(start_point)
            segment_coords.append(end_point)
            break
        else:
            if not segment_coords:
                segment_coords.append(start_point)
            else:
                if segment_coords[-1] != start_point:
                    segment_coords.append(start_point)
            segment_coords.append(p1)
            accumulated += seg_length

    return LineString(segment_coords) if len(segment_coords) >= 2 else None


def segment_street(
    line: LineString, segment_length_meters: float = 100
) -> List[LineString]:
    """
    Split a LineString into segments approximately segment_length_meters long.
    If the line is shorter than the target segment length, returns the line itself.
    """
    segments = []
    total_length = line.length
    if total_length <= segment_length_meters:
        return [line]
    # Use a while-loop to extract substrings
    start_distance = 0.0
    while start_distance < total_length:
        end_distance = min(
            start_distance + segment_length_meters, total_length
        )
        seg = substring(line, start_distance, end_distance)
        if seg is not None:
            segments.append(seg)
        start_distance = end_distance
    return segments


async def process_osm_data(
    osm_data: Dict[str, Any], location: Dict[str, Any]
) -> None:
    """
    Process OSM elements: segment each street (way) and store them in MongoDB.
    Also update coverage metadata for the location.
    """
    features = []
    total_length = 0.0

    for element in osm_data.get("elements", []):
        if element.get("type") != "way":
            continue
        try:
            # Extract coordinates from the element's geometry
            nodes = [
                (node["lon"], node["lat"]) for node in element["geometry"]
            ]
            if len(nodes) < 2:
                continue
            line = LineString(nodes)
            # Project to UTM for more accurate segmentation
            projected_line = transform(project_to_utm, line)
            segments = segment_street(
                projected_line, segment_length_meters=100
            )

            for i, segment in enumerate(segments):
                # Reproject each segment back to WGS84
                segment_wgs84 = transform(project_to_wgs84, segment)
                segment_length = segment.length  # in meters (UTM units)
                total_length += segment_length

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
                        "segment_length": segment_length,
                        "driven": False,
                        "last_updated": None,
                        "matched_trips": [],
                    },
                }
                features.append(feature)
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
    This involves:
      1. Fetching OSM data from the Overpass API.
      2. Segmenting the streets.
      3. Inserting segments into MongoDB and updating coverage metadata.
    """
    try:
        logger.info(
            "Starting street preprocessing for %s",
            validated_location["display_name"],
        )
        # Update metadata to indicate processing has started
        await coverage_metadata_collection.update_one(
            {"location.display_name": validated_location["display_name"]},
            {
                "$set": {
                    "status": "processing",
                    "last_updated": datetime.now(timezone.utc),
                }
            },
        )
        osm_data = await fetch_osm_data(validated_location, streets_only=True)
        await process_osm_data(osm_data, validated_location)
        logger.info(
            "Street preprocessing completed for %s.",
            validated_location["display_name"],
        )
    except Exception as e:
        logger.error(
            "Error during street preprocessing: %s", e, exc_info=True
        )
        # Update status to indicate error in metadata
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
