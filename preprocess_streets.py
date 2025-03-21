"""
Preprocess streets module.
Fetches OSM data from Overpass, segments street geometries in parallel, and updates the database.
"""

import asyncio
import gc
import logging
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, TimeoutError
from datetime import datetime, timezone
from typing import Any, Dict, List

import aiohttp
import pyproj
from dotenv import load_dotenv
from shapely.geometry import LineString, mapping
from shapely.ops import transform

from db import coverage_metadata_collection, streets_collection

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

# Constants for better performance
SEGMENT_LENGTH_METERS = 100  # Street segment length
BATCH_SIZE = 200  # Reduced from default higher values
PROCESS_TIMEOUT = 300  # 5 minutes timeout for long operations
MAX_WORKERS = min(multiprocessing.cpu_count() // 2, 3)  # Reduced worker count


async def fetch_osm_data(
    location: Dict[str, Any], streets_only: bool = True
) -> Dict[str, Any]:
    """
    Fetch OSM data from Overpass API for a given location.
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
        ({location["osm_type"]}({location["osm_id"]});
        >;
        );
        out geom;
        """

    # Extended timeout and retries
    timeout = aiohttp.ClientTimeout(total=60)
    retry_count = 3
    current_try = 0

    while current_try < retry_count:
        try:
            async with (
                aiohttp.ClientSession(timeout=timeout) as session,
                session.get(OVERPASS_URL, params={"data": query}) as response,
            ):
                response.raise_for_status()
                osm_data = await response.json()
                return osm_data
        except aiohttp.ClientError as e:
            current_try += 1
            if current_try >= retry_count:
                logger.error(f"Failed to fetch OSM data after {retry_count} tries: {e}")
                raise
            logger.warning(
                f"Error fetching OSM data (attempt {current_try}): {e}. Retrying..."
            )
            await asyncio.sleep(2**current_try)  # Exponential backoff


def substring(line: LineString, start: float, end: float) -> Any:
    """
    Return a sub-linestring from 'start' to 'end' along the line.
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
    line: LineString, segment_length_meters: float = SEGMENT_LENGTH_METERS
) -> List[LineString]:
    """
    Split a linestring into segments of approximately segment_length_meters.
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


def process_element_parallel(element_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Process a single street element in parallel.
    Returns a list of segmented feature dictionaries.
    """
    try:
        element = element_data["element"]
        location = element_data["location"]
        proj_to_utm = element_data["project_to_utm"]
        proj_to_wgs84 = element_data["project_to_wgs84"]
        nodes = [(node["lon"], node["lat"]) for node in element["geometry"]]
        if len(nodes) < 2:
            return []
        line = LineString(nodes)
        projected_line = transform(proj_to_utm, line)
        segments = segment_street(
            projected_line, segment_length_meters=SEGMENT_LENGTH_METERS
        )
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
                    "highway": element.get("tags", {}).get("highway", "unknown"),
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
    """
    Convert OSM ways into segmented features and insert them into streets_collection.
    Also update coverage metadata.
    """
    try:
        features = []
        total_length = 0.0
        way_elements = [
            element
            for element in osm_data.get("elements", [])
            if element.get("type") == "way"
            and "geometry" in element
            and len(element.get("geometry", [])) >= 2
        ]

        if not way_elements:
            logger.warning(
                f"No valid way elements found for {location['display_name']}"
            )
            return

        logger.info(
            f"Processing {len(way_elements)} street segments for {location['display_name']}"
        )

        # Process elements in smaller batches to manage memory better
        batch_size = BATCH_SIZE
        batches = [
            way_elements[i : i + batch_size]
            for i in range(0, len(way_elements), batch_size)
        ]

        # Track processed segments for logging
        processed_segments = 0

        # Process each batch
        with ProcessPoolExecutor(max_workers=MAX_WORKERS) as executor:
            for batch_idx, batch in enumerate(batches):
                process_data = [
                    {
                        "element": element,
                        "location": location["display_name"],
                        "project_to_utm": project_to_utm,
                        "project_to_wgs84": project_to_wgs84,
                    }
                    for element in batch
                ]

                try:
                    # Use asyncio.wait_for to add a timeout to the executor
                    loop = asyncio.get_event_loop()
                    feature_lists = await asyncio.wait_for(
                        loop.run_in_executor(
                            None,
                            lambda: list(
                                executor.map(process_element_parallel, process_data)
                            ),
                        ),
                        timeout=PROCESS_TIMEOUT,
                    )

                    batch_features = []
                    for feature_list in feature_lists:
                        for feature in feature_list:
                            batch_features.append(feature)
                            total_length += feature["properties"]["segment_length"]

                    # Insert batch if not empty
                    if batch_features:
                        await streets_collection.insert_many(batch_features)
                        features.extend(batch_features)
                        processed_segments += len(batch_features)

                    # Log progress every few batches
                    if (batch_idx + 1) % 5 == 0 or batch_idx == len(batches) - 1:
                        logger.info(
                            f"Processed batch {batch_idx + 1}/{len(batches)} with {len(batch_features)} street segments"
                        )

                    # Run garbage collection periodically
                    if (batch_idx + 1) % 5 == 0:
                        gc.collect()

                    # Give the event loop a chance to process other tasks
                    await asyncio.sleep(0.1)

                except TimeoutError:
                    logger.warning(
                        f"Batch {batch_idx + 1} processing timed out, continuing with next batch"
                    )
                except Exception as e:
                    logger.error(f"Error processing batch {batch_idx + 1}: {str(e)}")

        # Update coverage metadata once at the end
        if features:
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
                processed_segments,
                location["display_name"],
            )
        else:
            logger.warning(
                "No valid street segments found for %s", location["display_name"]
            )

    except Exception as e:
        logger.error(f"Error in process_osm_data: {str(e)}", exc_info=True)
        raise


async def preprocess_streets(validated_location: Dict[str, Any]) -> None:
    """
    Preprocess street data for a validated location:
    Fetch OSM data, segment streets, and update the database.
    """
    try:
        logger.info(
            "Starting street preprocessing for %s", validated_location["display_name"]
        )

        # Update status to processing
        await coverage_metadata_collection.update_one(
            {"location.display_name": validated_location["display_name"]},
            {
                "$set": {
                    "status": "processing",
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        # Fetch OSM data with timeout
        try:
            osm_data = await asyncio.wait_for(
                fetch_osm_data(validated_location, streets_only=True),
                timeout=180,  # 3 minute timeout for fetching data
            )
        except asyncio.TimeoutError:
            logger.error(
                f"Timeout fetching OSM data for {validated_location['display_name']}"
            )
            await coverage_metadata_collection.update_one(
                {"location.display_name": validated_location["display_name"]},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Timeout fetching OSM data",
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )
            return

        # Process data with timeout
        try:
            await asyncio.wait_for(
                process_osm_data(osm_data, validated_location),
                timeout=1800,  # 30 minute timeout for processing
            )
        except asyncio.TimeoutError:
            logger.error(
                f"Timeout processing OSM data for {validated_location['display_name']}"
            )
            await coverage_metadata_collection.update_one(
                {"location.display_name": validated_location["display_name"]},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Timeout processing street data",
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )
            return

        logger.info(
            "Street preprocessing completed for %s.", validated_location["display_name"]
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
    finally:
        # Force garbage collection
        gc.collect()
