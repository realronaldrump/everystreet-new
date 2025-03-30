# preprocess_streets.py
"""Preprocess streets module.

Fetches OSM data from Overpass (excluding non-drivable ways), segments street
geometries in parallel using a dynamically determined UTM zone for accuracy,
and updates the database.
"""

import asyncio
import gc
import logging
import math
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, TimeoutError
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Callable

import aiohttp
import pyproj
from dotenv import load_dotenv
from shapely.geometry import LineString, mapping
from shapely.ops import transform
from pymongo.errors import BulkWriteError  # Import BulkWriteError

# Import necessary database functions and collections from your db module
# Use retry wrappers for DB operations
from db import (
    coverage_metadata_collection,
    streets_collection,
    update_one_with_retry,
    delete_many_with_retry,
    # insert_many is implicitly handled by streets_collection.insert_many
)


load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# --- Constants ---
OVERPASS_URL = "http://overpass-api.de/api/interpreter"
WGS84 = pyproj.CRS("EPSG:4326")
# DEFAULT_UTM is removed - it will be determined dynamically per location.
# Transformers are now created dynamically within preprocess_streets.

# Define highway types to exclude from street data (foot traffic, paths, etc.)
# This regex is used in Overpass queries. Ensure it matches osm_utils.py
EXCLUDED_HIGHWAY_TYPES_REGEX = (
    "footway|path|steps|pedestrian|bridleway|cycleway|corridor|"
    "platform|raceway|proposed|construction|track"
)

SEGMENT_LENGTH_METERS = 100  # Street segment length
# Increased BATCH_SIZE for potentially better insert performance
BATCH_SIZE = 1000
PROCESS_TIMEOUT = 30000  # Timeout for a batch of parallel processing
# Adjusted MAX_WORKERS for potentially better resource utilization
MAX_WORKERS = min(multiprocessing.cpu_count(), 8)
# ---

# --- Helper Function for Dynamic UTM ---


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
    fallback_crs_epsg = 32610  # UTM Zone 10N as a fallback

    try:
        # Handle Polar Regions (UPS - Universal Polar Stereographic)
        if latitude >= 84.0:
            return pyproj.CRS("EPSG:32661")  # North UPS
        if latitude <= -80.0:
            return pyproj.CRS("EPSG:32761")  # South UPS

        # Calculate UTM Zone
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


# --- Core Functions ---


async def fetch_osm_data(
    location: Dict[str, Any], streets_only: bool = True
) -> Dict[str, Any]:
    """Fetch OSM data from Overpass API for a given location.

    If streets_only is True, filters out non-vehicular ways using Overpass query.
    """
    area_id = int(location["osm_id"])
    if location["osm_type"] == "relation":
        area_id += 3600000000

    if streets_only:
        # Query for drivable streets, excluding non-vehicular highway types
        query = f"""
        [out:json][timeout:180];
        area({area_id})->.searchArea;
        (
          // Fetch ways with highway tag, EXCLUDING specified non-vehicular types
          way["highway"]["highway"!~"{EXCLUDED_HIGHWAY_TYPES_REGEX}"](area.searchArea);
        );
        (._;>;); // Recurse down to nodes
        out geom; // Output geometry
        """
        logger.info(
            "Using Overpass query that excludes non-vehicular ways for preprocessing."
        )
    else:
        # Query for boundary (no change needed here)
        query = f"""
        [out:json][timeout=60];
        ({location["osm_type"]}({location["osm_id"]});
        >;
        );
        out geom;
        """

    # Extended timeout and retries
    timeout = aiohttp.ClientTimeout(
        total=240
    )  # Increased timeout for potentially large queries
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
            # Try to read response body for more details if possible
            try:
                error_body = await http_err.response.text()
                logger.warning(
                    "Overpass error body: %s", error_body[:500]
                )  # Log first 500 chars
            except Exception:
                pass  # Ignore if reading body fails
            if (
                current_try >= retry_count or http_err.status == 400
            ):  # 400 usually means bad query, don't retry
                logger.error(
                    "Failed to fetch OSM data for %s after %d tries due to HTTP error.",
                    location["display_name"],
                    retry_count,
                )
                raise http_err  # Re-raise the last error
            await asyncio.sleep(2**current_try)  # Exponential backoff
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
                raise  # Re-raise the last error
            await asyncio.sleep(2**current_try)  # Exponential backoff


