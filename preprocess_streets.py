"""
preprocess_streets.py

Fetches OSM data from Overpass for a given location, segments street geometries in
parallel, and updates the database with the street segments and coverage metadata.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

import asyncio
import multiprocessing
from concurrent.futures import ProcessPoolExecutor

import aiohttp
import pyproj
from shapely.geometry import LineString, mapping
from shapely.ops import transform
from dotenv import load_dotenv

from db import streets_collection, coverage_metadata_collection

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

OVERPASS_URL = "http://overpass-api.de/api/interpreter"
WGS84 = pyproj.CRS("EPSG:4326")
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
    area_id = int(location["osm_id"])
    if location["osm_type"] == "relation":
        area_id += 3600000000
    if streets_only:
        query = f"""
        [out:json];
        area({area_id})->.searchArea;
        (way["highway"](area.searchArea););
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
        async with session.get(OVERPASS_URL, params={"data": query}) as response:
            response.raise_for_status()
            osm_data = await response.json()
            return osm_data


def substring(line: LineString, start: float, end: float) -> Any:
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
        if accumulated < start <= accumulated + seg_length:
            fraction = (start - accumulated) / seg_length
            start_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
        else:
            start_point = p0
        if accumulated + seg_length >= end:
            fraction = (end - accumulated) / seg_length
            end_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
            if not segment_coords:
                segment_coords.append(start_point)
            elif segment_coords[-1] != start_point:
                segment_coords.append(start_point)
            segment_coords.append(end_point)
            break
        if not segment_coords:
            segment_coords.append(start_point)
        elif segment_coords[-1] != start_point:
            segment_coords.append(start_point)
        segment_coords.append(p1)
        accumulated += seg_length
    return LineString(segment_coords) if len(segment_coords) >= 2 else None


def segment_street(
    line: LineString, segment_length_meters: float = 100
) -> List[LineString]:
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


def process_element_parallel(element_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    try:
        element = element_data["element"]
        location = element_data["location"]
        proj_to_utm = element_data["project_to_utm"]
        proj_to_wgs84 = element_data["project_to_wgs84"]
        nodes = [(node["lon"], node["lat"]) for node in element.get("geometry", [])]
        if len(nodes) < 2:
            return []
        line = LineString(nodes)
        projected_line = transform(proj_to_utm, line)
        segments = segment_street(projected_line, segment_length_meters=100)
        features = []
        for i, segment in enumerate(segments):
            segment_wgs84 = transform(proj_to_wgs84, segment)
            feature = {
                "type": "Feature",
                "geometry": mapping(segment_wgs84),
                "properties": {
                    "street_id": element["id"],
                    "segment_id": f"{element['id']}-{i}",
                    "street_name": element.get("tags", {}).get(
                        "name", "Unnamed Street"
                    ),
                    "location": location,
                    "segment_length": segment.length,
                    "driven": False,
                    "last_updated": None,
                    "matched_trips": [],
                },
            }
            features.append(feature)
        return features
    except Exception as e:
        logger.error(
            "Error processing element %s: %s", element_data["element"].get("id"), e
        )
        return []


async def process_osm_data(osm_data: Dict[str, Any], location: Dict[str, Any]) -> None:
    features = []
    total_length = 0.0
    way_elements = [
        el for el in osm_data.get("elements", []) if el.get("type") == "way"
    ]
    if not way_elements:
        return
    process_data = [
        {
            "element": el,
            "location": location["display_name"],
            "project_to_utm": project_to_utm,
            "project_to_wgs84": project_to_wgs84,
        }
        for el in way_elements
    ]
    with ProcessPoolExecutor(max_workers=multiprocessing.cpu_count()) as executor:
        loop = asyncio.get_event_loop()
        feature_lists = await loop.run_in_executor(
            None, lambda: list(executor.map(process_element_parallel, process_data))
        )
    for flist in feature_lists:
        for feat in flist:
            features.append(feat)
            total_length += feat["properties"]["segment_length"]
    if features:
        await streets_collection.insert_many(features)
        await coverage_metadata_collection.update_one(
            {"location.display_name": location["display_name"]},
            {
                "$set": {
                    "location": location,
                    "total_length": total_length,
                    "total_segments": len(features),
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        logger.info(
            "Processed %d street segments for %s",
            len(features),
            location["display_name"],
        )
    else:
        logger.warning(
            "No valid street segments found for %s", location["display_name"]
        )


async def preprocess_streets(validated_location: Dict[str, Any]) -> None:
    try:
        logger.info(
            "Starting street preprocessing for %s", validated_location["display_name"]
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
            "Street preprocessing completed for %s", validated_location["display_name"]
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
