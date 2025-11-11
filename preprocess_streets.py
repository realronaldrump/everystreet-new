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
import os
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from datetime import datetime, timezone
from typing import Any

import aiohttp
import pyproj
from dotenv import load_dotenv
from pymongo.errors import BulkWriteError
from shapely.geometry import LineString, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import substring as shapely_substring
from shapely.ops import transform

from db import (
    coverage_metadata_collection,
    db_manager,
    delete_many_with_retry,
    find_one_with_retry,
    find_with_retry,
    progress_collection,
    streets_collection,
    update_many_with_retry,
    update_one_with_retry,
)

# Import the centralized query builder
from osm_utils import build_standard_osm_streets_query

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Primary endpoint (kept for backward compatibility) and multi-endpoint fallback support
OVERPASS_URL = "http://overpass-api.de/api/interpreter"
OVERPASS_URLS_ENV = os.getenv(
    "OVERPASS_URLS",
    ",".join(
        [
            OVERPASS_URL,
            "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.osm.ch/api/interpreter",
            "https://overpass.nchc.org.tw/api/interpreter",
        ]
    ),
)

# Optional cache TTL (hours) for OSM data; 0 disables TTL (use cache if present)
OSM_CACHE_TTL_HOURS = float(os.getenv("OSM_CACHE_TTL_HOURS", "24"))

osm_data_collection = db_manager.db["osm_data"]
WGS84 = pyproj.CRS("EPSG:4326")

SEGMENT_LENGTH_METERS = 100  # Default – can be overridden per-run
BATCH_SIZE = 1000
PROCESS_TIMEOUT = 30000  # Timeout for individual parallel processing tasks
MAX_WORKERS = min(multiprocessing.cpu_count(), 8)


async def _update_task_progress(
    task_id: str | None,
    stage: str,
    progress: int,
    message: str,
    error: str | None = None,
) -> None:
    """Helper function to update task progress in MongoDB."""
    if not task_id:
        return
    try:
        update_doc = {
            "$set": {
                "stage": stage,
                "progress": progress,
                "message": message,
                "updated_at": datetime.now(timezone.utc),
            },
        }
        if error:
            update_doc["$set"]["error"] = error
            update_doc["$set"]["status"] = "error"
        else:
            # Ensure status is processing if not an error
            update_doc["$set"]["status"] = "processing"

        await update_one_with_retry(
            progress_collection,
            {"_id": task_id},
            update_doc,
            upsert=False,  # Assume progress doc is created by caller task
        )
    except Exception as e:
        logger.error(
            "Task %s: Failed to update progress to stage %s: %s", task_id, stage, e
        )


def _get_query_target_clause_for_bbox(location: dict[str, Any]) -> str:
    """Builds the Overpass QL query target clause for a bounding box."""
    bbox = location.get("boundingbox")
    if not bbox or len(bbox) != 4:
        raise ValueError(f"Invalid bounding box in location: {location}")

    # OSM uses (south, west, north, east)
    # FastAPI/Nominatim typically gives (min_lat, max_lat, min_lon, max_lon)
    # Ensure correct order for Overpass: south,west,north,east
    # bbox[0] = min_lat (south)
    # bbox[1] = max_lat (north)
    # bbox[2] = min_lon (west)
    # bbox[3] = max_lon (east)
    bbox_str = f"{bbox[0]},{bbox[2]},{bbox[1]},{bbox[3]}"
    return f"({bbox_str})"  # For direct bbox filtering in Overpass


