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
from shapely.ops import transform, unary_union

from db import (
    coverage_metadata_collection,
    delete_many_with_retry,
    streets_collection,
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

OVERPASS_URL = "http://overpass-api.de/api/interpreter"
WGS84 = pyproj.CRS("EPSG:4326")

# Regex constants are now centralized in osm_utils.py

SEGMENT_LENGTH_METERS = 100
BATCH_SIZE = 1000
PROCESS_TIMEOUT = 30000  # Timeout for individual parallel processing tasks
MAX_WORKERS = min(multiprocessing.cpu_count(), 8)


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
            "Failed to determine dynamic UTM/UPS CRS for lat=%s, lon=%s: %s. Falling back to EPSG:%d.",
            latitude,
            longitude,
            e,
            fallback_crs_epsg,
        )
        return pyproj.CRS(f"EPSG:{fallback_crs_epsg}")


async def fetch_osm_data(
    query: str, timeout: int = 300
) -> dict[str, Any]:  # Increased default timeout
    """Fetch OSM data via Overpass API, with proper cleanup and error propagation."""
    # The timeout here is for the HTTP request itself.
    # The Overpass query itself has its own [timeout:...] directive.
    async with aiohttp.ClientSession() as session:
        try:
            logger.debug("Fetching OSM data with query: %s", query)
            async with session.post(
                OVERPASS_URL,
                data=query,
                timeout=timeout,  # HTTP client timeout
            ) as resp:
                resp.raise_for_status()
                return await resp.json()
        except (
            asyncio.TimeoutError
        ) as e:  # Catch asyncio.TimeoutError specifically
            logger.error(
                "Timeout fetching OSM data (HTTP request timeout %ds): %s",
                timeout,
                e,
            )
            raise
        except aiohttp.ClientResponseError as e:
            # More detailed logging for client response errors
            error_text = (
                await e.text() if hasattr(e, "text") else str(e.message)
            )
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