def substring(
    line: LineString, start: float, end: float
) -> Optional[LineString]:
    """Return a sub-linestring from 'start' to 'end' along the line (UTM
    coords)."""
    # Added type hints and None return possibility
    if (
        start < 0
        or end > line.length
        or start >= end
        or abs(line.length) < 1e-6
    ):
        return None  # Handle zero length lines

    coords = list(line.coords)
    if (
        start <= 1e-6 and end >= line.length - 1e-6
    ):  # Use tolerance for floating point
        return line

    segment_coords = []
    accumulated = 0.0

    # Find start point
    start_point = None
    for i in range(len(coords) - 1):
        p0, p1 = coords[i], coords[i + 1]
        seg = LineString([p0, p1])
        seg_length = seg.length
        if seg_length < 1e-6:
            continue  # Skip zero-length segments

        if accumulated <= start < accumulated + seg_length:
            fraction = (start - accumulated) / seg_length
            start_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
            break
        accumulated += seg_length
    else:  # If loop finishes without break (start distance >= total length)
        if abs(start - line.length) < 1e-6:
            start_point = coords[-1]  # Start is effectively the end point
        else:
            return None  # Should not happen if initial checks pass, but safety

    if start_point:
        segment_coords.append(start_point)

    # Find intermediate and end points
    accumulated = 0.0
    for i in range(len(coords) - 1):
        p0, p1 = coords[i], coords[i + 1]
        seg = LineString([p0, p1])
        seg_length = seg.length
        if seg_length < 1e-6:
            continue

        current_end_accum = accumulated + seg_length

        # If the segment starts after our desired start point
        if accumulated >= start:
            # Add the start point of this segment if not already added
            if not segment_coords or segment_coords[-1] != p0:
                # Check distance to prevent adding duplicate points due to float issues
                if (
                    segment_coords
                    and LineString([segment_coords[-1], p0]).length > 1e-6
                ):
                    segment_coords.append(p0)
                elif not segment_coords:
                    segment_coords.append(p0)

        # If the segment contains the end point
        if accumulated < end <= current_end_accum:
            fraction = (end - accumulated) / seg_length
            end_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
            # Add end point if different from last point added
            if (
                not segment_coords
                or LineString([segment_coords[-1], end_point]).length > 1e-6
            ):
                segment_coords.append(end_point)
            break  # Found the end point, exit loop

        # If the segment is fully within the desired range (after start, before end)
        elif start <= accumulated and current_end_accum <= end:
            # Add the end point of this segment
            if (
                not segment_coords
                or LineString([segment_coords[-1], p1]).length > 1e-6
            ):
                segment_coords.append(p1)

        accumulated += seg_length

    # Ensure at least two distinct points
    if len(segment_coords) >= 2:
        # Check if start and end points are effectively the same
        if (
            LineString([segment_coords[0], segment_coords[-1]]).length < 1e-6
            and len(segment_coords) == 2
        ):
            return None
        try:
            return LineString(segment_coords)
        except Exception:  # Catch potential shapely errors
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
    if total_length <= segment_length_meters + 1e-6:  # Add tolerance
        return [line]

    start_distance = 0.0
    while start_distance < total_length - 1e-6:  # Add tolerance
        end_distance = min(
            start_distance + segment_length_meters, total_length
        )
        seg = substring(line, start_distance, end_distance)
        if seg is not None and seg.length > 1e-6:  # Ensure segment has length
            segments.append(seg)
        # Ensure start_distance increments even if substring fails
        start_distance = end_distance

    # Handle potential empty list if substring fails repeatedly
    if not segments and total_length > 1e-6:
        logger.warning(
            "Segmentation resulted in no segments for line with length %s. Returning original line.",
            total_length,
        )
        return [line]  # Fallback to original line

    return segments


