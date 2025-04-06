"""Preprocess streets module.

Fetches OSM data from Overpass (excluding non-drivable ways, parking lots,
private roads), segments street geometries in parallel using a dynamically
determined UTM zone for accuracy, and updates the database.
"""

import asyncio
import gc
import logging
import math
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, TimeoutError
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import aiohttp
import pyproj
from dotenv import load_dotenv
from pymongo.errors import BulkWriteError
from shapely.geometry import LineString, mapping
from shapely.ops import transform

from db import (
    coverage_metadata_collection,
    delete_many_with_retry,
    streets_collection,
    update_one_with_retry,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

OVERPASS_URL = "http://overpass-api.de/api/interpreter"
WGS84 = pyproj.CRS("EPSG:4326")

EXCLUDED_HIGHWAY_TYPES_REGEX = (
    "footway|path|steps|pedestrian|bridleway|cycleway|corridor|"
    "platform|raceway|proposed|construction|track"
)
EXCLUDED_ACCESS_TYPES_REGEX = "private|no|customers|delivery|agricultural|forestry"
EXCLUDED_SERVICE_TYPES_REGEX = "parking_aisle|driveway"


SEGMENT_LENGTH_METERS = 100
BATCH_SIZE = 1000
PROCESS_TIMEOUT = 30000
MAX_WORKERS = min(multiprocessing.cpu_count(), 8)


def get_dynamic_utm_crs(latitude: float, longitude: float) -> pyproj.CRS:
    """
    Determines the appropriate UTM or UPS CRS for a given latitude and longitude.

    Args:
        latitude: Latitude of the location's center.
        longitude: Longitude of the location's center.

    Returns:
        A pyproj.CRS object representing the best UTM/UPS zone.
        Falls back to EPSG:32610 (UTM Zone 10N) if calculation fails.
    """
    fallback_crs_epsg = 32610

    try:
        if latitude >= 84.0:
            return pyproj.CRS("EPSG:32661")
        if latitude <= -80.0:
            return pyproj.CRS("EPSG:32761")

        zone_number = math.floor((longitude + 180) / 6) + 1
        is_northern = latitude >= 0

        if is_northern:
            epsg_code = 32600 + zone_number
        else:
            epsg_code = 32700 + zone_number

        return pyproj.CRS(f"EPSG:{epsg_code}")

    except Exception as e:
        logger.warning(
            "Failed to determine dynamic UTM/UPS CRS for lat=%s, lon=%s: %s. Falling back to EPSG:%d.",
            latitude,
            longitude,
            e,
            fallback_crs_epsg,
        )
        return pyproj.CRS(f"EPSG:{fallback_crs_epsg}")


async def fetch_osm_data(
    location: Dict[str, Any], streets_only: bool = True
) -> Dict[str, Any]:
    """Fetch OSM data from Overpass API for a given location.

    If streets_only is True, filters out non-vehicular ways, parking lots,
    private roads, and certain service roads using an enhanced Overpass query.
    """
    area_id = int(location["osm_id"])
    if location["osm_type"] == "relation":
        area_id += 3600000000

    if streets_only:
        query = f"""
        [out:json][timeout:180];
        // Define the search area based on OSM ID
        area({area_id})->.searchArea;
        (
          // Initial selection: Ways with a highway tag in the area
          way["highway"](area.searchArea)
          // Exclude non-vehicular highway types
          ["highway"!~"{EXCLUDED_HIGHWAY_TYPES_REGEX}"]
          // Exclude features tagged primarily as parking areas
          ["amenity"!="parking"]
          // Exclude ways with explicitly restricted access tags
          ["access"!~"{EXCLUDED_ACCESS_TYPES_REGEX}"]
          // Exclude ways where motor vehicles are explicitly forbidden
          ["motor_vehicle"!="no"]
          // Exclude ways marked as generally impassable
          ["impassable"!="yes"]
          // Store these candidates
          ->.potential_ways;

          // Identify specific service ways to exclude (parking aisles, driveways)
          // These often represent non-drivable parts of parking lots or private property
          way(area.searchArea)["highway"="service"]["service"~"{EXCLUDED_SERVICE_TYPES_REGEX}"]
          ->.unwanted_service_ways;

          // Final result: potential ways MINUS unwanted service ways
          (
            way.potential_ways; - way.unwanted_service_ways;
          );
        );
        // Recurse down to nodes to get geometry data for the final set of ways
        (._;>;);
        out geom; // Output geometry
        """
        logger.info(
            "Using enhanced Overpass query to exclude non-drivable/private ways for preprocessing."
        )
    else:
        query = f"""
        [out:json][timeout=60];
        ({location["osm_type"]}({location["osm_id"]});
        >;
        );
        out geom;
        """

    timeout = aiohttp.ClientTimeout(total=240)
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
                logger.info(
                    "Successfully fetched OSM data for %s.",
                    location["display_name"],
                )
                return osm_data
        except aiohttp.ClientResponseError as http_err:
            current_try += 1
            logger.warning(
                "Overpass API error (Attempt %d/%d) for %s: %s - %s",
                current_try,
                retry_count,
                location["display_name"],
                http_err.status,
                http_err.message,
            )
            try:
                error_body = await http_err.response.text()
                logger.warning("Overpass error body: %s", error_body[:500])
            except Exception:
                pass
            if current_try >= retry_count or http_err.status == 400:
                logger.error(
                    "Failed to fetch OSM data for %s after %d tries due to HTTP error.",
                    location["display_name"],
                    retry_count,
                )
                raise http_err
            await asyncio.sleep(2**current_try)
        except aiohttp.ClientError as e:
            current_try += 1
            logger.warning(
                "Error fetching OSM data (Attempt %d/%d) for %s: %s. Retrying...",
                current_try,
                retry_count,
                location["display_name"],
                e,
            )
            if current_try >= retry_count:
                logger.error(
                    "Failed to fetch OSM data for %s after %d tries: %s",
                    location["display_name"],
                    retry_count,
                    e,
                )
                raise
            await asyncio.sleep(2**current_try)


def substring(line: LineString, start: float, end: float) -> Optional[LineString]:
    """Return a sub-linestring from 'start' to 'end' along the line (UTM
    coords)."""
    if start < 0 or end > line.length or start >= end or abs(line.length) < 1e-6:
        return None

    coords = list(line.coords)
    if start <= 1e-6 and end >= line.length - 1e-6:
        return line

    segment_coords = []
    accumulated = 0.0

    start_point = None
    for i in range(len(coords) - 1):
        p0, p1 = coords[i], coords[i + 1]
        seg = LineString([p0, p1])
        seg_length = seg.length
        if seg_length < 1e-6:
            continue

        if accumulated <= start < accumulated + seg_length:
            fraction = (start - accumulated) / seg_length
            start_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
            break
        accumulated += seg_length
    else:
        if abs(start - line.length) < 1e-6:
            start_point = coords[-1]
        else:
            return None

    if start_point:
        segment_coords.append(start_point)

    accumulated = 0.0
    for i in range(len(coords) - 1):
        p0, p1 = coords[i], coords[i + 1]
        seg = LineString([p0, p1])
        seg_length = seg.length
        if seg_length < 1e-6:
            continue

        current_end_accum = accumulated + seg_length

        if accumulated >= start:
            if not segment_coords or segment_coords[-1] != p0:
                if (
                    segment_coords
                    and LineString([segment_coords[-1], p0]).length > 1e-6
                ):
                    segment_coords.append(p0)
                elif not segment_coords:
                    segment_coords.append(p0)

        if accumulated < end <= current_end_accum:
            fraction = (end - accumulated) / seg_length
            end_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
            if (
                not segment_coords
                or LineString([segment_coords[-1], end_point]).length > 1e-6
            ):
                segment_coords.append(end_point)
            break

        elif start <= accumulated and current_end_accum <= end:
            if not segment_coords or LineString([segment_coords[-1], p1]).length > 1e-6:
                segment_coords.append(p1)

        accumulated += seg_length

    if len(segment_coords) >= 2:
        if (
            LineString([segment_coords[0], segment_coords[-1]]).length < 1e-6
            and len(segment_coords) == 2
        ):
            return None
        try:
            return LineString(segment_coords)
        except Exception:
            logger.warning(
                "Failed to create LineString from segment coords: %s",
                segment_coords,
            )
            return None
    else:
        return None


def segment_street(
    line: LineString, segment_length_meters: float = SEGMENT_LENGTH_METERS
) -> List[LineString]:
    """Split a linestring (in UTM) into segments of approximately
    segment_length_meters."""
    segments = []
    total_length = line.length
    if total_length <= segment_length_meters + 1e-6:
        return [line]

    start_distance = 0.0
    while start_distance < total_length - 1e-6:
        end_distance = min(start_distance + segment_length_meters, total_length)
        seg = substring(line, start_distance, end_distance)
        if seg is not None and seg.length > 1e-6:
            segments.append(seg)
        start_distance = end_distance

    if not segments and total_length > 1e-6:
        logger.warning(
            "Segmentation resulted in no segments for line with length %s. Returning original line.",
            total_length,
        )
        return [line]

    return segments


def process_element_parallel(
    element_data: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Process a single street element in parallel.

    Uses the provided projection functions and minimal element data.
    Returns a list of segmented feature dictionaries.
    """
    try:
        osm_id = element_data["osm_id"]
        geometry_nodes = element_data["geometry_nodes"]
        tags = element_data["tags"]
        location_name = element_data["location_name"]
        proj_to_utm: Callable = element_data["project_to_utm"]
        proj_to_wgs84: Callable = element_data["project_to_wgs84"]

        nodes = [(node["lon"], node["lat"]) for node in geometry_nodes]
        if len(nodes) < 2:
            return []

        highway_type = tags.get("highway", "unknown")

        line_wgs84 = LineString(nodes)
        projected_line = transform(proj_to_utm, line_wgs84)

        if projected_line.length < 1e-6:
            return []

        segments = segment_street(
            projected_line, segment_length_meters=SEGMENT_LENGTH_METERS
        )

        features = []
        for i, segment_utm in enumerate(segments):
            if segment_utm.length < 1e-6:
                continue
            segment_wgs84 = transform(proj_to_wgs84, segment_utm)
            if not segment_wgs84.is_valid or segment_wgs84.is_empty:
                logger.warning("Skipping invalid/empty segment %s-%d", osm_id, i)
                continue

            feature = {
                "type": "Feature",
                "geometry": mapping(segment_wgs84),
                "properties": {
                    "osm_id": osm_id,
                    "segment_id": f"{osm_id}-{i}",
                    "street_name": tags.get("name", "Unnamed Street"),
                    "highway": highway_type,
                    "location": location_name,
                    "segment_length": segment_utm.length,
                    "driven": False,
                    "undriveable": False,
                    "manual_override": False,
                    "manually_marked_driven": False,
                    "manually_marked_undriven": False,
                    "manually_marked_undriveable": False,
                    "manually_marked_driveable": False,
                    "last_coverage_update": None,
                    "last_manual_update": None,
                    "matched_trips": [],
                    "tags": tags,
                },
            }
            features.append(feature)
        return features
    except Exception as e:
        osm_id_str = element_data.get("osm_id", "UNKNOWN_ID")
        logger.error("Error processing element %s: %s", osm_id_str, e, exc_info=True)
        return []


async def process_osm_data(
    osm_data: Dict[str, Any],
    location: Dict[str, Any],
    project_to_utm_func: Callable,
    project_to_wgs84_func: Callable,
) -> None:
    """Convert OSM ways into segmented features and insert them into
    streets_collection.

    Uses the provided projection functions and parallel processing.
    Also update coverage metadata.
    """
    try:
        location_name = location["display_name"]
        total_length = 0.0
        way_elements = [
            element
            for element in osm_data.get("elements", [])
            if element.get("type") == "way"
            and "geometry" in element
            and isinstance(element.get("geometry"), list)
            and len(element.get("geometry", [])) >= 2
        ]

        if not way_elements:
            logger.warning(
                "No valid way elements found for %s after filtering.",
                location_name,
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": 0.0,
                        "total_segments": 0,
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",
                        "last_error": None,
                    }
                },
                upsert=True,
            )
            return

        logger.info(
            "Processing %d potentially drivable street ways for %s",
            len(way_elements),
            location_name,
        )

        process_data = [
            {
                "osm_id": element.get("id"),
                "geometry_nodes": element.get("geometry", []),
                "tags": element.get("tags", {}),
                "location_name": location_name,
                "project_to_utm": project_to_utm_func,
                "project_to_wgs84": project_to_wgs84_func,
            }
            for element in way_elements
            if element.get("id") is not None and element.get("geometry") is not None
        ]

        processed_segments_count = 0
        total_segments_count = 0

        with ProcessPoolExecutor(max_workers=MAX_WORKERS) as executor:
            loop = asyncio.get_event_loop()
            tasks = [
                loop.run_in_executor(executor, process_element_parallel, data)
                for data in process_data
            ]

            batch_to_insert = []
            for i, future in enumerate(asyncio.as_completed(tasks)):
                try:
                    segment_features = await asyncio.wait_for(
                        future, timeout=PROCESS_TIMEOUT
                    )
                    if segment_features:
                        batch_to_insert.extend(segment_features)
                        total_segments_count += len(segment_features)
                        for feature in segment_features:
                            length = feature.get("properties", {}).get("segment_length")
                            if isinstance(length, (int, float)):
                                total_length += length
                            else:
                                logger.warning(
                                    f"Segment {feature.get('properties', {}).get('segment_id')} missing valid length."
                                )

                    if len(batch_to_insert) >= BATCH_SIZE:
                        try:
                            await streets_collection.insert_many(
                                batch_to_insert, ordered=False
                            )
                            processed_segments_count += len(batch_to_insert)
                            logger.info(
                                "Inserted batch of %d segments (%d/%d total processed for %s)",
                                len(batch_to_insert),
                                processed_segments_count,
                                total_segments_count,
                                location_name,
                            )
                            batch_to_insert = []
                            gc.collect()
                            await asyncio.sleep(0.05)
                        except BulkWriteError as bwe:
                            write_errors = bwe.details.get("writeErrors", [])
                            dup_keys = [
                                e for e in write_errors if e.get("code") == 11000
                            ]
                            if dup_keys:
                                logger.warning(
                                    f"Skipped {len(dup_keys)} duplicate segments during batch insert for {location_name}."
                                )
                            other_errors = [
                                e for e in write_errors if e.get("code") != 11000
                            ]
                            if other_errors:
                                logger.error(
                                    f"Non-duplicate BulkWriteError inserting batch for {location_name}: {other_errors}"
                                )

                            batch_to_insert = []
                        except Exception as insert_err:
                            logger.error(
                                "Error inserting batch: %s",
                                insert_err,
                                exc_info=True,
                            )
                            batch_to_insert = []

                except TimeoutError:
                    logger.warning(
                        "Processing element task timed out after %ds.",
                        PROCESS_TIMEOUT,
                    )
                except Exception as e:
                    logger.error(
                        "Error processing element future: %s", e, exc_info=True
                    )

                if (i + 1) % (max(1, len(tasks) // 20)) == 0:
                    logger.info(
                        "Processed %d/%d way futures for %s...",
                        i + 1,
                        len(tasks),
                        location_name,
                    )

            if batch_to_insert:
                try:
                    await streets_collection.insert_many(batch_to_insert, ordered=False)
                    processed_segments_count += len(batch_to_insert)
                    logger.info(
                        "Inserted final batch of %d segments (%d/%d total processed for %s)",
                        len(batch_to_insert),
                        processed_segments_count,
                        total_segments_count,
                        location_name,
                    )
                except BulkWriteError as bwe:
                    write_errors = bwe.details.get("writeErrors", [])
                    dup_keys = [e for e in write_errors if e.get("code") == 11000]
                    if dup_keys:
                        logger.warning(
                            f"Skipped {len(dup_keys)} duplicate segments during final batch insert for {location_name}."
                        )
                    other_errors = [e for e in write_errors if e.get("code") != 11000]
                    if other_errors:
                        logger.error(
                            f"Non-duplicate BulkWriteError inserting final batch for {location_name}: {other_errors}"
                        )
                except Exception as insert_err:
                    logger.error(
                        "Error inserting final batch: %s",
                        insert_err,
                        exc_info=True,
                    )

        if total_segments_count > 0:
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": total_length,
                        "total_segments": total_segments_count,
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",
                        "last_error": None,
                    }
                },
                upsert=True,
            )
            logger.info(
                "Successfully processed %d street segments (total length %.2f m) for %s",
                total_segments_count,
                total_length,
                location_name,
            )
        else:
            logger.warning(
                "No valid street segments were generated for %s after filtering and processing.",
                location_name,
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": 0.0,
                        "total_segments": 0,
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",
                        "last_error": "No segments generated after filtering",
                    }
                },
                upsert=True,
            )

    except Exception as e:
        logger.error(
            "Error in process_osm_data for %s: %s",
            location.get("display_name", "Unknown"),
            e,
            exc_info=True,
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location.get("display_name", "Unknown")},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"Preprocessing failed: {str(e)}",
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        raise


async def preprocess_streets(validated_location: Dict[str, Any]) -> None:
    """
    Preprocess street data for a validated location:
    Fetch filtered OSM data (excluding non-drivable/private ways),
    determine appropriate UTM zone, segment streets, and update the database.
    """
    location_name = validated_location["display_name"]
    try:
        logger.info("Starting street preprocessing for %s", location_name)

        center_lat = None
        center_lon = None
        try:
            center_lat = float(validated_location.get("lat"))
            center_lon = float(validated_location.get("lon"))
        except (TypeError, ValueError, AttributeError):
            logger.warning(
                "Location %s is missing valid lat/lon. Cannot determine dynamic UTM.",
                location_name,
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Missing lat/lon for UTM calculation",
                    }
                },
                upsert=True,
            )
            raise ValueError(f"Location {location_name} lacks lat/lon for dynamic UTM.")

        dynamic_utm_crs = get_dynamic_utm_crs(center_lat, center_lon)
        logger.info(
            "Using dynamic CRS %s (EPSG: %s) for location %s",
            dynamic_utm_crs.name,
            dynamic_utm_crs.to_epsg(),
            location_name,
        )

        project_to_utm_dynamic = pyproj.Transformer.from_crs(
            WGS84, dynamic_utm_crs, always_xy=True
        ).transform
        project_to_wgs84_dynamic = pyproj.Transformer.from_crs(
            dynamic_utm_crs, WGS84, always_xy=True
        ).transform

        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "location": validated_location,
                    "status": "processing",
                    "last_updated": datetime.now(timezone.utc),
                    "last_error": None,
                },
                "$setOnInsert": {
                    "total_length": 0.0,
                    "driven_length": 0.0,
                    "coverage_percentage": 0.0,
                    "total_segments": 0,
                    "created_at": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )

        logger.info("Clearing existing street segments for %s...", location_name)
        try:
            delete_result = await delete_many_with_retry(
                streets_collection, {"properties.location": location_name}
            )
            logger.info(
                "Deleted %d existing segments for %s.",
                delete_result.deleted_count,
                location_name,
            )
        except Exception as del_err:
            logger.error(
                "Error clearing existing segments for %s: %s",
                location_name,
                del_err,
            )

        osm_data = None
        try:
            logger.info(
                "Fetching filtered OSM street data for %s using enhanced query...",
                location_name,
            )
            osm_data = await asyncio.wait_for(
                fetch_osm_data(validated_location, streets_only=True),
                timeout=300,
            )
        except asyncio.TimeoutError:
            logger.error("Timeout fetching OSM data for %s", location_name)
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Timeout fetching OSM data",
                    }
                },
            )
            return
        except Exception as fetch_err:
            logger.error(
                "Failed to fetch OSM data for %s: %s",
                location_name,
                fetch_err,
                exc_info=True,
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"OSM Fetch Error: {fetch_err}",
                    }
                },
            )
            return

        if not osm_data or not osm_data.get("elements"):
            logger.warning(
                "No OSM elements returned for %s after filtering. Preprocessing finished.",
                location_name,
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "completed",
                        "total_segments": 0,
                        "total_length": 0.0,
                        "last_error": None,
                    }
                },
            )
            return

        try:
            logger.info(
                "Processing and segmenting filtered OSM data for %s...",
                location_name,
            )
            await asyncio.wait_for(
                process_osm_data(
                    osm_data,
                    validated_location,
                    project_to_utm_dynamic,
                    project_to_wgs84_dynamic,
                ),
                timeout=1800,
            )
            logger.info(
                "Street preprocessing completed successfully for %s.",
                location_name,
            )

        except asyncio.TimeoutError:
            logger.error("Timeout processing OSM data for %s", location_name)
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Timeout processing street data",
                    }
                },
            )
            return
        except Exception as process_err:
            logger.error(
                "Preprocessing failed during data processing stage for %s: %s",
                location_name,
                process_err,
                exc_info=True,
            )
            return

    except Exception as e:
        location_name_safe = validated_location.get("display_name", "Unknown Location")
        logger.error(
            "Unhandled error during street preprocessing orchestration for %s: %s",
            location_name_safe,
            e,
            exc_info=True,
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name_safe},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"Unexpected preprocessing error: {str(e)}",
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

    finally:
        gc.collect()
        logger.debug(
            "Preprocessing task finished for %s, running GC.",
            validated_location.get("display_name", "Unknown Location"),
        )