def get_dynamic_utm_crs(latitude: float, longitude: float) -> pyproj.CRS:
    """Determines the appropriate UTM or UPS CRS for a given latitude and longitude.

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
            return pyproj.CRS("EPSG:32661")  # UPS North
        if latitude <= -80.0:
            return pyproj.CRS("EPSG:32761")  # UPS South

        zone_number = math.floor((longitude + 180) / 6) + 1
        is_northern = latitude >= 0

        if is_northern:
            epsg_code = 32600 + zone_number
        else:
            epsg_code = 32700 + zone_number

        return pyproj.CRS(f"EPSG:{epsg_code}")

    except Exception as e:
        logger.warning(
            "Failed to determine dynamic UTM/UPS CRS for lat=%s, lon=%s: %s. "
            "Falling back to EPSG:%d.",
            latitude,
            longitude,
            e,
            fallback_crs_epsg,
        )
        return pyproj.CRS(f"EPSG:{fallback_crs_epsg}")


async def fetch_osm_data(
    query: str,
    timeout: int = 300,
    base_url: str | None = None,
) -> dict[str, Any]:  # Increased default timeout
    """Fetch OSM data via Overpass API, with proper cleanup and error propagation."""
    # The timeout here is for the HTTP request itself.
    # The Overpass query itself has its own [timeout:...] directive.
    target_url = base_url or OVERPASS_URL
    async with aiohttp.ClientSession() as session:
        try:
            logger.debug("Fetching OSM data with query: %s", query)
            async with session.post(
                target_url,
                data=query,
                timeout=timeout,  # HTTP client timeout
            ) as resp:
                resp.raise_for_status()
                return await resp.json()
        except TimeoutError as e:  # Catch asyncio.TimeoutError specifically
            logger.error(
                "Timeout fetching OSM data (HTTP request timeout %ds): %s",
                timeout,
                e,
            )
            raise
        except aiohttp.ClientResponseError as e:
            # More detailed logging for client response errors
            error_text = await e.text() if hasattr(e, "text") else str(e.message)
            logger.error(
                "HTTP error %s fetching OSM data: %s. Response: %s",
                e.status,
                e.message,
                error_text[:500],
            )
            raise
        except aiohttp.ClientError as e:
            logger.error(
                "Client error fetching OSM data: %s",
                e,
            )
            raise


async def _fetch_osm_with_fallback(
    query: str,
    task_id: str | None,
    location_name: str,
    per_attempt_http_timeout: int = 60,
    per_attempt_overall_timeout: int = 75,
) -> tuple[dict[str, Any], str]:
    """Try multiple Overpass endpoints with per-attempt timeouts and progress
    heartbeats.

    Returns (osm_data, endpoint_url) on success. Raises on total failure.
    """
    endpoints = [u.strip() for u in OVERPASS_URLS_ENV.split(",") if u.strip()]
    total_endpoints = len(endpoints)
    for idx, endpoint in enumerate(endpoints, start=1):
        # Announce attempt
        await _update_task_progress(
            task_id,
            "preprocessing",
            20,
            f"Contacting Overpass {idx}/{total_endpoints} at {endpoint} "
            f"for {location_name}",
        )

        # Start the fetch task
        fetch_task = asyncio.create_task(
            fetch_osm_data(
                query=query,
                timeout=per_attempt_http_timeout,
                base_url=endpoint,
            )
        )

        attempt_start = asyncio.get_event_loop().time()
        last_heartbeat = attempt_start
        try:
            while True:
                try:
                    # Poll completion in small intervals to emit heartbeats
                    result = await asyncio.wait_for(fetch_task, timeout=300)
                    # Success
                    await _update_task_progress(
                        task_id,
                        "preprocessing",
                        35,
                        f"Received OSM data from {endpoint} for {location_name}",
                    )
                    return result, endpoint
                except TimeoutError:
                    now = asyncio.get_event_loop().time()
                    elapsed = int(now - attempt_start)
                    # Heartbeat every ~10s
                    if now - last_heartbeat >= 10:
                        last_heartbeat = now
                        await _update_task_progress(
                            task_id,
                            "preprocessing",
                            20,
                            f"Waiting on Overpass {idx}/{total_endpoints} "
                            f"({elapsed}s) at {endpoint} for {location_name}",
                        )
                    # Enforce per-attempt overall timeout
                    if elapsed >= per_attempt_overall_timeout:
                        logger.warning(
                            "Overpass attempt %d/%d timed out after %ds at %s for %s",
                            idx,
                            total_endpoints,
                            per_attempt_overall_timeout,
                            endpoint,
                            location_name,
                        )
                        fetch_task.cancel()
                        try:
                            await fetch_task
                        except Exception:
                            pass
                        break  # move to next endpoint
        except Exception as e:
            logger.error(
                "Overpass attempt %d/%d failed at %s for %s: %s",
                idx,
                total_endpoints,
                endpoint,
                location_name,
                e,
                exc_info=True,
            )
            # Try next endpoint
            continue

    # All endpoints failed or timed out
    await _update_task_progress(
        task_id,
        "error",
        20,
        f"All Overpass endpoints failed or timed out for {location_name}",
        error="Overpass fetch failed",
    )
    raise TimeoutError("All Overpass endpoints failed or timed out")


# Custom substring function replaced with shapely.ops.substring
# The shapely library provides a battle-tested, optimized implementation


def segment_street(
    line: LineString,
    segment_length_meters: float = SEGMENT_LENGTH_METERS,
) -> list[LineString]:
    """Split a linestring (in UTM) into segments of approximately
    segment_length_meters using shapely.ops.substring.
    """
    segments = []
    total_length = line.length
    if total_length <= segment_length_meters + 1e-6:  # Add a small tolerance
        return [line]

    start_distance = 0.0
    while start_distance < total_length - 1e-6:  # Add a small tolerance
        end_distance = min(
            start_distance + segment_length_meters,
            total_length,
        )
        try:
            # Use shapely's built-in, optimized substring function
            seg = shapely_substring(
                line, start_distance, end_distance, normalized=False
            )
            if seg is not None and seg.length > 1e-6:  # Ensure segment has some length
                segments.append(seg)
        except Exception as e:
            logger.warning(
                "Failed to create segment from %.2f to %.2f: %s",
                start_distance,
                end_distance,
                e,
            )
        start_distance = end_distance

    if not segments and total_length > 1e-6:
        logger.warning(
            "Segmentation resulted in no segments for line with length %s. "
            "Returning original line.",
            total_length,
        )
        return [line]

    return segments


def process_element_parallel(
    element_data: dict[str, Any],
) -> list[dict[str, Any]]:
    """Process a single street element in parallel.

    Uses the provided projection functions and minimal element data.
    Returns a list of segmented feature dictionaries, clipped to the boundary.
    """
    try:
        osm_id = element_data["osm_id"]
        geometry_nodes = element_data["geometry_nodes"]
        tags = element_data["tags"]
        location_name = element_data["location_name"]
        proj_to_utm: Callable = element_data["project_to_utm"]
        proj_to_wgs84: Callable = element_data["project_to_wgs84"]
        boundary_polygon: BaseGeometry | None = element_data.get("boundary_polygon")
        segment_length_meters: float = element_data.get(
            "segment_length_meters",
            SEGMENT_LENGTH_METERS,
        )
        nodes = [(node["lon"], node["lat"]) for node in geometry_nodes]
        if len(nodes) < 2:
            return []

        highway_type = tags.get("highway", "unknown")

        line_wgs84 = LineString(nodes)
        projected_line = transform(proj_to_utm, line_wgs84)

        if projected_line.length < 1e-6:  # Filter out zero-length lines in UTM
            return []

        segments = segment_street(
            projected_line,
            segment_length_meters=segment_length_meters,
        )

        features = []
        for i, segment_utm in enumerate(segments):
            if segment_utm.length < 1e-6:  # Filter out zero-length segments
                continue
            segment_wgs84 = transform(proj_to_wgs84, segment_utm)
            if not segment_wgs84.is_valid or segment_wgs84.is_empty:
                logger.warning(
                    "Skipping invalid/empty segment %s-%d before clipping",
                    osm_id,
                    i,
                )
                continue

            # Clip the WGS84 segment to the boundary polygon
            if boundary_polygon:
                if not segment_wgs84.intersects(boundary_polygon):
                    continue  # Segment is entirely outside the boundary

                clipped_segment_wgs84 = segment_wgs84.intersection(boundary_polygon)

                if (
                    not clipped_segment_wgs84.is_valid
                    or clipped_segment_wgs84.is_empty
                    or not hasattr(clipped_segment_wgs84, "geom_type")
                    or clipped_segment_wgs84.geom_type
                    not in ("LineString", "MultiLineString")
                ):
                    # Skip if clipping results in non-LineString or empty geometry
                    continue

                # If clipping results in a MultiLineString, we might want to
                # process each part. For simplicity here, we'll take the largest
                # LineString if it's a MultiLineString or just use it if it's a
                # LineString. A more robust solution might involve creating
                # multiple features from a MultiLineString.
                if clipped_segment_wgs84.geom_type == "MultiLineString":
                    # Pick the longest linestring from the multilinestring
                    largest_line = None
                    max_length = 0
                    for line in clipped_segment_wgs84.geoms:
                        if line.length > max_length:
                            max_length = line.length
                            largest_line = line
                    if (
                        largest_line and largest_line.length > 1e-6
                    ):  # Ensure it has some length
                        segment_wgs84_to_use = largest_line
                    else:
                        continue  # No suitable line found
                else:  # It's a LineString
                    segment_wgs84_to_use = clipped_segment_wgs84

                # Check length again after potential selection from MultiLineString
                if segment_wgs84_to_use.length < 1e-6:
                    continue

                # Recalculate UTM geometry and length for the (potentially)
                # clipped segment. This is important if segment_length property
                # is used downstream for calculations in UTM. For now, we store
                # WGS84 geometry and original UTM segment length. A more
                # accurate approach would be to re-project the clipped WGS84 back
                # to UTM and use its length, but that adds another
                # transformation. Let's keep the original segment_utm.length for
                # now, but acknowledge this. The geometry stored will be the
                # clipped WGS84.

            else:  # No boundary polygon provided, use original segment
                segment_wgs84_to_use = segment_wgs84

            feature = {
                "type": "Feature",
                "geometry": mapping(
                    segment_wgs84_to_use
                ),  # Use the (potentially) clipped WGS84 segment
                "properties": {
                    "osm_id": osm_id,
                    "segment_id": f"{osm_id}-{i}",
                    "street_name": tags.get("name", "Unnamed Street"),
                    "highway": highway_type,
                    "location": location_name,
                    "segment_length": segment_utm.length,  # Length in meters (from UTM)
                    "driven": False,
                    # Default, can be overridden by coverage calculation
                    "undriveable": False,
                    "manual_override": False,
                    "manually_marked_driven": False,
                    "manually_marked_undriven": False,
                    "manually_marked_undriveable": False,
                    "manually_marked_driveable": False,
                    "last_coverage_update": None,
                    "last_manual_update": None,
                    "matched_trips": [],
                    "tags": tags,  # Store original tags for reference
                    "segment_length_meters": segment_length_meters,
                },
            }
            features.append(feature)
        return features
    except Exception as e:
        osm_id_str = element_data.get("osm_id", "UNKNOWN_ID")
        logger.error(
            "Error processing element %s: %s",
            osm_id_str,
            e,
            exc_info=True,
        )
        return []


async def process_osm_data(
    osm_data: dict[str, Any],
    location: dict[str, Any],
    project_to_utm_func: Callable,
    project_to_wgs84_func: Callable,
    boundary_polygon: BaseGeometry | None,
    segment_length_meters: float,
    task_id: str | None = None,
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
            and len(element.get("geometry", []))
            >= 2  # Ensure at least two nodes for a line
        ]

        if not way_elements:
            logger.warning(
                "No valid way elements found for %s after filtering.",
                location_name,
            )
            await _update_task_progress(
                task_id,
                "preprocessing",
                75,
                f"No street ways found in OSM data for {location_name}. "
                "(Detail: No ways after OSM filter)",
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
                        "status": "completed",  # Mark as completed even if no streets
                        "last_error": None,  # No error, just no streets
                    },
                },
                upsert=True,
            )
            return

        logger.info(
            "Processing %d potentially drivable street ways for %s",
            len(way_elements),
            location_name,
        )
        await _update_task_progress(
            task_id,
            "preprocessing",
            50,
            f"Processing {len(way_elements)} street ways for {location_name}. "
            "(Detail: Starting parallel segmentation)",
        )

        process_data = [
            {
                "osm_id": element.get("id"),
                "geometry_nodes": element.get("geometry", []),
                "tags": element.get("tags", {}),
                "location_name": location_name,
                "project_to_utm": project_to_utm_func,
                "project_to_wgs84": project_to_wgs84_func,
                "boundary_polygon": boundary_polygon,
                "segment_length_meters": segment_length_meters,
            }
            for element in way_elements
            if element.get("id") is not None  # Ensure ID exists
            and element.get("geometry") is not None  # Ensure geometry exists
        ]

        processed_segments_count = 0
        total_segments_count = 0

        # Check if we're in a daemonic process (e.g., Celery worker)
        # Daemonic processes cannot spawn child processes
        is_daemon = multiprocessing.current_process().daemon
        if is_daemon:
            logger.warning(
                "Running in daemonic process (likely Celery worker). "
                "Using sequential processing instead of ProcessPoolExecutor to avoid "
                "'daemonic processes are not allowed to have children' error."
            )
            # Set max_workers to 0 to force sequential processing
            effective_max_workers = 0
        else:
            effective_max_workers = MAX_WORKERS

        # Use ProcessPoolExecutor for CPU-bound tasks (segmentation, projection)
        # if not daemonic
        if effective_max_workers > 0:
            executor = ProcessPoolExecutor(max_workers=effective_max_workers)
        else:
            executor = None

        try:
            loop = asyncio.get_event_loop()
            tasks = [
                loop.run_in_executor(
                    executor,
                    process_element_parallel,
                    data,
                )
                for data in process_data
            ]

            batch_to_insert = []
            for i, future in enumerate(asyncio.as_completed(tasks)):
                try:
                    segment_features = await asyncio.wait_for(
                        future,
                        timeout=PROCESS_TIMEOUT,  # Timeout for each parallel task
                    )
                    if segment_features:
                        batch_to_insert.extend(segment_features)
                        total_segments_count += len(segment_features)
                        for feature in segment_features:
                            length = feature.get("properties", {}).get(
                                "segment_length",
                            )
                            if isinstance(
                                length,
                                (int, float),
                            ):
                                total_length += length
                            else:
                                logger.warning(
                                    "Segment %s missing valid length.",
                                    feature.get("properties", {}).get("segment_id"),
                                )

                    if len(batch_to_insert) >= BATCH_SIZE:
                        try:
                            await streets_collection.insert_many(
                                batch_to_insert,
                                # Allows some to fail without stopping others
                                ordered=False,
                            )
                            processed_segments_count += len(batch_to_insert)
                            logger.info(
                                "Inserted batch of %d segments "
                                "(%d/%d total processed for %s)",
                                len(batch_to_insert),
                                processed_segments_count,
                                total_segments_count,
                                location_name,
                            )
                            # Update progress based on segments inserted
                            current_progress = 50 + int(
                                (
                                    processed_segments_count
                                    / max(1, total_segments_count)
                                )
                                * 40
                            )
                            await _update_task_progress(
                                task_id,
                                "preprocessing",
                                current_progress,
                                f"Inserted {processed_segments_count}/"
                                f"{total_segments_count} segments for "
                                f"{location_name}. (Detail: Batch insert)",
                            )
                            batch_to_insert = []
                            # Explicit garbage collection after large batch
                            gc.collect()
                            await asyncio.sleep(0.05)  # Small sleep to yield control
                        except BulkWriteError as bwe:
                            # Handle duplicate key errors gracefully if
                            # segment_id is unique
                            write_errors = bwe.details.get(
                                "writeErrors",
                                [],
                            )
                            # Duplicate key error code
                            dup_keys = [
                                e for e in write_errors if e.get("code") == 11000
                            ]
                            if dup_keys:
                                logger.warning(
                                    "Skipped %d duplicate segments during batch "
                                    "insert for %s.",
                                    len(dup_keys),
                                    location_name,
                                )
                            other_errors = [
                                e for e in write_errors if e.get("code") != 11000
                            ]
                            if other_errors:
                                logger.error(
                                    "Non-duplicate BulkWriteError inserting "
                                    "batch for %s: %s",
                                    location_name,
                                    other_errors,
                                )
                            # Even with errors, clear batch_to_insert to avoid
                            # re-inserting failed ones
                            batch_to_insert = []
                        except Exception as insert_err:
                            logger.error(
                                "Error inserting batch: %s",
                                insert_err,
                                exc_info=True,
                            )
                            batch_to_insert = []  # Clear batch on other errors too

                except (
                    FutureTimeoutError
                ):  # Catch the renamed TimeoutError from concurrent.futures
                    logger.warning(
                        "Processing element task timed out after %ds.",
                        PROCESS_TIMEOUT,
                    )
                except Exception as e:
                    logger.error(
                        "Error processing element future: %s",
                        e,
                        exc_info=True,
                    )

                # Progress logging
                if (i + 1) % (
                    max(1, len(tasks) // 20)
                ) == 0:  # Log progress roughly every 5%
                    logger.info(
                        "Processed %d/%d way futures for %s...",
                        i + 1,
                        len(tasks),
                        location_name,
                    )
                    # Update progress based on futures processed (rougher estimate)
                    # This gives a sense of progress if inserts are infrequent
                    futures_progress = 50 + int(((i + 1) / len(tasks)) * 25)
                    await _update_task_progress(
                        task_id,
                        "preprocessing",
                        futures_progress,
                        f"Processed {i + 1}/{len(tasks)} OSM ways for "
                        f"{location_name}. (Detail: Way future processed)",
                    )

            # Insert any remaining segments
            if batch_to_insert:
                try:
                    await streets_collection.insert_many(
                        batch_to_insert,
                        ordered=False,
                    )
                    processed_segments_count += len(batch_to_insert)
                    logger.info(
                        "Inserted final batch of %d segments "
                        "(%d/%d total processed for %s)",
                        len(batch_to_insert),
                        processed_segments_count,
                        total_segments_count,
                        location_name,
                    )
                    await _update_task_progress(
                        task_id,
                        "preprocessing",
                        90,
                        f"Inserted final {len(batch_to_insert)} segments for "
                        f"{location_name}",
                    )
                except BulkWriteError as bwe:
                    write_errors = bwe.details.get("writeErrors", [])
                    dup_keys = [e for e in write_errors if e.get("code") == 11000]
                    if dup_keys:
                        logger.warning(
                            "Skipped %d duplicate segments during final batch "
                            "insert for %s.",
                            len(dup_keys),
                            location_name,
                        )
                    other_errors = [e for e in write_errors if e.get("code") != 11000]
                    if other_errors:
                        logger.error(
                            "Non-duplicate BulkWriteError inserting final "
                            "batch for %s: %s",
                            location_name,
                            other_errors,
                        )
                except Exception as insert_err:
                    logger.error(
                        "Error inserting final batch: %s",
                        insert_err,
                        exc_info=True,
                    )
        finally:
            # Cleanup executor if it was created
            if executor is not None:
                executor.shutdown(wait=True)

        # Update coverage metadata
        if total_segments_count > 0:
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": total_length,  # Store total length in meters
                        "total_segments": total_segments_count,
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",
                        "last_error": None,
                    },
                },
                upsert=True,
            )
            logger.info(
                "Successfully processed %d street segments "
                "(total length %.2f m) for %s",
                total_segments_count,
                total_length,
                location_name,
            )
            await _update_task_progress(
                task_id,
                "preprocessing",
                95,
                f"Street data processing complete for {location_name}. "
                f"{total_segments_count} segments generated. "
                "(Detail: process_osm_data finished)",
            )
        else:
            logger.warning(
                "No valid street segments were generated for %s after "
                "filtering and processing.",
                location_name,
            )
            await _update_task_progress(
                task_id,
                "preprocessing",
                95,
                f"No street segments generated for {location_name} after "
                "filtering. (Detail: Empty result from process_osm_data)",
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
                    },
                },
                upsert=True,
            )

        # ------------------------------------------------------------------
        # Preserve manual overrides before we wipe & re-create segments
        # ------------------------------------------------------------------
        override_docs = await find_with_retry(
            streets_collection,
            {
                "properties.location": location_name,
                "$or": [
                    {"properties.manual_override": True},
                    {"properties.manually_marked_driven": True},
                    {"properties.manually_marked_undriven": True},
                    {"properties.manually_marked_undriveable": True},
                    {"properties.manually_marked_driveable": True},
                    {"properties.undriveable": True},
                ],
            },
            {
                "geometry": 1,
                "properties.manual_override": 1,
                "properties.manually_marked_driven": 1,
                "properties.manually_marked_undriven": 1,
                "properties.manually_marked_undriveable": 1,
                "properties.manually_marked_driveable": 1,
                "properties.undriveable": 1,
            },
        )

        # Prepare simplified override documents list
        simplified_overrides: list[dict[str, Any]] = []
        for doc in override_docs:
            props = doc.get("properties", {})
            flags = {
                "manual_override": props.get("manual_override", False),
                "manually_marked_driven": props.get("manually_marked_driven", False),
                "manually_marked_undriven": props.get(
                    "manually_marked_undriven", False
                ),
                "manually_marked_undriveable": props.get(
                    "manually_marked_undriveable", False
                ),
                "manually_marked_driveable": props.get(
                    "manually_marked_driveable", False
                ),
                "undriveable": props.get("undriveable", False),
            }
            simplified_overrides.append(
                {"geometry": doc.get("geometry"), "flags": flags}
            )

        if simplified_overrides:
            try:
                for ov in simplified_overrides:
                    geomspec = ov.get("geometry")
                    if not geomspec:
                        continue
                    set_updates = {}
                    flags = ov.get("flags", {})
                    if flags.get("undriveable"):
                        set_updates.update({"properties.undriveable": True})
                    if flags.get("manual_override"):
                        set_updates.update({"properties.manual_override": True})
                    if flags.get("manually_marked_driven"):
                        set_updates.update(
                            {
                                "properties.manually_marked_driven": True,
                                "properties.driven": True,
                                "properties.manual_override": True,
                            }
                        )
                    if flags.get("manually_marked_undriven"):
                        set_updates.update(
                            {
                                "properties.manually_marked_undriven": True,
                                "properties.driven": False,
                                "properties.manual_override": True,
                            }
                        )
                    if flags.get("manually_marked_undriveable"):
                        set_updates.update(
                            {
                                "properties.manually_marked_undriveable": True,
                                "properties.undriveable": True,
                                "properties.manual_override": True,
                            }
                        )
                    if flags.get("manually_marked_driveable"):
                        set_updates.update(
                            {
                                "properties.manually_marked_driveable": True,
                                "properties.undriveable": False,
                                "properties.manual_override": True,
                            }
                        )

                    if set_updates:
                        await update_many_with_retry(
                            streets_collection,
                            {
                                "properties.location": location_name,
                                "geometry": {"$geoIntersects": {"$geometry": geomspec}},
                            },
                            {"$set": set_updates},
                        )
                logger.info(
                    "Re-applied manual overrides by geometry (%d docs) for %s",
                    len(simplified_overrides),
                    location_name,
                )
            except Exception as override_err:
                logger.warning(
                    "Failed geometry-based reapply of overrides for %s: %s",
                    location_name,
                    override_err,
                )

    except Exception as e:
        logger.error(
            "Error in process_osm_data for %s: %s",
            location.get("display_name", "Unknown"),
            e,
        )
        await _update_task_progress(
            task_id,
            "error",
            0,
            f"Error in street data segmentation: {e}",
            error=str(e),
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location.get("display_name", "Unknown")},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"Error in street data segmentation: {str(e)[:200]}",
                    "last_updated": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )
        raise  # Re-raise to be caught by the caller


async def preprocess_streets(
    validated_location: dict[str, Any],
    task_id: str | None = None,
    segment_length_meters: float = SEGMENT_LENGTH_METERS,
) -> None:
    """Preprocess street data for a validated location:
    Fetch filtered OSM data (excluding non-drivable/private ways),
    determine appropriate UTM zone, segment streets, and update the database.
    Clips streets to the location's GeoJSON boundary if available.
    """
    location_name = validated_location["display_name"]
    boundary_shape: BaseGeometry | None = None  # Initialize boundary_shape

    try:
        logger.info(
            "Starting street preprocessing for %s",
            location_name,
        )
        await _update_task_progress(
            task_id,
            "preprocessing",
            5,
            f"Initializing boundary processing for {location_name}. (Detail: Setup)",
        )

        # Construct the boundary shape from validated_location geojson
        # The geojson field comes directly from the Nominatim Search API with
        # polygon_geojson=1 and is always a GeoJSON Geometry object:
        # {"type": "Polygon"/"MultiPolygon", "coordinates": [...]}
        if "geojson" in validated_location and validated_location["geojson"]:
            try:
                geojson_boundary_data = validated_location["geojson"]

                # Validate structure: must be a dict with type Polygon or MultiPolygon
                if not isinstance(geojson_boundary_data, dict):
                    logger.error(
                        "Boundary geojson for %s is not a dict (got %s). "
                        "Cannot process boundary.",
                        location_name,
                        type(geojson_boundary_data).__name__,
                    )
                    boundary_shape = None
                elif geojson_boundary_data.get("type") not in [
                    "Polygon",
                    "MultiPolygon",
                ]:
                    logger.error(
                        "Boundary geojson for %s has unexpected type '%s' "
                        "(expected Polygon or MultiPolygon). "
                        "Cannot process boundary.",
                        location_name,
                        geojson_boundary_data.get("type"),
                    )
                    boundary_shape = None
                else:
                    # Convert GeoJSON geometry to shapely shape
                    boundary_shape = shape(geojson_boundary_data)

                    # Validate and attempt to fix invalid geometries
                    if not boundary_shape.is_valid:
                        logger.warning(
                            "Boundary shape for %s is invalid, attempting to "
                            "fix with buffer(0)",
                            location_name,
                        )
                        boundary_shape = boundary_shape.buffer(0)

                    if boundary_shape.is_valid and not boundary_shape.is_empty:
                        logger.info(
                            "Successfully created boundary_shape for %s (type: %s).",
                            location_name,
                            geojson_boundary_data.get("type"),
                        )
                        await _update_task_progress(
                            task_id,
                            "preprocessing",
                            10,
                            f"Boundary processed for {location_name}. "
                            "Clipping enabled. (Detail: Boundary success)",
                        )
                    else:
                        logger.error(
                            "Boundary shape for %s is invalid or empty after "
                            "repair attempt. Cannot use for clipping.",
                            location_name,
                        )
                        boundary_shape = None

            except Exception as e:
                logger.error(
                    "Error creating boundary_shape from "
                    "validated_location.geojson for %s: %s",
                    location_name,
                    e,
                )
                boundary_shape = None

        if boundary_shape:
            logger.info(
                "Boundary polygon successfully created for %s. "
                "Streets will be clipped.",
                location_name,
            )
        else:
            logger.warning(
                "No boundary polygon available for %s. Streets will not be "
                "clipped to a precise boundary.",
                location_name,
            )
            await _update_task_progress(
                task_id,
                "preprocessing",
                10,
                f"No boundary for {location_name}. Clipping disabled. "
                "(Detail: Boundary missing/failed)",
            )

        center_lat = None
        center_lon = None
        try:
            # Nominatim typically returns lat/lon as strings
            center_lat = float(validated_location.get("lat"))
            center_lon = float(validated_location.get("lon"))
        except (
            TypeError,
            ValueError,
            AttributeError,
        ):  # Handle if lat/lon are missing or not convertible
            logger.warning(
                "Location %s is missing valid lat/lon. Cannot determine dynamic UTM.",
                location_name,
            )
            await _update_task_progress(
                task_id,
                "error",
                0,
                f"Missing lat/lon for {location_name}. (Detail: UTM setup failed)",
                error="Missing lat/lon for UTM calculation",
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Missing lat/lon for UTM calculation",
                    },
                },
                upsert=True,  # upsert in case metadata doc doesn't exist yet
            )
            raise ValueError(  # Raise to stop further processing
                f"Location {location_name} lacks lat/lon for dynamic UTM.",
            )

        dynamic_utm_crs = get_dynamic_utm_crs(center_lat, center_lon)
        logger.info(
            "Using dynamic CRS %s (EPSG: %s) for location %s",
            dynamic_utm_crs.name,
            dynamic_utm_crs.to_epsg(),
            location_name,
        )

        project_to_utm_dynamic = pyproj.Transformer.from_crs(
            WGS84,
            dynamic_utm_crs,
            always_xy=True,
        ).transform
        project_to_wgs84_dynamic = pyproj.Transformer.from_crs(
            dynamic_utm_crs,
            WGS84,
            always_xy=True,
        ).transform

        # Update metadata status to processing
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "location": validated_location,
                    "status": "processing",
                    "last_updated": datetime.now(timezone.utc),
                    "last_error": None,  # Clear previous errors
                },
                "$setOnInsert": {  # Fields to set only on insert
                    "total_length": 0.0,
                    "driven_length": 0.0,
                    "coverage_percentage": 0.0,
                    "total_segments": 0,
                    "created_at": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )

        # Clear existing street segments for this location before fetching new ones
        logger.info(
            f"Clearing existing street segments for {location_name}...",
        )
        try:
            delete_result = await delete_many_with_retry(
                streets_collection,
                {"properties.location": location_name},
            )
            logger.info(
                "Deleted %d existing segments for %s.",
                delete_result.deleted_count,
                location_name,
            )
            await _update_task_progress(
                task_id,
                "preprocessing",
                15,
                f"Cleared {delete_result.deleted_count} old segments for "
                f"{location_name}",
            )
        except Exception as del_err:
            logger.error(
                "Error clearing existing segments for %s: %s", location_name, del_err
            )
            # Decide if this is a fatal error or if we can proceed

        # Build Overpass query
        osm_data = None
        query_string = None
        try:
            logger.info(
                "Fetching filtered OSM street data for %s using standard query...",
                location_name,
            )
            query_target_clause = _get_query_target_clause_for_bbox(validated_location)
            query_string = build_standard_osm_streets_query(
                query_target_clause, timeout=300
            )

            # Check cache first (optional TTL)
            try:
                cached_doc = await find_one_with_retry(
                    osm_data_collection,
                    {"location.display_name": location_name},
                )
            except Exception:
                cached_doc = None

            cache_ok = False
            if cached_doc and isinstance(cached_doc.get("data"), dict):
                created_at = cached_doc.get("created_at")
                if OSM_CACHE_TTL_HOURS <= 0:
                    cache_ok = True
                elif created_at and isinstance(created_at, datetime):
                    age_hours = (
                        datetime.now(timezone.utc) - created_at
                    ).total_seconds() / 3600.0
                    cache_ok = age_hours <= OSM_CACHE_TTL_HOURS
                else:
                    cache_ok = False
            if cache_ok:
                osm_data = cached_doc["data"]
                await _update_task_progress(
                    task_id,
                    "preprocessing",
                    30,
                    f"Using cached OSM data for {location_name} "
                    f"(<= {int(OSM_CACHE_TTL_HOURS)}h old)",
                )
            else:
                osm_data, endpoint_used = await _fetch_osm_with_fallback(
                    query=query_string,
                    task_id=task_id,
                    location_name=location_name,
                )
                # Store/refresh cache
                try:
                    await update_one_with_retry(
                        osm_data_collection,
                        {"location.display_name": location_name},
                        {
                            "$set": {
                                "location": validated_location,
                                "data": osm_data,
                                "endpoint": endpoint_used,
                                "created_at": datetime.now(timezone.utc),
                            }
                        },
                        upsert=True,
                    )
                except Exception as cache_err:
                    logger.warning(
                        "Failed to cache OSM data for %s: %s",
                        location_name,
                        cache_err,
                    )
        except TimeoutError:
            logger.error(
                "Timeout fetching OSM data for %s (all endpoints)",
                location_name,
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Timeout fetching OSM data (all endpoints)",
                    },
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
            await _update_task_progress(
                task_id,
                "error",
                20,
                f"OSM Fetch Error for {location_name}: {fetch_err}",
                error=str(fetch_err)[:200],
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"OSM Fetch Error: {str(fetch_err)[:200]}",
                    },
                },
            )
            return

        if not osm_data or not osm_data.get("elements"):
            logger.warning(
                "No OSM elements returned for %s after filtering. "
                "Preprocessing finished.",
                location_name,
            )
            await _update_task_progress(
                task_id,
                "preprocessing",
                40,
                f"No OSM elements found for {location_name}. "
                "Preprocessing finished. (Detail: OSM fetch empty)",
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "completed",
                        "total_segments": 0,
                        "total_length": 0.0,
                        "last_error": None,  # Not an error, just no data
                    },
                },
            )
            return

        # Process and segment the fetched OSM data
        try:
            logger.info(
                "Processing and segmenting filtered OSM data for %s...",
                location_name,
            )
            await _update_task_progress(
                task_id,
                "preprocessing",
                45,
                f"Starting street segmentation for {location_name}. "
                "(Detail: Calling process_osm_data)",
            )
            await asyncio.wait_for(
                process_osm_data(
                    osm_data,
                    validated_location,
                    project_to_utm_dynamic,
                    project_to_wgs84_dynamic,
                    boundary_shape,
                    segment_length_meters,
                    task_id,
                ),
                timeout=1800,  # Timeout for the entire data processing stage
            )
            logger.info(
                "Street preprocessing completed successfully for %s.",
                location_name,
            )

        except TimeoutError:  # Catch asyncio.TimeoutError from wait_for
            logger.error(
                "Timeout processing OSM data for %s",
                location_name,
            )
            await _update_task_progress(
                task_id,
                "error",
                50,
                f"Timeout processing OSM data for {location_name}. "
                "(Detail: process_osm_data timeout)",
                error="Timeout processing street data",
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Timeout processing street data",
                    },
                },
            )
            return
        except Exception as process_err:
            # process_osm_data should handle its own metadata error update for this case
            logger.error(
                "Preprocessing failed during data processing stage for %s: %s",
                location_name,
                process_err,
                exc_info=True,
            )
            # process_osm_data should call _update_task_progress on its own errors
            # So no explicit call here, to avoid double reporting on the same error.
            return  # Exit as processing failed

    except Exception as e:
        location_name_safe = validated_location.get(
            "display_name",
            "Unknown Location",
        )
        logger.error(
            "Unhandled error during street preprocessing orchestration for %s: %s",
            location_name_safe,
            e,
            exc_info=True,
        )
        await _update_task_progress(
            task_id,
            "error",
            0,
            f"Unexpected error in preprocessing: {e}",
            error=str(e)[:200],
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name_safe},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"Unexpected preprocessing error: {str(e)[:200]}",
                    "last_updated": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )

    finally:
        gc.collect()  # Explicit garbage collection
        logger.debug(
            "Preprocessing task finished for %s, running GC.",
            validated_location.get("display_name", "Unknown Location"),
        )