def process_element_parallel(
    element_data: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Process a single street element in parallel.

    Uses the provided projection functions and minimal element data.
    Returns a list of segmented feature dictionaries.
    """
    try:
        # Unpack data passed from main process
        osm_id = element_data["osm_id"]
        geometry_nodes = element_data[
            "geometry_nodes"
        ]  # List of {"lat": float, "lon": float}
        tags = element_data["tags"]
        location_name = element_data["location_name"]
        proj_to_utm: Callable = element_data["project_to_utm"]
        proj_to_wgs84: Callable = element_data["project_to_wgs84"]

        # Convert geometry nodes to coordinate tuples
        nodes = [(node["lon"], node["lat"]) for node in geometry_nodes]
        if len(nodes) < 2:
            return []

        highway_type = tags.get("highway", "unknown")

        line_wgs84 = LineString(nodes)
        # Use the passed-in transformer function
        projected_line = transform(proj_to_utm, line_wgs84)

        # Check for zero length after projection
        if projected_line.length < 1e-6:
            # logger.debug("Skipping way %s due to zero length after projection.", osm_id) # Reduce log noise
            return []

        segments = segment_street(
            projected_line, segment_length_meters=SEGMENT_LENGTH_METERS
        )

        features = []
        for i, segment_utm in enumerate(segments):
            if segment_utm.length < 1e-6:  # Skip zero-length segments
                continue
            # Use the passed-in transformer function
            segment_wgs84 = transform(proj_to_wgs84, segment_utm)
            # Ensure geometry is valid before adding
            if not segment_wgs84.is_valid or segment_wgs84.is_empty:
                logger.warning(
                    "Skipping invalid/empty segment %s-%d", osm_id, i
                )
                continue

            feature = {
                "type": "Feature",
                "geometry": mapping(
                    segment_wgs84
                ),  # Use shapely.geometry.mapping
                "properties": {
                    "osm_id": osm_id,  # Original OSM Way ID
                    "segment_id": f"{osm_id}-{i}",  # Unique segment ID
                    "street_name": tags.get("name", "Unnamed Street"),
                    "highway": highway_type,
                    "location": location_name,  # Store location name string
                    "segment_length": segment_utm.length,  # Length in meters (from UTM)
                    "driven": False,  # Initial state
                    "last_updated": None,  # Timestamp of last coverage check
                    "matched_trips": [],  # List of trip IDs matching this segment
                    "tags": tags,  # Store original OSM tags if needed
                },
            }
            features.append(feature)
        return features
    except Exception as e:
        osm_id_str = element_data.get("osm_id", "UNKNOWN_ID")
        logger.error(
            "Error processing element %s: %s", osm_id_str, e, exc_info=True
        )
        return []


async def process_osm_data(
    osm_data: Dict[str, Any],
    location: Dict[str, Any],
    project_to_utm_func: Callable,  # Accept the dynamic transformer
    project_to_wgs84_func: Callable,  # Accept the dynamic transformer
) -> None:
    """Convert OSM ways into segmented features and insert them into
    streets_collection.

    Uses the provided projection functions and parallel processing.
    Also update coverage metadata.
    """
    try:
        location_name = location[
            "display_name"
        ]  # Use display name consistently
        total_length = 0.0
        way_elements = [
            element
            for element in osm_data.get("elements", [])
            if element.get("type") == "way"
            and "geometry" in element  # Ensure geometry key exists
            and isinstance(
                element.get("geometry"), list
            )  # Ensure geometry is a list
            and len(element.get("geometry", []))
            >= 2  # Ensure at least 2 nodes
        ]

        if not way_elements:
            logger.warning(
                "No valid way elements found for %s after filtering.",
                location_name,
            )
            # Update metadata to reflect 0 streets if none found
            # Use retry wrapper for DB operation
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": 0.0,
                        "total_segments": 0,
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",  # Mark as completed if no streets
                        "last_error": None,
                    }
                },
                upsert=True,
            )
            return

        logger.info(
            "Processing %d street ways for %s",
            len(way_elements),
            location_name,
        )

        # Prepare data for parallel processing, passing only necessary fields
        process_data = [
            {
                # Pass only required fields to reduce IPC overhead
                "osm_id": element.get("id"),
                "geometry_nodes": element.get(
                    "geometry", []
                ),  # Pass the list of nodes
                "tags": element.get("tags", {}),
                "location_name": location_name,
                "project_to_utm": project_to_utm_func,
                "project_to_wgs84": project_to_wgs84_func,
            }
            for element in way_elements
            # Add extra check here to ensure required fields are present before adding to list
            if element.get("id") is not None
            and element.get("geometry") is not None
        ]

        processed_segments_count = 0
        total_segments_count = 0

        # Process elements in parallel using ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=MAX_WORKERS) as executor:
            loop = asyncio.get_event_loop()
            # Create tasks using run_in_executor
            tasks = [
                loop.run_in_executor(executor, process_element_parallel, data)
                for data in process_data
            ]

            # Use asyncio.as_completed for better memory management and progress tracking
            batch_to_insert = []
            for i, future in enumerate(asyncio.as_completed(tasks)):
                try:
                    # Add timeout for each individual task result retrieval
                    segment_features = await asyncio.wait_for(
                        future, timeout=PROCESS_TIMEOUT
                    )
                    if segment_features:
                        batch_to_insert.extend(segment_features)
                        total_segments_count += len(segment_features)
                        for feature in segment_features:
                            # Ensure segment_length exists and is numeric before adding
                            length = feature.get("properties", {}).get(
                                "segment_length"
                            )
                            if isinstance(length, (int, float)):
                                total_length += length
                            else:
                                logger.warning(
                                    f"Segment {feature.get('properties', {}).get('segment_id')} missing valid length."
                                )

                    # Insert in batches to avoid overwhelming DB / memory
                    if len(batch_to_insert) >= BATCH_SIZE:
                        try:
                            # Use the collection directly for insert_many
                            await streets_collection.insert_many(
                                batch_to_insert, ordered=False
                            )
                            processed_segments_count += len(batch_to_insert)
                            logger.info(
                                "Inserted batch of %d segments (%d/%d total processed for %s)",
                                len(batch_to_insert),
                                processed_segments_count,
                                total_segments_count,  # Use total_segments_count for total estimate
                                location_name,
                            )
                            batch_to_insert = []  # Clear batch
                            gc.collect()  # Optional: Explicit GC after large insert
                            await asyncio.sleep(0.05)  # Yield control briefly
                        except BulkWriteError as bwe:
                            logger.error(
                                f"Error inserting batch (BulkWriteError): {bwe.details}"
                            )
                            # Decide how to handle insert errors (e.g., skip batch, retry individual?)
                            # For now, log and continue, potentially losing some segments in this batch
                            batch_to_insert = []  # Clear batch
                        except Exception as insert_err:
                            logger.error(
                                "Error inserting batch: %s",
                                insert_err,
                                exc_info=True,
                            )
                            # Log and continue
                            batch_to_insert = []

                except TimeoutError:
                    logger.warning(
                        "Processing element task timed out after %ds.",
                        PROCESS_TIMEOUT,
                    )
                    # Potentially mark the associated element as failed?
                except Exception as e:
                    logger.error(
                        "Error processing element future: %s", e, exc_info=True
                    )

                # Log progress periodically based on futures completed
                if (i + 1) % (
                    max(1, len(tasks) // 20)
                ) == 0:  # Log roughly 20 times
                    logger.info(
                        "Processed %d/%d way futures for %s...",
                        i + 1,
                        len(tasks),
                        location_name,
                    )

            # Insert any remaining segments
            if batch_to_insert:
                try:
                    await streets_collection.insert_many(
                        batch_to_insert, ordered=False
                    )
                    processed_segments_count += len(batch_to_insert)
                    logger.info(
                        "Inserted final batch of %d segments (%d/%d total processed for %s)",
                        len(batch_to_insert),
                        processed_segments_count,
                        total_segments_count,
                        location_name,
                    )
                except BulkWriteError as bwe:
                    logger.error(
                        f"Error inserting final batch (BulkWriteError): {bwe.details}"
                    )
                except Exception as insert_err:
                    logger.error(
                        "Error inserting final batch: %s",
                        insert_err,
                        exc_info=True,
                    )

        # Final update to coverage metadata
        if total_segments_count > 0:
            # Use retry wrapper for DB operation
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": total_length,  # Now uses more accurate lengths
                        "total_segments": total_segments_count,
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",  # Mark as completed after processing
                        "last_error": None,  # Clear previous errors
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
            # This case should be handled earlier if way_elements is empty, but double-check
            logger.warning(
                "No valid street segments were generated for %s", location_name
            )
            # Use retry wrapper for DB operation
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
                        "last_error": "No segments generated",
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
        # Update metadata with error status using retry wrapper
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
        raise  # Re-raise the exception to be caught by the caller


async def preprocess_streets(validated_location: Dict[str, Any]) -> None:
    """
    Preprocess street data for a validated location:
    Fetch filtered OSM data, determine appropriate UTM zone, segment streets,
    and update the database.
    """
    location_name = validated_location["display_name"]
    try:
        logger.info("Starting street preprocessing for %s", location_name)

        # --- Dynamic UTM Calculation ---
        center_lat = None
        center_lon = None
        try:
            # Attempt to get lat/lon from the validated location data
            center_lat = float(validated_location.get("lat"))
            center_lon = float(validated_location.get("lon"))
        except (TypeError, ValueError, AttributeError):  # Added AttributeError
            logger.warning(
                "Location %s is missing valid lat/lon. Cannot determine dynamic UTM.",
                location_name,
            )
            # Decide how to handle: raise error, use fallback, or skip?
            # For now, let's raise an error to make the requirement explicit.
            # Use retry wrapper for DB operation
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
            raise ValueError(
                f"Location {location_name} lacks lat/lon for dynamic UTM."
            )

        dynamic_utm_crs = get_dynamic_utm_crs(center_lat, center_lon)
        logger.info(
            "Using dynamic CRS %s (EPSG: %s) for location %s",
            dynamic_utm_crs.name,
            dynamic_utm_crs.to_epsg(),  # Safely get EPSG if available
            location_name,
        )

        # Create transformers dynamically for this location
        project_to_utm_dynamic = pyproj.Transformer.from_crs(
            WGS84, dynamic_utm_crs, always_xy=True
        ).transform
        project_to_wgs84_dynamic = pyproj.Transformer.from_crs(
            dynamic_utm_crs, WGS84, always_xy=True
        ).transform
        # --- End Dynamic UTM Calculation ---

        # Ensure location exists in metadata and set status to processing
        # Use retry wrapper for DB operation
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "location": validated_location,  # Ensure full location data is stored
                    "status": "processing",
                    "last_updated": datetime.now(timezone.utc),
                    "last_error": None,  # Clear previous errors
                },
                "$setOnInsert": {  # Set initial values only if inserting new document
                    "total_length": 0.0,
                    "driven_length": 0.0,
                    "coverage_percentage": 0.0,
                    "total_segments": 0,
                    "created_at": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )

        # --- Step 1: Clear existing street segments for this location ---
        logger.info(
            "Clearing existing street segments for %s...", location_name
        )
        try:
            # Use retry wrapper for DB operation
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
            # Optionally, decide if this is a fatal error or if processing can continue
            # For now, log and continue, but new data might conflict if deletion failed badly.

        # --- Step 2: Fetch OSM data (filtered) ---
        osm_data = None
        try:
            logger.info(
                "Fetching filtered OSM street data for %s...", location_name
            )
            osm_data = await asyncio.wait_for(
                fetch_osm_data(validated_location, streets_only=True),
                timeout=300,  # 5 minute timeout for fetching data
            )
        except asyncio.TimeoutError:
            logger.error("Timeout fetching OSM data for %s", location_name)
            # Use retry wrapper for DB operation
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
            return  # Stop processing
        except Exception as fetch_err:
            logger.error(
                "Failed to fetch OSM data for %s: %s",
                location_name,
                fetch_err,
                exc_info=True,
            )
            # Use retry wrapper for DB operation
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
            return  # Stop processing

        if not osm_data or not osm_data.get("elements"):
            logger.warning(
                "No OSM elements returned for %s. Preprocessing finished.",
                location_name,
            )
            # Use retry wrapper for DB operation
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "completed",
                        "total_segments": 0,
                        "total_length": 0.0,
                        "last_error": None,  # Clear error if fetch was ok but no elements
                    }
                },  # Mark as complete with 0 streets
            )
            return  # Nothing to process

        # --- Step 3: Process OSM data (segmentation, DB insertion) ---
        try:
            logger.info(
                "Processing and segmenting OSM data for %s...", location_name
            )
            # Pass the dynamically created transformers to process_osm_data
            await asyncio.wait_for(
                process_osm_data(
                    osm_data,
                    validated_location,
                    project_to_utm_dynamic,  # Pass dynamic transformer
                    project_to_wgs84_dynamic,  # Pass dynamic transformer
                ),
                timeout=1800,  # 30 minute timeout for processing/inserting
            )
            # process_osm_data now handles setting the final "completed" status on success
            logger.info(
                "Street preprocessing completed successfully for %s.",
                location_name,
            )

        except asyncio.TimeoutError:
            logger.error("Timeout processing OSM data for %s", location_name)
            # Use retry wrapper for DB operation
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
            return  # Stop processing
        except Exception as process_err:
            # Error should have been logged and status set within process_osm_data
            logger.error(
                "Preprocessing failed during data processing stage for %s: %s",
                location_name,
                process_err,
                exc_info=True,
            )
            # No need to set status again here, process_osm_data should handle it
            return  # Stop processing

    except Exception as e:
        # Catch-all for unexpected errors during the setup/coordination phase
        # Includes the ValueError raised if lat/lon are missing
        location_name_safe = validated_location.get(
            "display_name", "Unknown Location"
        )
        logger.error(
            "Unhandled error during street preprocessing orchestration for %s: %s",
            location_name_safe,
            e,
            exc_info=True,
        )
        # Use retry wrapper for DB operation
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
            # Upsert might be needed if the initial update failed
            upsert=True,
        )
        # Don't raise here, let the task runner handle completion/failure based on logs/status

    finally:
        # Force garbage collection
        gc.collect()
        logger.debug(
            "Preprocessing task finished for %s, running GC.",
            validated_location.get("display_name", "Unknown Location"),
        )
