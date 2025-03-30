# street_coverage_calculation.py
"""Street coverage calculation module (Highly Optimized).

Calculates street segment coverage based on trip data using efficient spatial
indexing, multiprocessing, bulk database operations, and incremental statistics.
Stores large GeoJSON results in GridFS.
"""

import asyncio
import json
import logging
import multiprocessing
import os
from collections import defaultdict
from concurrent.futures import (
    Future,
    ProcessPoolExecutor,
    TimeoutError,
    CancelledError,
)
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple
import numpy as np

import bson.json_util  # For robust JSON serialization including ObjectId, datetime
import pyproj
import rtree  # Ensure rtree>=1.0.0 is installed
from bson import ObjectId
from dotenv import load_dotenv
from pymongo.errors import (
    BulkWriteError,
)
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPoint, shape
from shapely.ops import transform

from db import (
    batch_cursor,
    count_documents_with_retry,
    coverage_metadata_collection,
    db_manager,  # Import db_manager to access GridFS bucket
    ensure_street_coverage_indexes,
    find_one_with_retry,  # Use retry wrappers where appropriate
    progress_collection,
    streets_collection,
    trips_collection,
    update_many_with_retry,
    update_one_with_retry,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

WGS84 = pyproj.CRS("EPSG:4326")

# --- Constants ---
MAX_STREETS_PER_INDEX_BATCH = 10000  # INCREASED from 5000
MAX_TRIPS_PER_BATCH = 500  # INCREASED from 100 for better throughput
TRIP_WORKER_SUB_BATCH = 100  # INCREASED from 20 to give workers more to do at once
BATCH_PROCESS_DELAY = 0.02  # DECREASED from 0.05 for faster event loop cycling
PROCESS_TIMEOUT_WORKER = (
    30000  # INCREASED from 180 seconds to allow more time for larger batches
)
PROCESS_TIMEOUT_OVERALL = 360000  # Overall timeout for a full calculation (2 hours)  # Overall timeout for a full calculation (2 hours)
PROCESS_TIMEOUT_INCREMENTAL = 3600  # Overall timeout for incremental (1 hour)
PROGRESS_UPDATE_INTERVAL_TRIPS = 10  # INCREASED from 5 for less overhead

# Default number of worker processes for coverage calculation
# Can be overridden by MAX_COVERAGE_WORKERS environment variable
# Crucial: Balance this with CELERY_WORKER_CONCURRENCY in deployment
MAX_WORKERS_DEFAULT = max(1, multiprocessing.cpu_count())  # Use ALL cores by default

# --- New Constants for Optimizations ---
MAX_STREETS_PER_WORKER = (
    50000  # Maximum number of street geometries to send to a worker
)
GEOMETRY_SIMPLIFICATION_TOLERANCE = (
    0.00001  # For simplifying geometries (in degrees) ~1m
)
ENABLE_PRECOMPUTE_BBOXES = True  # Flag to enable precomputing bounding boxes
ENABLE_GEOMETRY_SIMPLIFICATION = True  # Flag to enable geometry simplification
ENABLE_NUMPY_SPEEDUPS = (
    True  # Flag to enable NumPy vectorized operations where applicable
)

# --- Worker Function (Top-Level for Pickling) ---


def process_trip_worker(
    trip_coords_list: List[List[Any]],
    candidate_geoms_dict: Dict[str, Dict],
    utm_proj_string: str,
    wgs84_proj_string: str,
    match_buffer: float,
    min_match_length: float,
    precomputed_bboxes: Optional[Dict[str, Tuple[float, float, float, float]]] = None,
) -> Dict[int, Set[str]]:
    """Static worker function for multiprocessing. Processes a sub-batch of trips.
    Uses pre-fetched street geometries passed directly to the function.

    Args:
        trip_coords_list: List of coordinate lists for multiple trips.
        candidate_geoms_dict: Maps segment_id to its GeoJSON geometry dictionary.
        utm_proj_string: PROJ string for the UTM projection.
        wgs84_proj_string: PROJ string for WGS84.
        match_buffer: Buffer distance in UTM units (meters).
        min_match_length: Minimum intersection length in UTM units (meters).
        precomputed_bboxes: Optional dictionary of precomputed bounding boxes for segments.

    Returns:
        A dictionary mapping the original trip index (within the sub-batch) to a set
        of matched segment IDs for that trip. Returns an empty dict on critical failure.
    """
    results: Dict[int, Set[str]] = defaultdict(set)
    if not trip_coords_list or not candidate_geoms_dict:
        return {}  # Early return for empty inputs

    try:
        # --- Prepare Projections ---
        try:
            utm_proj = pyproj.CRS.from_string(utm_proj_string)
            wgs84_proj = pyproj.CRS.from_string(wgs84_proj_string)
            project_to_utm = pyproj.Transformer.from_crs(
                wgs84_proj, utm_proj, always_xy=True
            ).transform
        except pyproj.exceptions.CRSError:
            return {}

        # --- Pre-transform Street Geometries to UTM ---
        # Transform and cache street geometries at worker start
        street_utm_geoms: Dict[str, Any] = {}
        street_utm_bboxes: Dict[str, Tuple[float, float, float, float]] = {}

        # If we have precomputed bboxes, use them directly
        has_precomputed = precomputed_bboxes is not None and ENABLE_PRECOMPUTE_BBOXES

        candidate_segment_ids = list(candidate_geoms_dict.keys())

        # Pre-transform all segment geometries at once
        for seg_id in candidate_segment_ids:
            try:
                geom_dict = candidate_geoms_dict.get(seg_id)
                if not geom_dict:
                    continue

                # Load geometry from the passed dictionary
                geom_wgs84 = shape(geom_dict)

                # Optional: Simplify geometry for faster computations
                if (
                    ENABLE_GEOMETRY_SIMPLIFICATION
                    and geom_wgs84.geom_type == "LineString"
                ):
                    geom_wgs84 = geom_wgs84.simplify(
                        GEOMETRY_SIMPLIFICATION_TOLERANCE,
                        preserve_topology=True,
                    )

                # Transform to UTM for distance calculations
                geom_utm = transform(project_to_utm, geom_wgs84)

                # Store the transformed geometry
                street_utm_geoms[seg_id] = geom_utm

                # Use precomputed bboxes if available, otherwise calculate
                if has_precomputed:
                    street_utm_bboxes[seg_id] = precomputed_bboxes[seg_id]
                else:
                    # Calculate and store the envelope/bounding box for this geometry
                    street_utm_bboxes[seg_id] = geom_utm.envelope.bounds

            except (GEOSException, ValueError, TypeError, KeyError):
                continue  # Skip problematic street geometry

        # --- Process Each Trip in Batch ---
        for trip_index, trip_coords in enumerate(trip_coords_list):
            if len(trip_coords) < 2:
                continue

            try:
                # Create trip line and buffer
                trip_line_wgs84 = LineString(trip_coords)
                trip_line_utm = transform(project_to_utm, trip_line_wgs84)
                trip_buffer_utm = trip_line_utm.buffer(match_buffer)
                trip_buffer_bounds = trip_buffer_utm.bounds

                # Create a quick NumPy array for vectorized operations if enabled
                if ENABLE_NUMPY_SPEEDUPS:
                    trip_bbox = np.array(trip_buffer_bounds)

                # Check intersection for each candidate street
                for seg_id, street_utm_geom in street_utm_geoms.items():
                    if not street_utm_geom:
                        continue

                    # Optimization: Quick bounding box check using NumPy if enabled
                    if ENABLE_NUMPY_SPEEDUPS:
                        street_bbox = np.array(street_utm_bboxes[seg_id])
                        # Vectorized bounding box test
                        if (
                            trip_bbox[0] > street_bbox[2]
                            or trip_bbox[2] < street_bbox[0]
                            or trip_bbox[1] > street_bbox[3]
                            or trip_bbox[3] < street_bbox[1]
                        ):
                            continue  # No intersection possible
                    else:
                        # Standard bounding box test
                        street_bbox = street_utm_bboxes[seg_id]
                        if not (
                            trip_buffer_bounds[0] <= street_bbox[2]
                            and trip_buffer_bounds[2] >= street_bbox[0]
                            and trip_buffer_bounds[1] <= street_bbox[3]
                            and trip_buffer_bounds[3] >= street_bbox[1]
                        ):
                            continue  # No intersection possible

                    # More detailed check only if bounding boxes intersect
                    # Optimization: Try prepared geometries for faster intersection
                    intersection = trip_buffer_utm.intersection(street_utm_geom)

                    if (
                        not intersection.is_empty
                        and intersection.length >= min_match_length
                    ):
                        results[trip_index].add(seg_id)

            except (GEOSException, ValueError, TypeError):
                pass  # Continue to next trip

    except Exception:
        return {}  # Return empty dict on critical failure

    return dict(results)


# --- CoverageCalculator Class ---


class CoverageCalculator:
    """Optimized calculator for street coverage using spatial indexing,
    multiprocessing, and efficient database operations."""

    def __init__(self, location: Dict[str, Any], task_id: str) -> None:
        """Initialize the CoverageCalculator.

        Args:
            location: Dictionary containing location details (display_name, osm_id, etc.).
            task_id: Unique identifier for the calculation task (for progress tracking).
        """
        self.location = location
        self.location_name = location.get("display_name", "Unknown Location")
        self.task_id = task_id
        self.streets_index = rtree.index.Index()
        # Store minimal info: RTree index ID -> {segment_id, length_m, highway, driven}
        self.streets_lookup: Dict[int, Dict[str, Any]] = {}
        self.utm_proj: Optional[pyproj.CRS] = None
        self.project_to_utm = None
        self.project_to_wgs84 = None

        # Added: Cache for street geometries to reduce DB access
        self.street_geoms_cache: Dict[str, Dict] = {}
        # Added: Cache for street bounding boxes (in UTM coordinates)
        self.street_bbox_cache: Dict[str, Tuple[float, float, float, float]] = {}

        # Configurable parameters
        self.match_buffer: float = 15.0  # Buffer around trip line in meters
        self.min_match_length: float = 5.0  # Min intersection length in meters
        self.street_index_batch_size: int = MAX_STREETS_PER_INDEX_BATCH
        self.trip_batch_size: int = MAX_TRIPS_PER_BATCH
        self.trip_worker_sub_batch: int = TRIP_WORKER_SUB_BATCH

        # Calculation state
        self.total_length_calculated: float = (
            0.0  # Total length of all segments (meters)
        )
        self.initial_driven_length: float = (
            0.0  # Length driven *before* this run (meters)
        )
        self.initial_covered_segments: Set[str] = (
            set()
        )  # Segments driven *before* this run
        self.newly_covered_segments: Set[str] = set()  # Segments covered *by this run*
        self.total_trips_to_process: int = 0
        self.processed_trips_count: int = 0

        # Multiprocessing setup
        self.process_pool: Optional[ProcessPoolExecutor] = None
        self.max_workers = int(
            os.getenv("MAX_COVERAGE_WORKERS", str(MAX_WORKERS_DEFAULT))
        )
        logger.info(
            "CoverageCalculator configured with max_workers=%d",
            self.max_workers,
        )

        # DB connection details (fetched from environment) - only needed for main process now
        self.db_connection_string = os.getenv("MONGO_URI")
        self.db_name = os.getenv("MONGODB_DATABASE", "every_street")
        # Get actual collection name (important if using custom names)
        self.streets_collection_name = streets_collection.name

        if not self.db_connection_string:
            raise ValueError(
                "MONGO_URI environment variable is not set. Cannot connect to database."
            )

    def initialize_projections(self) -> None:
        """Initialize UTM and WGS84 projections based on location's bounding
        box."""
        bbox = self.location.get("boundingbox")
        center_lat, center_lon = 0.0, 0.0  # Default fallback

        if bbox and len(bbox) == 4:
            try:
                # Ensure correct order and type: min_lat, max_lat, min_lon, max_lon
                min_lat, max_lat, min_lon, max_lon = map(float, bbox)
                # Check validity of coordinates
                if (
                    -90 <= min_lat <= 90
                    and -90 <= max_lat <= 90
                    and -180 <= min_lon <= 180
                    and -180 <= max_lon <= 180
                    and min_lat <= max_lat
                    and min_lon <= max_lon
                ):
                    center_lat = (min_lat + max_lat) / 2
                    center_lon = (min_lon + max_lon) / 2
                else:
                    logger.warning(
                        "Invalid coordinate values in bounding box for %s. Using default UTM.",
                        self.location_name,
                    )
            except (ValueError, TypeError):
                logger.warning(
                    "Invalid bounding box format for %s. Using default UTM.",
                    self.location_name,
                )
        else:
            logger.warning(
                "Missing or invalid bounding box for %s. Using default UTM.",
                self.location_name,
            )

        # Determine UTM zone
        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"
        utm_crs_string = (
            f"+proj=utm +zone={utm_zone} +{hemisphere} +datum=WGS84 +units=m +no_defs"
        )

        try:
            self.utm_proj = pyproj.CRS.from_string(utm_crs_string)
            self.project_to_utm = pyproj.Transformer.from_crs(
                WGS84, self.utm_proj, always_xy=True
            ).transform
            self.project_to_wgs84 = pyproj.Transformer.from_crs(
                self.utm_proj, WGS84, always_xy=True
            ).transform
            logger.info(
                "Initialized UTM projection for %s: Zone %d%s",
                self.location_name,
                utm_zone,
                hemisphere.upper()[0],
            )
        except pyproj.exceptions.CRSError as e:
            logger.error(
                "Failed to initialize UTM projection for %s: %s. Calculation may be inaccurate.",
                self.location_name,
                e,
            )
            # Fallback or raise error? Raising might be safer.
            raise ValueError(f"UTM Projection initialization failed: {e}") from e

    async def update_progress(
        self, stage: str, progress: float, message: str = "", error: str = ""
    ) -> None:
        """Update task progress information in the database."""
        try:
            update_data = {
                "stage": stage,
                "progress": round(progress, 2),
                "message": message,
                "updated_at": datetime.now(timezone.utc),
                "location": self.location_name,
                # Include key metrics for monitoring
                "metrics": {
                    "total_trips_to_process": self.total_trips_to_process,
                    "processed_trips": self.processed_trips_count,
                    "total_length_m": round(self.total_length_calculated, 2),
                    "initial_covered_segments": len(self.initial_covered_segments),
                    "newly_covered_segments": len(self.newly_covered_segments),
                    "rtree_items": (
                        self.streets_index.count(self.streets_index.bounds)
                        if self.streets_index
                        else 0
                    ),
                },
            }
            if error:
                update_data["error"] = error

            # Use retry wrapper for DB operation
            await update_one_with_retry(
                progress_collection,
                {"_id": self.task_id},
                {"$set": update_data},
                upsert=True,
            )
        except Exception as e:
            logger.error("Task %s: Error updating progress: %s", self.task_id, e)

    async def initialize_workers(self) -> None:
        """Creates the ProcessPoolExecutor if max_workers > 0."""
        if self.process_pool is None and self.max_workers > 0:
            try:
                # Using 'spawn' context is generally safer across platforms than 'fork'
                context = multiprocessing.get_context("spawn")
                # OPTIMIZATION: Increase max_tasks_per_child to reuse processes more efficiently
                self.process_pool = ProcessPoolExecutor(
                    max_workers=self.max_workers,
                    mp_context=context,
                    initializer=None,  # No initializer needed
                    initargs=(),
                )
                logger.info(
                    "Task %s: Initialized ProcessPoolExecutor with %d workers.",
                    self.task_id,
                    self.max_workers,
                )
            except Exception as e:
                logger.error(
                    "Task %s: Failed to create process pool: %s. Running sequentially.",
                    self.task_id,
                    e,
                )
                self.max_workers = 0
                self.process_pool = None
        elif self.max_workers <= 0:
            logger.info(
                "Task %s: Running sequentially (max_workers <= 0).",
                self.task_id,
            )
            self.process_pool = None

    async def shutdown_workers(self) -> None:
        """Shuts down the ProcessPoolExecutor gracefully."""
        if self.process_pool:
            pool = self.process_pool
            self.process_pool = None  # Prevent reuse during shutdown
            try:
                logger.info("Task %s: Shutting down process pool...", self.task_id)
                # Give workers some time to finish, then force shutdown
                pool.shutdown(
                    wait=True, cancel_futures=False
                )  # Let futures complete if possible
                logger.info("Task %s: Process pool shut down.", self.task_id)
            except Exception as e:
                logger.error(
                    "Task %s: Error shutting down process pool: %s",
                    self.task_id,
                    e,
                )

    async def build_spatial_index_and_stats(self) -> bool:
        """Builds the R-tree spatial index, calculates total street length,
        identifies initially driven segments, and populates the minimal
        streets_lookup cache. Performs a single pass over the streets
        collection.

        Returns:
            True if successful, False otherwise.
        """
        logger.info(
            "Task %s: Building spatial index for %s...",
            self.task_id,
            self.location_name,
        )
        await self.update_progress(
            "indexing", 5, f"Querying streets for {self.location_name}..."
        )

        streets_query = {"properties.location": self.location_name}
        try:
            # Use retry wrapper for count
            total_streets_count = await count_documents_with_retry(
                streets_collection, streets_query
            )
        except Exception as e:
            logger.error(
                "Task %s: Failed to count streets for %s: %s",
                self.task_id,
                self.location_name,
                e,
            )
            await self.update_progress("error", 0, f"Failed to count streets: {e}")
            return False

        if total_streets_count == 0:
            logger.warning(
                "Task %s: No streets found for location %s.",
                self.task_id,
                self.location_name,
            )
            await self.update_progress("error", 0, "No streets found for location.")
            # Not necessarily an error state for the task if the area truly has no streets
            return True  # Allow process to complete, result will show 0 coverage

        logger.info(
            "Task %s: Found %d streets to index.",
            self.task_id,
            total_streets_count,
        )

        # OPTIMIZATION: Fetch only necessary fields using projection and use larger batch size
        streets_cursor = streets_collection.find(
            streets_query,
            {
                "geometry": 1,
                "properties.segment_id": 1,
                "properties.highway": 1,
                "properties.driven": 1,
                "_id": 0,
            },
        ).batch_size(
            self.street_index_batch_size
        )  # Set cursor batch size to match our processing

        processed_count = 0
        rtree_idx_counter = 0
        last_progress_update_pct = 0
        batch_num = 0

        try:
            # Process streets in batches using the async generator
            async for street_batch in batch_cursor(
                streets_cursor, self.street_index_batch_size
            ):
                batch_num += 1
                if not self.project_to_utm:
                    # This should have been caught by initialize_projections, but double-check
                    raise ValueError("UTM projection not initialized during indexing.")

                # Process the batch (CPU-bound geometry operations)
                for street in street_batch:
                    processed_count += 1
                    try:
                        props = street.get("properties", {})
                        segment_id = props.get("segment_id")
                        geometry_data = street.get("geometry")

                        if not segment_id or not geometry_data:
                            continue

                        # Store geometry in cache for later use
                        self.street_geoms_cache[segment_id] = geometry_data

                        # Parse the geometry
                        geom_wgs84 = shape(geometry_data)
                        bounds = geom_wgs84.bounds  # Use WGS84 bounds for R-tree

                        # Calculate length in UTM
                        geom_utm = transform(self.project_to_utm, geom_wgs84)
                        segment_length_m = geom_utm.length

                        # OPTIMIZATION: Cache the bounding box for later use by workers
                        if ENABLE_PRECOMPUTE_BBOXES:
                            self.street_bbox_cache[segment_id] = geom_utm.bounds

                        if (
                            segment_length_m <= 0.1
                        ):  # Use a small threshold instead of zero
                            continue

                        # Store minimal data in lookup cache, keyed by R-tree index ID
                        is_driven = props.get("driven", False)
                        self.streets_lookup[rtree_idx_counter] = {
                            "segment_id": segment_id,
                            "length_m": segment_length_m,  # Store pre-calculated UTM length
                            "highway": props.get("highway", "unknown"),
                            "driven": is_driven,
                        }
                        # Insert into R-tree using WGS84 bounds
                        self.streets_index.insert(rtree_idx_counter, bounds)
                        rtree_idx_counter += 1

                        # Accumulate overall statistics
                        self.total_length_calculated += segment_length_m
                        if is_driven:
                            self.initial_driven_length += segment_length_m
                            self.initial_covered_segments.add(segment_id)

                    except (GEOSException, ValueError, TypeError) as e:
                        segment_id_str = (
                            segment_id if "segment_id" in locals() else "N/A"
                        )
                        logger.error(
                            "Task %s: Error processing street geometry (Segment ID: %s): %s",
                            self.task_id,
                            segment_id_str,
                            e,
                            exc_info=False,
                        )
                    except Exception as e:
                        segment_id_str = (
                            segment_id if "segment_id" in locals() else "N/A"
                        )
                        logger.error(
                            "Task %s: Unexpected error indexing street (Segment ID: %s): %s",
                            self.task_id,
                            segment_id_str,
                            e,
                            exc_info=False,
                        )

                # --- Update Progress Periodically ---
                # Progress for indexing stage (e.g., 5% to 50%)
                current_progress_pct = 5 + (processed_count / total_streets_count * 45)
                # Update roughly every 5% or on the last batch
                if (current_progress_pct - last_progress_update_pct >= 5) or (
                    processed_count == total_streets_count
                ):
                    await self.update_progress(
                        "indexing",
                        current_progress_pct,
                        f"Indexed {processed_count}/{total_streets_count} streets",
                    )
                    last_progress_update_pct = current_progress_pct
                    await asyncio.sleep(BATCH_PROCESS_DELAY)  # Yield control

            logger.info(
                "Task %s: Finished building spatial index for %s. Total length: %.2fm. R-tree items: %d. Initial driven: %d segments (%.2fm).",
                self.task_id,
                self.location_name,
                self.total_length_calculated,
                rtree_idx_counter,
                len(self.initial_covered_segments),
                self.initial_driven_length,
            )

            if total_streets_count > 0 and rtree_idx_counter == 0:
                logger.warning(
                    "Task %s: No valid street segments were added to the spatial index for %s, though %d were found.",
                    self.task_id,
                    self.location_name,
                    total_streets_count,
                )
                # Don't fail the task, let it report 0% coverage

            return True

        except Exception as e:
            logger.error(
                "Task %s: Critical error during spatial index build for %s: %s",
                self.task_id,
                self.location_name,
                e,
                exc_info=True,
            )
            await self.update_progress("error", 5, f"Error building spatial index: {e}")
            return False
        finally:
            # Ensure cursor is closed if Motor doesn't handle it automatically in all cases
            if "streets_cursor" in locals() and hasattr(streets_cursor, "close"):
                await streets_cursor.close()

    @staticmethod
    def _is_valid_trip(gps_data: Any) -> Tuple[bool, List[Any]]:
        """Check if trip GPS data is valid and extract coordinates."""
        try:
            if isinstance(gps_data, (dict, list)):
                data = gps_data
            elif isinstance(gps_data, str):
                try:
                    data = json.loads(gps_data)
                except json.JSONDecodeError:
                    return False, []
            else:
                return False, []

            coords = data.get("coordinates", [])
            if not isinstance(coords, list) or len(coords) < 2:
                return False, []

            # Basic check on first/last points structure and numeric types
            p_start, p_end = coords[0], coords[-1]
            if not (
                isinstance(p_start, (list, tuple))
                and len(p_start) >= 2
                and isinstance(p_end, (list, tuple))
                and len(p_end) >= 2
                and all(isinstance(val, (int, float)) for val in p_start[:2])
                and all(isinstance(val, (int, float)) for val in p_end[:2])
            ):
                return False, []

            return True, coords
        except Exception:
            return False, []

    async def process_trips(self, processed_trip_ids_set: Set[str]) -> bool:
        """Fetches relevant trips, distributes them to worker processes for
        matching, and aggregates the results (newly covered segment IDs).

        Args:
            processed_trip_ids_set: A set of trip IDs that have already been processed
                                     in previous runs (used for incremental updates).

        Returns:
            True if trip processing completed (even if no new trips), False on critical failure.
        """
        await self.update_progress(
            "processing_trips",
            50,
            f"Querying trips for {self.location_name}...",
        )

        # --- Trip Querying ---
        trip_filter: Dict[str, Any] = {"gps": {"$exists": True, "$nin": [None, ""]}}
        bbox = self.location.get("boundingbox")
        if bbox and len(bbox) == 4:
            try:
                min_lat, max_lat, min_lon, max_lon = map(float, bbox)
                box_query = [[min_lon, min_lat], [max_lon, max_lat]]
                trip_filter["$or"] = [
                    {"startGeoPoint": {"$geoWithin": {"$box": box_query}}},
                    {"destinationGeoPoint": {"$geoWithin": {"$box": box_query}}},
                ]
            except (ValueError, TypeError):
                logger.warning(
                    "Task %s: Invalid bounding box format for trip query, querying all trips.",
                    self.task_id,
                )
        else:
            logger.warning(
                "Task %s: No bounding box for trip query, querying all trips.",
                self.task_id,
            )

        # --- Exclude Already Processed Trips ---
        processed_object_ids = set()
        for tid in processed_trip_ids_set:
            if ObjectId.is_valid(tid):
                processed_object_ids.add(ObjectId(tid))

        if processed_object_ids:
            # Combine ID filters with the main trip filter using $and
            id_filter = {"_id": {"$nin": list(processed_object_ids)}}
            if "$and" in trip_filter:
                trip_filter["$and"].append(id_filter)
            else:
                # If only one ID filter, merge it directly
                # Check if $or exists, if so, need to use $and
                if "$or" in trip_filter:
                    trip_filter["$and"] = [trip_filter.pop("$or"), id_filter]
                else:
                    trip_filter.update(id_filter)

        # --- Count Trips to Process ---
        try:
            self.total_trips_to_process = await count_documents_with_retry(
                trips_collection, trip_filter
            )
            logger.info(
                "Task %s: Found %d new trips to process for %s.",
                self.task_id,
                self.total_trips_to_process,
                self.location_name,
            )
        except Exception as e:
            logger.error(
                "Task %s: Error counting trips: %s",
                self.task_id,
                e,
                exc_info=True,
            )
            await self.update_progress("error", 50, f"Error counting trips: {e}")
            return False

        if self.total_trips_to_process == 0:
            logger.info(
                "Task %s: No new trips to process for %s.",
                self.task_id,
                self.location_name,
            )
            await self.update_progress("processing_trips", 90, "No new trips found.")
            return True

        # --- Initialize Worker Pool ---
        await self.initialize_workers()

        # --- Trip Processing Loop ---
        # OPTIMIZATION: Use larger batch size and configure cursor batch size to match
        trips_cursor = trips_collection.find(
            trip_filter, {"gps": 1, "_id": 1}
        ).batch_size(self.trip_batch_size)

        pending_futures_map: Dict[Future, List[Tuple[str, List[Any]]]] = {}
        processed_count_local = 0
        batch_num = 0
        last_progress_update_pct = 50

        try:
            async for trip_batch_docs in batch_cursor(
                trips_cursor, self.trip_batch_size
            ):
                batch_num += 1
                valid_trips_in_batch: List[Tuple[str, List[Any]]] = []

                # --- First Pass: Validate trips ---
                logger.debug(
                    f"Task {self.task_id}: Processing main trip batch {batch_num}..."
                )
                for trip_doc in trip_batch_docs:
                    trip_id = str(trip_doc["_id"])
                    if trip_id in processed_trip_ids_set:
                        continue

                    is_valid, coords = self._is_valid_trip(trip_doc.get("gps"))
                    if is_valid:
                        valid_trips_in_batch.append((trip_id, coords))
                    else:
                        processed_trip_ids_set.add(trip_id)

                if not valid_trips_in_batch:
                    logger.debug(
                        f"Task {self.task_id}: No valid trips in main batch {batch_num}."
                    )
                    continue

                # --- OPTIMIZATION: Process all trip coordinates at once to find all candidate segments ---
                # Create a MultiPoint from all trip points in this batch for efficient spatial query
                all_coords = []
                for _, coords in valid_trips_in_batch:
                    all_coords.extend(coords)

                batch_candidate_segment_ids = set()
                try:
                    if all_coords:
                        # Create a buffer around all points
                        multi_point = MultiPoint(all_coords)
                        # Convert buffer size from meters to degrees (approximate)
                        buffer_deg = (
                            self.match_buffer / 111000
                        )  # ~111km per degree at the equator
                        batch_bounds = multi_point.buffer(buffer_deg).bounds

                        # Query the R-tree index with the combined bounds
                        candidate_indices = list(
                            self.streets_index.intersection(batch_bounds)
                        )

                        # Get the segment IDs for these indices
                        for idx in candidate_indices:
                            if idx in self.streets_lookup:
                                batch_candidate_segment_ids.add(
                                    self.streets_lookup[idx]["segment_id"]
                                )
                except (GEOSException, ValueError, TypeError) as e:
                    logger.warning(
                        f"Task {self.task_id}: Error finding batch candidates: {e}. Using per-trip candidates."
                    )
                    # Fallback to per-trip candidates if batch approach fails
                    for trip_id, coords in valid_trips_in_batch:
                        try:
                            if coords:
                                multi_point = MultiPoint(coords)
                                buffer_deg = self.match_buffer / 111000
                                trip_bounds = multi_point.buffer(buffer_deg).bounds
                                candidate_indices = list(
                                    self.streets_index.intersection(trip_bounds)
                                )
                                for idx in candidate_indices:
                                    if idx in self.streets_lookup:
                                        batch_candidate_segment_ids.add(
                                            self.streets_lookup[idx]["segment_id"]
                                        )
                        except Exception:
                            pass

                if not batch_candidate_segment_ids:
                    logger.debug(
                        f"Task {self.task_id}: No candidate segments found for main batch {batch_num}."
                    )
                    processed_count_local += len(valid_trips_in_batch)
                    processed_trip_ids_set.update(
                        [tid for tid, _ in valid_trips_in_batch]
                    )
                    continue  # No point submitting workers if no candidates

                # --- Get geometries for all candidates at once ---
                # OPTIMIZATION: Use geometry cache instead of fetching from DB when possible
                batch_candidate_geoms_dict: Dict[str, Dict] = {}
                segments_to_fetch = []

                # First check our cache for geometries
                for seg_id in batch_candidate_segment_ids:
                    if seg_id in self.street_geoms_cache:
                        batch_candidate_geoms_dict[seg_id] = self.street_geoms_cache[
                            seg_id
                        ]
                    else:
                        segments_to_fetch.append(seg_id)

                # Only fetch geometries that aren't in cache
                if segments_to_fetch:
                    try:
                        geom_cursor = streets_collection.find(
                            {"properties.segment_id": {"$in": segments_to_fetch}},
                            {
                                "geometry": 1,
                                "properties.segment_id": 1,
                                "_id": 0,
                            },
                        ).batch_size(
                            min(5000, len(segments_to_fetch))
                        )  # Use appropriate batch size

                        async for street_doc in geom_cursor:
                            seg_id = street_doc.get("properties", {}).get("segment_id")
                            if seg_id and "geometry" in street_doc:
                                geom = street_doc["geometry"]
                                batch_candidate_geoms_dict[seg_id] = geom
                                # Update our cache for future use
                                self.street_geoms_cache[seg_id] = geom
                    except Exception as fetch_geom_err:
                        logger.error(
                            f"Task {self.task_id}: Failed to fetch batch candidate geometries: {fetch_geom_err}. Skipping main batch."
                        )
                        processed_count_local += len(valid_trips_in_batch)
                        processed_trip_ids_set.update(
                            [tid for tid, _ in valid_trips_in_batch]
                        )
                        continue

                # OPTIMIZATION: If we have too many geometries, split them to avoid memory issues in workers
                if len(batch_candidate_geoms_dict) > MAX_STREETS_PER_WORKER:
                    # Split into manageable chunks for workers
                    chunk_size = MAX_STREETS_PER_WORKER
                    seg_ids = list(batch_candidate_geoms_dict.keys())
                    geom_chunks = []

                    for i in range(0, len(seg_ids), chunk_size):
                        chunk = {
                            seg_id: batch_candidate_geoms_dict[seg_id]
                            for seg_id in seg_ids[i : i + chunk_size]
                        }
                        geom_chunks.append(chunk)

                    logger.info(
                        f"Task {self.task_id}: Split {len(batch_candidate_geoms_dict)} geometries into {len(geom_chunks)} chunks for workers."
                    )
                else:
                    geom_chunks = [batch_candidate_geoms_dict]

                # --- Prepare precomputed bounding boxes for workers if enabled ---
                precomputed_bboxes = None
                if ENABLE_PRECOMPUTE_BBOXES:
                    precomputed_bboxes = {}
                    for seg_id in batch_candidate_geoms_dict:
                        if seg_id in self.street_bbox_cache:
                            precomputed_bboxes[seg_id] = self.street_bbox_cache[seg_id]

                # --- Distribute the trips to worker processes ---
                logger.debug(
                    f"Task {self.task_id}: Submitting {len(valid_trips_in_batch)} trips to workers for main batch {batch_num}..."
                )

                # OPTIMIZATION: Process in larger sub-batches for better worker efficiency
                for i in range(
                    0, len(valid_trips_in_batch), self.trip_worker_sub_batch
                ):
                    sub_batch = valid_trips_in_batch[i : i + self.trip_worker_sub_batch]
                    sub_batch_coords = [coords for _, coords in sub_batch]
                    sub_batch_trip_ids = [tid for tid, _ in sub_batch]

                    # For each geometry chunk, submit a worker task
                    for chunk_idx, geom_chunk in enumerate(geom_chunks):
                        # Only process this if there are geometries to check
                        if not geom_chunk:
                            continue

                        if self.process_pool and self.max_workers > 0:
                            try:
                                # OPTIMIZATION: Pass precomputed bboxes to workers
                                # Only pass bboxes for segments in this chunk
                                if precomputed_bboxes:
                                    chunk_bboxes = {
                                        seg_id: precomputed_bboxes[seg_id]
                                        for seg_id in geom_chunk
                                        if seg_id in precomputed_bboxes
                                    }
                                else:
                                    chunk_bboxes = None

                                future = self.process_pool.submit(
                                    process_trip_worker,
                                    sub_batch_coords,
                                    geom_chunk,
                                    self.utm_proj.to_string(),
                                    WGS84.to_string(),
                                    self.match_buffer,
                                    self.min_match_length,
                                    chunk_bboxes,
                                )
                                pending_futures_map[future] = sub_batch
                            except Exception as submit_err:
                                logger.error(
                                    f"Task {self.task_id}: Error submitting sub-batch: {submit_err}"
                                )
                                processed_count_local += len(sub_batch)
                                processed_trip_ids_set.update(sub_batch_trip_ids)
                        else:  # Sequential Fallback
                            try:
                                # Pass precomputed bboxes if available
                                if precomputed_bboxes:
                                    chunk_bboxes = {
                                        seg_id: precomputed_bboxes[seg_id]
                                        for seg_id in geom_chunk
                                        if seg_id in precomputed_bboxes
                                    }
                                else:
                                    chunk_bboxes = None

                                result_map = process_trip_worker(
                                    sub_batch_coords,
                                    geom_chunk,
                                    self.utm_proj.to_string(),
                                    WGS84.to_string(),
                                    self.match_buffer,
                                    self.min_match_length,
                                    chunk_bboxes,
                                )
                                for (
                                    trip_idx,
                                    matched_ids,
                                ) in result_map.items():
                                    if isinstance(matched_ids, set):
                                        self.newly_covered_segments.update(matched_ids)
                                processed_count_local += len(sub_batch)
                                processed_trip_ids_set.update(sub_batch_trip_ids)
                            except Exception as seq_err:
                                logger.error(
                                    f"Task {self.task_id}: Error sequential processing: {seq_err}"
                                )
                                processed_count_local += len(sub_batch)
                                processed_trip_ids_set.update(sub_batch_trip_ids)

                # --- OPTIMIZATION: Process more completed futures before moving to next batch ---
                # This helps reduce memory pressure by clearing results earlier
                if (
                    pending_futures_map
                    and len(pending_futures_map) > self.max_workers * 2
                ):
                    logger.debug(
                        f"Task {self.task_id}: Processing {len(pending_futures_map)} pending futures..."
                    )
                    done_futures = []
                    # Check which futures are completed
                    for future in list(pending_futures_map.keys()):
                        if future.done():
                            done_futures.append(future)

                    # Process completed futures
                    for future in done_futures:
                        original_sub_batch = pending_futures_map.pop(future, [])
                        sub_batch_trip_ids = [tid for tid, _ in original_sub_batch]
                        try:
                            result_map = future.result(
                                timeout=0.1
                            )  # Short timeout as it should be done
                            for trip_idx, matched_ids in result_map.items():
                                if isinstance(matched_ids, set):
                                    self.newly_covered_segments.update(matched_ids)
                            processed_count_local += len(original_sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)
                        except (TimeoutError, CancelledError, Exception) as e:
                            logger.error(
                                f"Task {self.task_id}: Error getting result from future: {type(e).__name__}. Marking processed."
                            )
                            processed_count_local += len(original_sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)

                # --- Update Progress ---
                self.processed_trips_count = processed_count_local
                if self.total_trips_to_process > 0:
                    current_progress_pct = 50 + (
                        processed_count_local / self.total_trips_to_process * 40
                    )
                else:
                    current_progress_pct = 90

                # OPTIMIZATION: Less frequent progress updates
                if (batch_num % PROGRESS_UPDATE_INTERVAL_TRIPS == 0) or (
                    processed_count_local >= self.total_trips_to_process
                ):
                    if (current_progress_pct - last_progress_update_pct >= 1) or (
                        processed_count_local >= self.total_trips_to_process
                    ):
                        await self.update_progress(
                            "processing_trips",
                            current_progress_pct,
                            f"Processed {processed_count_local}/{self.total_trips_to_process} trips",
                        )
                        last_progress_update_pct = current_progress_pct
                        await asyncio.sleep(BATCH_PROCESS_DELAY)

            # --- Process Any Remaining Futures After Loop ---
            if pending_futures_map:
                logger.info(
                    f"Task {self.task_id}: Processing {len(pending_futures_map)} remaining trip futures..."
                )
                # OPTIMIZATION: Process remaining futures in batches to avoid memory spikes
                remaining_futures_chunks = [
                    list(pending_futures_map.keys())[i : i + self.max_workers]
                    for i in range(0, len(pending_futures_map), self.max_workers)
                ]

                for chunk_idx, futures_chunk in enumerate(remaining_futures_chunks):
                    # Wrap concurrent futures for asyncio.wait
                    wrapped_futures = [asyncio.wrap_future(f) for f in futures_chunk]

                    try:
                        # Wait for this chunk of futures with a reasonable timeout
                        chunk_wait_timeout = (
                            PROCESS_TIMEOUT_WORKER * 2
                        )  # Give extra time for stragglers
                        done, pending = await asyncio.wait(
                            wrapped_futures,
                            timeout=chunk_wait_timeout,
                            return_when=asyncio.ALL_COMPLETED,
                        )

                        # Process completed futures
                        for wrapped_done_future in done:
                            # Find the original future
                            original_future = futures_chunk[
                                wrapped_futures.index(wrapped_done_future)
                            ]
                            original_sub_batch = pending_futures_map.pop(
                                original_future, []
                            )
                            sub_batch_trip_ids = [tid for tid, _ in original_sub_batch]

                            try:
                                result_map = wrapped_done_future.result()
                                for (
                                    trip_idx,
                                    matched_ids,
                                ) in result_map.items():
                                    if isinstance(matched_ids, set):
                                        self.newly_covered_segments.update(matched_ids)
                                processed_count_local += len(original_sub_batch)
                                processed_trip_ids_set.update(sub_batch_trip_ids)
                            except Exception as e:
                                logger.error(
                                    f"Task {self.task_id}: Final worker error: {type(e).__name__}. Marking processed."
                                )
                                processed_count_local += len(original_sub_batch)
                                processed_trip_ids_set.update(sub_batch_trip_ids)

                        # Handle any futures that timed out
                        for wrapped_pending_future in pending:
                            original_future = futures_chunk[
                                wrapped_futures.index(wrapped_pending_future)
                            ]
                            original_sub_batch = pending_futures_map.pop(
                                original_future, []
                            )
                            sub_batch_trip_ids = [tid for tid, _ in original_sub_batch]

                            logger.error(
                                f"Task {self.task_id}: Timeout for future in chunk {chunk_idx + 1}/{len(remaining_futures_chunks)}. Marking processed."
                            )
                            processed_count_local += len(original_sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)
                            try:
                                wrapped_pending_future.cancel()
                                original_future.cancel()
                            except Exception:
                                pass

                    except Exception as chunk_err:
                        logger.error(
                            f"Task {self.task_id}: Error processing future chunk {chunk_idx + 1}/{len(remaining_futures_chunks)}: {chunk_err}"
                        )
                        # Mark all futures in this chunk as processed
                        for future in futures_chunk:
                            if future in pending_futures_map:
                                batch_data = pending_futures_map.pop(future, [])
                                ids = [tid for tid, _ in batch_data]
                                processed_count_local += len(batch_data)
                                processed_trip_ids_set.update(ids)
                                try:
                                    future.cancel()
                                except Exception:
                                    pass

            # Handle any remaining futures in map (shouldn't happen, but just in case)
            for future, batch_data in list(pending_futures_map.items()):
                ids = [tid for tid, _ in batch_data]
                processed_count_local += len(batch_data)
                processed_trip_ids_set.update(ids)
                try:
                    future.cancel()
                except Exception:
                    pass
            pending_futures_map.clear()

            self.processed_trips_count = processed_count_local
            logger.info(
                "Task %s: Finished processing trips for %s. Processed: %d/%d. Newly covered segments found: %d.",
                self.task_id,
                self.location_name,
                self.processed_trips_count,
                self.total_trips_to_process,
                len(self.newly_covered_segments),
            )
            return True

        except Exception as e:
            logger.error(
                "Task %s: Critical error during trip processing loop for %s: %s",
                self.task_id,
                self.location_name,
                e,
                exc_info=True,
            )
            await self.update_progress("error", 50, f"Error processing trips: {e}")
            return False
        finally:
            # Ensure cursor is closed
            if "trips_cursor" in locals() and hasattr(trips_cursor, "close"):
                await trips_cursor.close()
            # Shutdown workers after processing all trips
            await self.shutdown_workers()

    async def finalize_coverage(
        self, processed_trip_ids_set: Set[str]
    ) -> Optional[Dict[str, Any]]:
        """Updates the 'driven' status of streets in the database based on
        newly covered segments, calculates final coverage statistics incrementally,
        and updates the coverage metadata document.

        Args:
            processed_trip_ids_set: The complete set of trip IDs processed up to this point.

        Returns:
            A dictionary containing the final coverage statistics (total_length, driven_length,
            coverage_percentage, total_segments, street_types), or None if finalization failed.
            Does NOT include the full GeoJSON data or its GridFS ID.
        """
        await self.update_progress(
            "finalizing",
            90,
            f"Updating street statuses for {self.location_name}...",
        )

        # --- Bulk Update Driven Status ---
        # Identify segments that were not driven before but are now covered by this run
        segments_to_update = list(
            self.newly_covered_segments - self.initial_covered_segments
        )

        if segments_to_update:
            logger.info(
                "Task %s: Updating 'driven' status for %d newly covered segments...",
                self.task_id,
                len(segments_to_update),
            )
            try:
                # OPTIMIZATION: Split into smaller chunks if too many segments to update at once
                max_update_batch = 10000  # MongoDB has limits on update size
                for i in range(0, len(segments_to_update), max_update_batch):
                    segment_batch = segments_to_update[i : i + max_update_batch]

                    # Use retry wrapper for DB operation
                    update_result = await update_many_with_retry(
                        streets_collection,
                        {"properties.segment_id": {"$in": segment_batch}},
                        {
                            "$set": {
                                "properties.driven": True,
                                "properties.last_coverage_update": datetime.now(
                                    timezone.utc
                                ),
                            }
                        },
                    )
                    logger.info(
                        "Task %s: Bulk update batch %d result: Matched=%d, Modified=%d",
                        self.task_id,
                        i // max_update_batch + 1,
                        update_result.matched_count,
                        update_result.modified_count,
                    )

                    # Brief pause to allow other operations
                    await asyncio.sleep(BATCH_PROCESS_DELAY)

            except BulkWriteError as bwe:
                logger.error(
                    "Task %s: Bulk write error updating street status: %s",
                    self.task_id,
                    bwe.details,
                )
            except Exception as e:
                logger.error(
                    "Task %s: Error bulk updating street status: %s",
                    self.task_id,
                    e,
                    exc_info=True,
                )
                await self.update_progress("error", 90, f"Error updating DB: {e}")
                return None
        else:
            logger.info(
                "Task %s: No new segments to mark as driven for %s.",
                self.task_id,
                self.location_name,
            )

        # --- Calculate Final Stats Incrementally ---
        await self.update_progress(
            "finalizing",
            95,
            f"Calculating final statistics incrementally for {self.location_name}...",
        )
        try:
            final_total_length = self.total_length_calculated
            final_driven_length = self.initial_driven_length
            final_total_segments = len(self.streets_lookup)

            # OPTIMIZATION: Use defaultdict with a lambda function that creates the inner dict structure
            street_type_stats = defaultdict(
                lambda: {
                    "total": 0,
                    "covered": 0,
                    "length": 0.0,
                    "covered_length": 0.0,
                }
            )

            # OPTIMIZATION: Precompute driven status for each segment for faster lookup
            is_driven_map = {}
            for segment_id in self.initial_covered_segments:
                is_driven_map[segment_id] = True
            for segment_id in self.newly_covered_segments:
                is_driven_map[segment_id] = True

            for rtree_id, street_info in self.streets_lookup.items():
                segment_id = street_info["segment_id"]
                length = street_info["length_m"]
                highway = street_info["highway"]

                is_driven = is_driven_map.get(segment_id, False)

                street_type_stats[highway]["total"] += 1
                street_type_stats[highway]["length"] += length

                if is_driven:
                    street_type_stats[highway]["covered"] += 1
                    street_type_stats[highway]["covered_length"] += length
                    if (
                        segment_id in self.newly_covered_segments
                        and segment_id not in self.initial_covered_segments
                    ):
                        final_driven_length += length

            final_street_types = []
            for highway_type, stats in street_type_stats.items():
                coverage_pct = (
                    (stats["covered_length"] / stats["length"] * 100)
                    if stats["length"] > 0
                    else 0
                )
                final_street_types.append(
                    {
                        "type": highway_type,
                        "total": stats["total"],
                        "covered": stats["covered"],
                        "length": stats["length"],
                        "covered_length": stats["covered_length"],
                        "coverage_percentage": coverage_pct,
                    }
                )
            final_street_types.sort(key=lambda x: x["length"], reverse=True)

            final_coverage_percentage = (
                (final_driven_length / final_total_length * 100)
                if final_total_length > 0
                else 0
            )

            coverage_stats = {
                "total_length": final_total_length,
                "driven_length": final_driven_length,
                "coverage_percentage": final_coverage_percentage,
                "total_segments": final_total_segments,
                "street_types": final_street_types,
            }
            logger.info(
                f"Task {self.task_id}: Incremental stats calculated: {final_coverage_percentage:.2f}% coverage."
            )

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error calculating final stats incrementally: {e}",
                exc_info=True,
            )
            await self.update_progress("error", 95, f"Error calculating stats: {e}")
            return None

        # --- Update Metadata Document ---
        logger.info(
            "Task %s: Updating coverage metadata for %s...",
            self.task_id,
            self.location_name,
        )
        try:
            # OPTIMIZATION: Only store processed trip IDs if they're not too numerous
            # MongoDB has document size limits of 16MB
            trip_ids_to_store = list(processed_trip_ids_set)
            trip_ids_too_large = len(trip_ids_to_store) > 100000  # Arbitrary threshold

            update_doc = {
                "$set": {
                    "total_length": coverage_stats["total_length"],
                    "driven_length": coverage_stats["driven_length"],
                    "coverage_percentage": coverage_stats["coverage_percentage"],
                    "street_types": coverage_stats["street_types"],
                    "total_segments": coverage_stats["total_segments"],
                    "last_updated": datetime.now(timezone.utc),
                    "status": "completed_stats",
                    "last_error": None,
                    "processed_trips.last_processed_timestamp": datetime.now(
                        timezone.utc
                    ),
                    "processed_trips.count": len(processed_trip_ids_set),
                },
                "$unset": {"streets_data": ""},
            }

            # Only store trip IDs if they're not too numerous
            if not trip_ids_too_large:
                update_doc["$set"]["processed_trips.trip_ids"] = trip_ids_to_store
            else:
                # If too many trip IDs, just store the count
                logger.warning(
                    f"Task {self.task_id}: Too many trip IDs ({len(trip_ids_to_store)}) to store in metadata document. Storing count only."
                )
                update_doc["$unset"]["processed_trips.trip_ids"] = ""

            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": self.location_name},
                update_doc,
                upsert=True,
            )
            logger.info(
                "Task %s: Coverage metadata updated for %s.",
                self.task_id,
                self.location_name,
            )
        except Exception as e:
            logger.error(
                "Task %s: Error updating coverage metadata: %s",
                self.task_id,
                e,
                exc_info=True,
            )

        # --- Prepare Result Dictionary ---
        final_result = {
            "total_length": coverage_stats["total_length"],
            "driven_length": coverage_stats["driven_length"],
            "coverage_percentage": coverage_stats["coverage_percentage"],
            "total_segments": coverage_stats["total_segments"],
            "street_types": coverage_stats["street_types"],
            "run_details": {
                "newly_covered_segment_count": len(segments_to_update),
                "total_processed_trips_in_run": self.processed_trips_count,
            },
        }

        await self.update_progress(
            "complete_stats", 98, "Coverage statistics calculated."
        )
        logger.info(
            "Task %s: Coverage statistics calculation complete for %s.",
            self.task_id,
            self.location_name,
        )
        return final_result

    async def compute_coverage(
        self, run_incremental: bool = False
    ) -> Optional[Dict[str, Any]]:
        """Main orchestrator method to compute coverage statistics.

        Handles initialization, index building, trip processing (full or incremental),
        and finalization.

        Args:
            run_incremental: If True, loads previously processed trip IDs and only processes
                             new trips. If False, performs a full calculation (still
                             respecting the 'driven' status from previous runs).

        Returns:
            A dictionary containing the final coverage statistics, or None if a critical
            error occurred during the process. Does NOT include the full GeoJSON or GridFS ID.
        """
        start_time = datetime.now(timezone.utc)
        run_type = "incremental" if run_incremental else "full"
        logger.info(
            "Task %s: Starting %s coverage computation for %s",
            self.task_id,
            run_type,
            self.location_name,
        )

        try:
            await self.update_progress(
                "initializing", 0, f"Initializing {run_type} calculation..."
            )

            # --- Step 0: Initialize Projections ---
            try:
                self.initialize_projections()
            except ValueError as proj_err:
                logger.error(
                    "Task %s: Projection initialization failed: %s",
                    self.task_id,
                    proj_err,
                )
                await self.update_progress("error", 0, f"Projection Error: {proj_err}")
                return None

            # --- Step 1: Build Index & Get Initial State ---
            index_success = await self.build_spatial_index_and_stats()
            if not index_success:
                logger.error(
                    "Task %s: Failed during spatial index build for %s.",
                    self.task_id,
                    self.location_name,
                )
                return None
            if (
                self.total_length_calculated == 0
                and self.streets_index.count(self.streets_index.bounds) == 0
            ):
                logger.info(
                    "Task %s: No valid streets found for %s. Reporting 0%% coverage.",
                    self.task_id,
                    self.location_name,
                )
                processed_trip_ids_set: Set[str] = set()
            else:
                # --- Step 2: Determine Processed Trips ---
                processed_trip_ids_set = set()
                if run_incremental:
                    try:
                        metadata = await find_one_with_retry(
                            coverage_metadata_collection,
                            {"location.display_name": self.location_name},
                            {
                                "processed_trips.trip_ids": 1,
                                "processed_trips.count": 1,
                            },
                        )
                        if metadata and "processed_trips" in metadata:
                            if "trip_ids" in metadata["processed_trips"]:
                                trip_ids_data = metadata["processed_trips"]["trip_ids"]
                                if isinstance(trip_ids_data, (list, set)):
                                    processed_trip_ids_set = set(trip_ids_data)
                                    logger.info(
                                        "Task %s: Loaded %d previously processed trip IDs for incremental run.",
                                        self.task_id,
                                        len(processed_trip_ids_set),
                                    )
                                else:
                                    logger.warning(
                                        "Task %s: 'processed_trips.trip_ids' not list/set. Running as full.",
                                        self.task_id,
                                    )
                            elif "count" in metadata["processed_trips"]:
                                # We know count but don't have IDs - warn but continue as incremental
                                # We'll need to look up trips by other means
                                logger.warning(
                                    "Task %s: Found processed trip count (%d) but no IDs. Using alternative incremental strategy.",
                                    self.task_id,
                                    metadata["processed_trips"]["count"],
                                )
                                # TODO: Implement alternative strategy if needed
                            else:
                                logger.warning(
                                    "Task %s: No previous processed trips found. Running as full.",
                                    self.task_id,
                                )
                        else:
                            logger.warning(
                                "Task %s: No previous processed trips found. Running as full.",
                                self.task_id,
                            )
                    except Exception as meta_err:
                        logger.error(
                            "Task %s: Error loading processed trips: %s. Running as full.",
                            self.task_id,
                            meta_err,
                        )
                else:
                    logger.info(
                        "Task %s: Starting full coverage run for %s.",
                        self.task_id,
                        self.location_name,
                    )

                # --- Step 3: Process Trips ---
                trips_success = await self.process_trips(processed_trip_ids_set)
                if not trips_success:
                    logger.error(
                        "Task %s: Failed during trip processing stage for %s.",
                        self.task_id,
                        self.location_name,
                    )
                    return None

            # --- Step 4: Finalize and Update ---
            final_stats = await self.finalize_coverage(processed_trip_ids_set)

            end_time = datetime.now(timezone.utc)
            duration = (end_time - start_time).total_seconds()
            logger.info(
                "Task %s: Coverage computation (%s) for %s finished in %.2f seconds.",
                self.task_id,
                run_type,
                self.location_name,
                duration,
            )

            return final_stats

        except Exception as e:
            logger.error(
                "Task %s: Unhandled error in compute_coverage for %s: %s",
                self.task_id,
                self.location_name,
                e,
                exc_info=True,
            )
            await self.update_progress("error", 0, f"Unhandled error: {e}")
            return None
        finally:
            # --- Cleanup ---
            await self.shutdown_workers()
            # Clear memory caches
            self.streets_lookup = {}
            self.street_geoms_cache = {}
            self.street_bbox_cache = {}
            if self.streets_index:
                try:
                    self.streets_index.close()
                except Exception as rtree_close_err:
                    logger.warning(f"Error closing R-tree index: {rtree_close_err}")
                self.streets_index = None
            logger.debug(
                "Task %s: Cleanup completed for %s.",
                self.task_id,
                self.location_name,
            )


