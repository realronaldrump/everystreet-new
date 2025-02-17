import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiohttp
import pyproj
from shapely.geometry import LineString, mapping
from shapely.ops import transform
from dotenv import load_dotenv

# Instead of creating our own client, we import from db
from db import streets_collection, coverage_metadata_collection

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

OVERPASS_URL = "http://overpass-api.de/api/interpreter"
WGS84 = pyproj.CRS("EPSG:4326")
# Example default UTM (adjust if needed)
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
    Fetch OSM data from Overpass API for a given location (which includes osm_id, osm_type).
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
    async with aiohttp.ClientSession(timeout=timeout) as session, session.get(
        OVERPASS_URL, params={"data": query}
    ) as response:
        response.raise_for_status()
        osm_data = await response.json()
        return osm_data


def substring(line: LineString, start: float, end: float) -> Optional[LineString]:
    """
    Return a sub-linestring from 'start' to 'end' (in the line's local distance measure).
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

        if accumulated + seg_length < start:
            accumulated += seg_length
            continue

        # start
        if accumulated < start <= accumulated + seg_length:
            fraction = (start - accumulated) / seg_length
            start_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
        else:
            start_point = p0

        # end
        if accumulated + seg_length >= end:
            fraction = (end - accumulated) / seg_length
            end_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
            if not segment_coords:
                segment_coords.append(start_point)
            else:
                if segment_coords[-1] != start_point:
                    segment_coords.append(start_point)
            segment_coords.append(end_point)
            break

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
    Split a linestring into segments ~ segment_length_meters long.
    """
    segments = []
    total_length = line.length
    if total_length <= segment_length_meters:
        return [line]

    start_distance = 0.0
    while start_distance < total_length:
        end_distance = min(start_distance + segment_length_meters, total_length)
        seg = substring(line, start_distance, end_distance)
        if seg is not None:
            segments.append(seg)
        start_distance = end_distance
    return segments


async def process_osm_data(osm_data: Dict[str, Any], location: Dict[str, Any]) -> None:
    """
    Convert OSM ways into segmented Feature docs. Insert them into streets_collection.
    Update coverage_metadata_collection with total_length, total_segments, etc.
    """
    features = []
    total_length = 0.0
    for element in osm_data.get("elements", []):
        if element.get("type") != "way":
            continue
        try:
            nodes = [(node["lon"], node["lat"]) for node in element["geometry"]]
            if len(nodes) < 2:
                continue
            line = LineString(nodes)
            projected_line = transform(project_to_utm, line)
            segments = segment_street(projected_line, segment_length_meters=100)

            for i, segment in enumerate(segments):
                segment_wgs84 = transform(project_to_wgs84, segment)
                segment_length = segment.length  # in meters
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
        logger.info("No valid street segments found for %s.", location["display_name"])


async def preprocess_streets(validated_location: Dict[str, Any]) -> None:
    """
    Preprocess street data for a validated location:
      1) Fetch from Overpass
      2) Segment
      3) Store in DB, update coverage metadata
    """
    try:
        logger.info(
            "Starting street preprocessing for %s",
            validated_location["display_name"],
        )
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
        logger.error("Error during street preprocessing: %s", e, exc_info=True)
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