def substring(line: LineString, start: float, end: float) -> LineString | None:
    """Return a sub-linestring from 'start' to 'end' along the line (UTM
    coords).
    """
    if (
        start < 0
        or end > line.length
        or start >= end
        or abs(line.length) < 1e-6
    ):
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
                ) or not segment_coords:
                    segment_coords.append(p0)

        if accumulated < end <= current_end_accum:
            fraction = (end - accumulated) / seg_length
            end_point = (
                p0[0] + fraction * (p1[0] - p0[0]),
                p0[1] + fraction * (p1[1] - p0[1]),
            )
            if (
                not segment_coords
                or LineString(
                    [
                        segment_coords[-1],
                        end_point,
                    ],
                ).length
                > 1e-6
            ):
                segment_coords.append(end_point)
            break

        if start <= accumulated and current_end_accum <= end:
            if (
                not segment_coords
                or LineString([segment_coords[-1], p1]).length > 1e-6
            ):
                segment_coords.append(p1)

        accumulated += seg_length

    if len(segment_coords) >= 2:
        if (
            LineString(
                [
                    segment_coords[0],
                    segment_coords[-1],
                ],
            ).length
            < 1e-6
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
    line: LineString,
    segment_length_meters: float = SEGMENT_LENGTH_METERS,
) -> list[LineString]:
    """Split a linestring (in UTM) into segments of approximately
    segment_length_meters.
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
        seg = substring(line, start_distance, end_distance)
        if (
            seg is not None and seg.length > 1e-6
        ):  # Ensure segment has some length
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
        boundary_polygon: BaseGeometry | None = element_data.get(
            "boundary_polygon"
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
            segment_length_meters=SEGMENT_LENGTH_METERS,
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
                    # logger.debug("Segment %s-%d outside boundary", osm_id, i)
                    continue  # Segment is entirely outside the boundary

                clipped_segment_wgs84 = segment_wgs84.intersection(
                    boundary_polygon
                )

                if (
                    not clipped_segment_wgs84.is_valid
                    or clipped_segment_wgs84.is_empty
                    or not hasattr(clipped_segment_wgs84, "geom_type")
                    or clipped_segment_wgs84.geom_type
                    not in ("LineString", "MultiLineString")
                ):
                    # logger.debug("Segment %s-%d became invalid/empty or non-linear after clipping", osm_id, i)
                    continue  # Skip if clipping results in non-LineString or empty geometry

                # If clipping results in a MultiLineString, we might want to process each part
                # For simplicity here, we'll take the largest LineString if it's a MultiLineString
                # or just use it if it's a LineString.
                # A more robust solution might involve creating multiple features from a MultiLineString.
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
                        # logger.debug("MultiLineString for %s-%d resulted in no suitable LineString after clipping", osm_id, i)
                        continue  # No suitable line found
                else:  # It's a LineString
                    segment_wgs84_to_use = clipped_segment_wgs84

                if (
                    segment_wgs84_to_use.length < 1e-6
                ):  # Check length again after potential selection from MultiLineString
                    # logger.debug("Segment %s-%d too short after clipping", osm_id, i)
                    continue

                # Recalculate UTM geometry and length for the (potentially) clipped segment
                # This is important if segment_length property is used downstream for calculations in UTM.
                # For now, we store WGS84 geometry and original UTM segment length.
                # A more accurate approach would be to re-project the clipped WGS84 back to UTM
                # and use its length, but that adds another transformation.
                # Let's keep the original segment_utm.length for now, but acknowledge this.
                # The geometry stored will be the clipped WGS84.

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
                    "undriveable": False,  # Default, can be overridden by coverage calculation
                    "manual_override": False,
                    "manually_marked_driven": False,
                    "manually_marked_undriven": False,
                    "manually_marked_undriveable": False,
                    "manually_marked_driveable": False,
                    "last_coverage_update": None,
                    "last_manual_update": None,
                    "matched_trips": [],
                    "tags": tags,  # Store original tags for reference
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

        process_data = [
            {
                "osm_id": element.get("id"),
                "geometry_nodes": element.get("geometry", []),
                "tags": element.get("tags", {}),
                "location_name": location_name,
                "project_to_utm": project_to_utm_func,
                "project_to_wgs84": project_to_wgs84_func,
                "boundary_polygon": boundary_polygon,
            }
            for element in way_elements
            if element.get("id") is not None  # Ensure ID exists
            and element.get("geometry") is not None  # Ensure geometry exists
        ]

        processed_segments_count = 0
        total_segments_count = 0

        # Use ProcessPoolExecutor for CPU-bound tasks (segmentation, projection)
        with ProcessPoolExecutor(max_workers=MAX_WORKERS) as executor:
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
                                    f"Segment {
                                        feature.get('properties', {}).get(
                                            'segment_id'
                                        )
                                    } missing valid length.",
                                )

                    if len(batch_to_insert) >= BATCH_SIZE:
                        try:
                            await streets_collection.insert_many(
                                batch_to_insert,
                                ordered=False,  # Allows some to fail without stopping others
                            )
                            processed_segments_count += len(batch_to_insert)
                            logger.info(
                                "Inserted batch of %d segments (%d/%d total processed for %s)",
                                len(batch_to_insert),
                                processed_segments_count,
                                total_segments_count,  # Use total_segments_count for progress
                                location_name,
                            )
                            batch_to_insert = []
                            gc.collect()  # Explicit garbage collection after large batch
                            await asyncio.sleep(
                                0.05
                            )  # Small sleep to yield control
                        except BulkWriteError as bwe:
                            # Handle duplicate key errors gracefully if segment_id is unique
                            write_errors = bwe.details.get(
                                "writeErrors",
                                [],
                            )
                            dup_keys = [
                                e
                                for e in write_errors
                                if e.get("code")
                                == 11000  # Duplicate key error code
                            ]
                            if dup_keys:
                                logger.warning(
                                    f"Skipped {
                                        len(dup_keys)
                                    } duplicate segments during batch insert for {
                                        location_name
                                    }.",
                                )
                            other_errors = [
                                e
                                for e in write_errors
                                if e.get("code") != 11000
                            ]
                            if other_errors:
                                logger.error(
                                    f"Non-duplicate BulkWriteError inserting batch for {location_name}: {other_errors}",
                                )
                            # Even with errors, clear batch_to_insert to avoid re-inserting failed ones
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

            # Insert any remaining segments
            if batch_to_insert:
                try:
                    await streets_collection.insert_many(
                        batch_to_insert,
                        ordered=False,
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
                    write_errors = bwe.details.get("writeErrors", [])
                    dup_keys = [
                        e for e in write_errors if e.get("code") == 11000
                    ]
                    if dup_keys:
                        logger.warning(
                            f"Skipped {
                                len(dup_keys)
                            } duplicate segments during final batch insert for {
                                location_name
                            }.",
                        )
                    other_errors = [
                        e for e in write_errors if e.get("code") != 11000
                    ]
                    if other_errors:
                        logger.error(
                            f"Non-duplicate BulkWriteError inserting final batch for {location_name}: {other_errors}",
                        )
                except Exception as insert_err:
                    logger.error(
                        "Error inserting final batch: %s",
                        insert_err,
                        exc_info=True,
                    )

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
                    },
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
                    "last_error": f"Preprocessing failed: {e!s}",
                    "last_updated": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )
        raise  # Re-raise to be caught by the caller


async def preprocess_streets(
    validated_location: dict[str, Any],
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

        # Attempt to construct the boundary shape from validated_location geojson
        if "geojson" in validated_location and validated_location["geojson"]:
            try:
                # Assuming validated_location['geojson'] is a FeatureCollection dictionary
                # or a single Feature dictionary.
                # We need to handle both MultiPolygon and Polygon geometries.

                geojson_boundary_data = validated_location["geojson"]

                # Check if geojson_boundary_data is what Nominatim provides directly
                # (a dict with 'type': 'Polygon'/'MultiPolygon')
                if isinstance(
                    geojson_boundary_data, dict
                ) and geojson_boundary_data.get("type") in [
                    "Polygon",
                    "MultiPolygon",
                ]:
                    boundary_shape = shape(geojson_boundary_data)
                    if not boundary_shape.is_valid:
                        logger.warning(
                            "Boundary shape for %s is invalid, attempting to buffer by 0",
                            location_name,
                        )
                        boundary_shape = boundary_shape.buffer(0)
                    if boundary_shape.is_valid:
                        logger.info(
                            "Successfully created boundary_shape for %s from 'geojson' field.",
                            location_name,
                        )
                    else:
                        logger.error(
                            "Boundary shape for %s remains invalid after buffer(0). Cannot use for clipping.",
                            location_name,
                        )
                        boundary_shape = None  # Ensure it's None if invalid
                # Fallback for older structure or list of features (if Nominatim output changes or it's from another source)
                elif (
                    isinstance(geojson_boundary_data, list)
                    and geojson_boundary_data
                ):
                    raw_polygons = []
                    for item in geojson_boundary_data:
                        if (
                            isinstance(item, dict)
                            and item.get("geojson")
                            and isinstance(item.get("geojson"), dict)
                            and item.get("geojson").get("type")
                            in ["Polygon", "MultiPolygon"]
                        ):
                            raw_polygons.append(shape(item.get("geojson")))
                        elif isinstance(item, dict) and item.get("type") in [
                            "Polygon",
                            "MultiPolygon",
                        ]:
                            raw_polygons.append(shape(item))
                        elif (
                            isinstance(item, dict)
                            and item.get("type") == "Feature"
                            and item.get("geometry", {}).get("type")
                            in ["Polygon", "MultiPolygon"]
                        ):
                            raw_polygons.append(shape(item["geometry"]))
                        elif (
                            isinstance(item, dict)
                            and item.get("type") == "FeatureCollection"
                        ):
                            for feature in item.get("features", []):
                                if feature.get("geometry", {}).get("type") in [
                                    "Polygon",
                                    "MultiPolygon",
                                ]:
                                    raw_polygons.append(
                                        shape(feature["geometry"])
                                    )

                    if raw_polygons:
                        # Combine all valid polygons into a single geometry (MultiPolygon or Polygon)
                        # Filter for valid geometries before union to avoid errors
                        valid_polygons = [
                            p
                            for p in raw_polygons
                            if p.is_valid or p.buffer(0).is_valid
                        ]
                        if not valid_polygons:
                            logger.warning(
                                "No valid polygon geometries found in 'geojson' list for %s after attempting to fix.",
                                location_name,
                            )
                        else:
                            # Attempt to fix invalid geometries before union
                            fixed_polygons = [
                                p if p.is_valid else p.buffer(0)
                                for p in valid_polygons
                            ]
                            # Filter again as buffer(0) might result in empty or invalid geoms for some inputs
                            final_polygons_for_union = [
                                p
                                for p in fixed_polygons
                                if p.is_valid and not p.is_empty
                            ]
                            if final_polygons_for_union:
                                boundary_shape = unary_union(
                                    final_polygons_for_union
                                )
                                if not boundary_shape.is_valid:
                                    logger.warning(
                                        "Union of boundary polygons for %s is invalid, attempting buffer(0).",
                                        location_name,
                                    )
                                    boundary_shape = boundary_shape.buffer(0)
                                if boundary_shape.is_valid:
                                    logger.info(
                                        "Successfully created boundary_shape for %s from list of geojson items.",
                                        location_name,
                                    )
                                else:
                                    logger.error(
                                        "Boundary shape for %s from list remains invalid. Cannot use for clipping.",
                                        location_name,
                                    )
                                    boundary_shape = None
                            else:
                                logger.warning(
                                    "No valid polygons left after fixing for union for %s.",
                                    location_name,
                                )
                    else:
                        logger.warning(
                            "No geometries could be extracted from the 'geojson' list for %s.",
                            location_name,
                        )
                else:
                    logger.warning(
                        "Validated_location.geojson for %s is not a recognized Polygon/MultiPolygon dict or a list of features. Type: %s",
                        location_name,
                        type(geojson_boundary_data).__name__,
                    )

            except Exception as e:
                logger.error(
                    "Error creating boundary_shape from validated_location.geojson for %s: %s. Proceeding without clipping.",
                    location_name,
                    e,
                    exc_info=True,
                )
                boundary_shape = None  # Ensure it's None on error

        if boundary_shape:
            logger.info(
                "Boundary polygon successfully created for %s. Streets will be clipped.",
                location_name,
            )
        else:
            logger.warning(
                "No boundary polygon available for %s. Streets will not be clipped to a precise boundary.",
                location_name,
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
            "Clearing existing street segments for %s...",
            location_name,
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
        except Exception as del_err:
            logger.error(
                "Error clearing existing segments for %s: %s",
                location_name,
                del_err,
            )
            # Decide if this is a fatal error or if we can proceed

        osm_data = None
        try:
            logger.info(
                "Fetching filtered OSM street data for %s using standard query...",
                location_name,
            )
            # Use the _get_query_target_clause_for_bbox to prepare the bbox part of the query
            query_target_clause = _get_query_target_clause_for_bbox(
                validated_location
            )
            query_string = build_standard_osm_streets_query(
                query_target_clause, timeout=300
            )

            osm_data = await asyncio.wait_for(
                fetch_osm_data(
                    query=query_string, timeout=360
                ),  # Increased HTTP timeout
                timeout=400,  # Overall timeout for the fetch operation
            )
        except (
            asyncio.TimeoutError
        ):  # Catch asyncio.TimeoutError from wait_for
            logger.error(
                "Timeout fetching OSM data for %s (overall fetch timeout)",
                location_name,
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Timeout fetching OSM data",
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
            await asyncio.wait_for(
                process_osm_data(
                    osm_data,
                    validated_location,
                    project_to_utm_dynamic,
                    project_to_wgs84_dynamic,
                    boundary_shape,
                ),
                timeout=1800,  # Timeout for the entire data processing stage
            )
            logger.info(
                "Street preprocessing completed successfully for %s.",
                location_name,
            )

        except (
            asyncio.TimeoutError
        ):  # Catch asyncio.TimeoutError from wait_for
            logger.error(
                "Timeout processing OSM data for %s",
                location_name,
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
            # No need to update metadata here again if process_osm_data does it
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