# --- Top-Level Functions (Called by Celery tasks or API endpoints) ---


async def compute_coverage_for_location(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """High-level function to compute full coverage for a specific location.
    Instantiates CoverageCalculator and runs the full computation.

    Args:
        location: Location dictionary.
        task_id: Task identifier for progress tracking.

    Returns:
        Coverage statistics dictionary or None if an error occurred.
        Does NOT include the full GeoJSON data or its GridFS ID.
    """
    location_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Task %s: Received request for full coverage calculation for %s",
        task_id,
        location_name,
    )
    calculator = None
    try:
        await ensure_street_coverage_indexes()
        calculator = CoverageCalculator(location, task_id)
        result = await asyncio.wait_for(
            calculator.compute_coverage(run_incremental=False),
            timeout=PROCESS_TIMEOUT_OVERALL,
        )

        if result:
            asyncio.create_task(generate_and_store_geojson(location_name, task_id))
            return result
        logger.error(
            "Task %s: Full coverage calculation failed for %s",
            task_id,
            location_name,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {"$set": {"status": "error", "last_error": "Calculation failed"}},
            upsert=False,
        )
        return None

    except asyncio.TimeoutError:
        error_msg = f"Calculation timed out after {PROCESS_TIMEOUT_OVERALL}s"
        logger.error(
            "Task %s: Full coverage calculation for %s timed out.",
            task_id,
            location_name,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": "Operation timed out",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": error_msg,
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        return None
    except Exception as e:
        error_msg = f"Unexpected error: {e}"
        logger.exception(
            "Task %s: Error in compute_coverage_for_location wrapper for %s: %s",
            task_id,
            location_name,
            e,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": str(e),
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": str(e),
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        return None
    finally:
        if calculator:
            await calculator.shutdown_workers()
            calculator.streets_lookup = {}
            calculator.street_geoms_cache = {}
            calculator.street_bbox_cache = {}
            if calculator.streets_index:
                try:
                    calculator.streets_index.close()
                except Exception as rtree_close_err:
                    logger.warning(f"Error closing R-tree index: {rtree_close_err}")
                calculator.streets_index = None


async def compute_incremental_coverage(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """High-level function to compute incremental coverage update for a
    specific location. Instantiates CoverageCalculator and runs the incremental
    computation.

    Args:
        location: Location dictionary.
        task_id: Task identifier for progress tracking.

    Returns:
        Coverage statistics dictionary or None if an error occurred.
        Does NOT include the full GeoJSON data or its GridFS ID.
    """
    location_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Task %s: Received request for incremental coverage update for %s",
        task_id,
        location_name,
    )
    calculator = None
    try:
        await ensure_street_coverage_indexes()
        metadata_exists = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {"_id": 1},
        )
        if not metadata_exists:
            logger.warning(
                "Task %s: No metadata found for %s. Calculation will run as full.",
                task_id,
                location_name,
            )

        calculator = CoverageCalculator(location, task_id)
        result = await asyncio.wait_for(
            calculator.compute_coverage(run_incremental=True),
            timeout=PROCESS_TIMEOUT_INCREMENTAL,
        )

        if result:
            asyncio.create_task(generate_and_store_geojson(location_name, task_id))
            return result
        logger.error(
            "Task %s: Incremental coverage calculation failed for %s",
            task_id,
            location_name,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": "Incremental calculation failed",
                }
            },
            upsert=False,
        )
        return None

    except asyncio.TimeoutError:
        error_msg = (
            f"Incremental calculation timed out after {PROCESS_TIMEOUT_INCREMENTAL}s"
        )
        logger.error(
            "Task %s: Incremental coverage for %s timed out.",
            task_id,
            location_name,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": "Operation timed out",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": error_msg,
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        return None
    except Exception as e:
        error_msg = f"Unexpected error: {e}"
        logger.exception(
            "Task %s: Error in compute_incremental_coverage wrapper for %s: %s",
            task_id,
            location_name,
            e,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": str(e),
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": str(e),
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        return None
    finally:
        if calculator:
            await calculator.shutdown_workers()
            calculator.streets_lookup = {}
            calculator.street_geoms_cache = {}
            calculator.street_bbox_cache = {}
            if calculator.streets_index:
                try:
                    calculator.streets_index.close()
                except Exception as rtree_close_err:
                    logger.warning(f"Error closing R-tree index: {rtree_close_err}")
                calculator.streets_index = None


async def generate_and_store_geojson(
    location_name: Optional[str], task_id: str
) -> None:
    """Generates the final GeoJSON output based on the current state of streets
    in the database for a given location and stores it in GridFS, updating the
    corresponding coverage_metadata document with the GridFS file ID.

    Args:
        location_name: The display name of the location.
        task_id: The ID of the original calculation task (for progress updates).
    """
    if not location_name:
        logger.error(
            "Task %s: Cannot generate GeoJSON, location name is missing.",
            task_id,
        )
        return

    logger.info(
        "Task %s: Starting GeoJSON generation for %s...",
        task_id,
        location_name,
    )
    await progress_collection.update_one(
        {"_id": task_id},
        {
            "$set": {
                "stage": "generating_geojson",
                "message": "Generating final GeoJSON output...",
            }
        },
    )

    features = []
    # OPTIMIZATION: Use larger batch size for streets cursor
    streets_cursor = streets_collection.find(
        {"properties.location": location_name},
        {"geometry": 1, "properties": 1, "_id": 0},
    ).batch_size(
        5000
    )  # Increased batch size

    batch_num = 0
    total_features = 0
    file_id = None

    try:
        async for street_batch in batch_cursor(
            streets_cursor, 5000
        ):  # Increased batch size
            batch_num += 1
            batch_features = []  # Process features in a batch first

            for street in street_batch:
                feature = {
                    "type": "Feature",
                    "geometry": street.get("geometry"),
                    "properties": street.get("properties", {}),
                }
                props = feature["properties"]
                props["segment_id"] = props.get(
                    "segment_id", f"missing_{total_features}"
                )
                props["driven"] = props.get("driven", False)
                props["highway"] = props.get("highway", "unknown")
                props["segment_length"] = props.get("segment_length", 0.0)
                batch_features.append(feature)
                total_features += 1

            features.extend(batch_features)

            # Brief yield to allow other operations
            if batch_num % 5 == 0:  # Update less frequently
                await asyncio.sleep(0.01)

        logger.info(
            "Task %s: Generated %d features for %s GeoJSON.",
            task_id,
            total_features,
            location_name,
        )

        if total_features == 0:
            logger.warning(
                "Task %s: No street features found for %s to generate GeoJSON.",
                task_id,
                location_name,
            )
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "completed",
                        "last_updated": datetime.now(timezone.utc),
                        "streets_geojson_gridfs_id": None,
                    },
                    "$unset": {"streets_data": ""},
                },
            )
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "complete",
                        "progress": 100,
                        "message": "GeoJSON generation complete (0 features).",
                    }
                },
            )
            return

        metadata_stats = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "total_length": 1,
                "driven_length": 1,
                "coverage_percentage": 1,
                "street_types": 1,
            },
        )
        if not metadata_stats:
            logger.error(
                "Task %s: Could not retrieve metadata stats for %s.",
                task_id,
                location_name,
            )
            metadata_stats = {}

        streets_geojson = {
            "type": "FeatureCollection",
            "features": features,
            "metadata": {
                "total_length": metadata_stats.get("total_length", 0),
                "driven_length": metadata_stats.get("driven_length", 0),
                "coverage_percentage": metadata_stats.get("coverage_percentage", 0),
                "street_types": metadata_stats.get("street_types", []),
                "geojson_generated_at": datetime.now(timezone.utc).isoformat(),
                "total_features": total_features,
            },
        }

        logger.info(
            "Task %s: Storing GeoJSON for %s in GridFS...",
            task_id,
            location_name,
        )
        try:
            fs = db_manager.gridfs_bucket
            # Use standard JSON serialization
            geojson_bytes = bson.json_util.dumps(streets_geojson).encode("utf-8")
            gridfs_filename = (
                f"{location_name.replace(' ', '_').replace(',', '')}_streets.geojson"
            )

            # OPTIMIZATION: Set appropriate chunk size for large files
            file_id = await fs.upload_from_stream(
                gridfs_filename,
                geojson_bytes,
                metadata={
                    "contentType": "application/json",
                    "location": location_name,
                    "features_count": total_features,
                    "generated_at": datetime.now(timezone.utc),
                },
            )
            logger.info(
                "Task %s: Successfully stored GeoJSON in GridFS for %s with file_id: %s",
                task_id,
                location_name,
                file_id,
            )

            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "streets_geojson_gridfs_id": file_id,
                        "status": "completed",
                        "last_updated": datetime.now(timezone.utc),
                    },
                    "$unset": {"streets_data": ""},
                },
            )
            logger.info(
                "Task %s: Updated metadata for %s with GridFS ID.",
                task_id,
                location_name,
            )

            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "complete",
                        "progress": 100,
                        "message": "GeoJSON generation complete.",
                    }
                },
            )

        except Exception as store_err:
            error_msg = f"Error storing GeoJSON or updating metadata: {store_err}"
            logger.error("Task %s: %s", task_id, error_msg, exc_info=True)
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "message": error_msg,
                        "error": str(store_err),
                    }
                },
            )
            await coverage_metadata_collection.update_one(
                {"location.display_name": location_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"GeoJSON storage failed: {store_err}",
                    }
                },
            )

    except Exception as e:
        error_msg = f"Error generating GeoJSON features: {e}"
        logger.error("Task %s: %s", task_id, error_msg, exc_info=True)
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": str(e),
                }
            },
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"GeoJSON generation failed: {e}",
                }
            },
        )
    finally:
        if "streets_cursor" in locals() and hasattr(streets_cursor, "close"):
            await streets_cursor.close()
