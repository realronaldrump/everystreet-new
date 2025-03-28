# street_coverage_calculation.py
"""
Street coverage calculation module (Optimized).

Calculates street segment coverage based on trip data using efficient spatial indexing,
multiprocessing, bulk database operations, and aggregation pipelines.
Designed for drastically improved speed and reduced memory usage compared to previous versions.
"""

import asyncio
import json
import logging
import multiprocessing
import os
from collections import defaultdict
from concurrent.futures import Future, ProcessPoolExecutor, TimeoutError
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import pyproj
import rtree  # Ensure rtree>=1.0.0 is installed
from bson import ObjectId
from dotenv import load_dotenv
from pymongo import MongoClient  # Needed for worker connection
from pymongo.errors import (
    BulkWriteError,
    ConnectionFailure,
    ServerSelectionTimeoutError,
)
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPoint, shape
from shapely.ops import transform

# Assuming db.py provides these helpers and the db_manager instance
from db import (
    aggregate_with_retry,
    batch_cursor,
    count_documents_with_retry,
    coverage_metadata_collection,
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
MAX_STREETS_PER_INDEX_BATCH = 5000  # Batch size for reading streets during indexing
MAX_TRIPS_PER_BATCH = 100  # How many trips to fetch from DB at once
TRIP_WORKER_SUB_BATCH = 20  # How many trips a single worker process handles
BATCH_PROCESS_DELAY = 0.05  # Small delay to yield event loop control
PROCESS_TIMEOUT_WORKER = (
    180  # Timeout for a single worker task (seconds) - Increased slightly
)
PROCESS_TIMEOUT_OVERALL = 3600 * 2  # Overall timeout for a full calculation (2 hours)
PROCESS_TIMEOUT_INCREMENTAL = 3600  # Overall timeout for incremental (1 hour)
PROGRESS_UPDATE_INTERVAL_TRIPS = 5  # Update progress every N trip batches processed

# Default number of worker processes for coverage calculation
# Can be overridden by MAX_COVERAGE_WORKERS environment variable
# Crucial: Balance this with CELERY_WORKER_CONCURRENCY in deployment
MAX_WORKERS_DEFAULT = max(1, multiprocessing.cpu_count() - 1)

# --- Worker Function (Top-Level for Pickling) ---


def process_trip_worker(
    trip_coords_list: List[List[Any]],
    candidate_segment_ids_map: Dict[int, List[str]],
    utm_proj_string: str,
    wgs84_proj_string: str,
    match_buffer: float,
    min_match_length: float,
    db_connection_string: str,
    db_name: str,
    streets_collection_name: str,
) -> Dict[int, Set[str]]:
    """
    Static worker function for multiprocessing. Processes a sub-batch of trips.
    Fetches required street geometries from DB based on candidate IDs.

    Args:
        trip_coords_list: List of coordinate lists for multiple trips in this sub-batch.
        candidate_segment_ids_map: Maps trip index (within sub-batch) to its candidate segment IDs.
        utm_proj_string: PROJ string for the UTM projection.
        wgs84_proj_string: PROJ string for WGS84.
        match_buffer: Buffer distance in UTM units (meters).
        min_match_length: Minimum intersection length in UTM units (meters).
        db_connection_string: MongoDB connection URI.
        db_name: Name of the MongoDB database.
        streets_collection_name: Name of the streets collection.

    Returns:
        A dictionary mapping the original trip index (within the sub-batch) to a set
        of matched segment IDs for that trip.
    """
    # Worker-specific logger configuration (optional, helps trace worker activity)
    # logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(processName)s - %(message)s')
    # worker_logger = logging.getLogger(__name__ + ".worker")

    results: Dict[int, Set[str]] = defaultdict(set)
    mongo_client = None
    streets_col = None

    try:
        # --- Establish DB Connection ---
        try:
            # Create a new client connection within the worker process
            mongo_client = MongoClient(
                db_connection_string,
                serverSelectionTimeoutMS=10000,  # Reasonable timeout for worker
                connectTimeoutMS=5000,
                socketTimeoutMS=30000,
                appname="CoverageWorker",  # Identify worker connections
            )
            # Ping to ensure connection is established before proceeding
            mongo_client.admin.command("ping")
            db = mongo_client[db_name]
            streets_col = db[streets_collection_name]
            # worker_logger.info("Worker connected to DB.")
        except (ConnectionFailure, ServerSelectionTimeoutError):
            # worker_logger.error(f"Worker failed to connect to DB: {db_conn_err}")
            # Cannot proceed without DB connection
            return {}  # Return empty results if DB connection fails

        # --- Prepare Projections ---
        try:
            utm_proj = pyproj.CRS.from_string(utm_proj_string)
            wgs84_proj = pyproj.CRS.from_string(wgs84_proj_string)
            project_to_utm = pyproj.Transformer.from_crs(
                wgs84_proj, utm_proj, always_xy=True
            ).transform
        except pyproj.exceptions.CRSError:
            # worker_logger.error(f"Worker failed to create projections: {proj_err}")
            return {}  # Cannot proceed without projections

        # --- Fetch Required Street Geometries ---
        all_needed_segment_ids = set()
        for segment_ids in candidate_segment_ids_map.values():
            all_needed_segment_ids.update(segment_ids)

        if not all_needed_segment_ids:
            # worker_logger.info("Worker: No candidate segments needed.")
            return {}

        street_data_map: Dict[str, Dict] = {}
        try:
            # Fetch only necessary fields
            cursor = streets_col.find(
                {"properties.segment_id": {"$in": list(all_needed_segment_ids)}},
                {"geometry": 1, "properties.segment_id": 1, "_id": 0},
            )
            for street_doc in cursor:
                seg_id = street_doc.get("properties", {}).get("segment_id")
                if seg_id:
                    street_data_map[seg_id] = street_doc
            # worker_logger.debug(f"Worker fetched {len(street_data_map)} street geometries.")
        except Exception:
            # worker_logger.error(f"Worker DB Error fetching streets: {db_err}")
            return {}  # Fail gracefully for this batch if DB read fails

        # --- Pre-transform Street Geometries to UTM ---
        street_utm_geoms: Dict[str, Any] = {}
        for seg_id, street_doc in street_data_map.items():
            try:
                geom_wgs84 = shape(street_doc["geometry"])
                street_utm_geoms[seg_id] = transform(project_to_utm, geom_wgs84)
            except (GEOSException, ValueError, TypeError):
                # worker_logger.warning(f"Worker: Error transforming street {seg_id}: {geom_err}")
                continue  # Skip problematic street geometry

        # --- Process Each Trip ---
        for trip_index, trip_coords in enumerate(trip_coords_list):
            candidate_segment_ids = candidate_segment_ids_map.get(trip_index, [])
            if len(trip_coords) < 2 or not candidate_segment_ids:
                continue

            try:
                trip_line_wgs84 = LineString(trip_coords)
                trip_line_utm = transform(project_to_utm, trip_line_wgs84)
                trip_buffer_utm = trip_line_utm.buffer(match_buffer)

                # Check intersection only against candidate streets for this trip
                for seg_id in candidate_segment_ids:
                    street_utm_geom = street_utm_geoms.get(seg_id)
                    if not street_utm_geom:
                        continue  # Geometry was problematic or not found

                    # Optimization: Bounding box check before precise intersection
                    # Useful if street geometries are complex.
                    if not trip_buffer_utm.envelope.intersects(
                        street_utm_geom.envelope
                    ):
                        continue

                    intersection = trip_buffer_utm.intersection(street_utm_geom)

                    # Check length of intersection
                    if (
                        not intersection.is_empty
                        and intersection.length >= min_match_length
                    ):
                        results[trip_index].add(seg_id)

            except (GEOSException, ValueError, TypeError):
                # Log trip-specific errors, but continue processing others
                # worker_logger.error(f"Worker: Error processing trip at index {trip_index}: {trip_err}", exc_info=False)
                pass  # Avoid excessive logging in production maybe? Or log selectively.

    except Exception:
        # worker_logger.error(f"Critical Worker Error: {e}", exc_info=True)
        # Log critical errors that occur outside the main loop
        return {}  # Return empty dict on critical failure
    finally:
        # --- Ensure DB Connection is Closed ---
        if mongo_client:
            try:
                mongo_client.close()
                # worker_logger.info("Worker closed DB connection.")
            except Exception:
                # worker_logger.error(f"Worker error closing DB connection: {close_err}")
                pass

    return dict(results)  # Convert back to dict from defaultdict


# --- CoverageCalculator Class ---


class CoverageCalculator:
    """
    Optimized calculator for street coverage using spatial indexing, multiprocessing,
    and efficient database operations.
    """

    def __init__(self, location: Dict[str, Any], task_id: str) -> None:
        """
        Initialize the CoverageCalculator.

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
        self.trip_batch_counter: int = 0  # For throttling progress updates

        # Multiprocessing setup
        self.process_pool: Optional[ProcessPoolExecutor] = None
        self.max_workers = int(
            os.getenv("MAX_COVERAGE_WORKERS", str(MAX_WORKERS_DEFAULT))
        )
        logger.info(
            f"CoverageCalculator configured with max_workers={self.max_workers}"
        )

        # DB connection details (fetched from environment)
        self.db_connection_string = os.getenv("MONGO_URI")
        self.db_name = os.getenv("MONGODB_DATABASE", "every_street")
        # Get actual collection name (important if using custom names)
        self.streets_collection_name = streets_collection.name

        if not self.db_connection_string:
            raise ValueError(
                "MONGO_URI environment variable is not set. Cannot connect to database."
            )

    def initialize_projections(self) -> None:
        """Initialize UTM and WGS84 projections based on location's bounding box."""
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
                        f"Invalid coordinate values in bounding box for {self.location_name}. Using default UTM."
                    )
            except (ValueError, TypeError):
                logger.warning(
                    f"Invalid bounding box format for {self.location_name}. Using default UTM."
                )
        else:
            logger.warning(
                f"Missing or invalid bounding box for {self.location_name}. Using default UTM."
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
                f"Initialized UTM projection for {self.location_name}: Zone {utm_zone}{hemisphere.upper()[0]}"
            )
        except pyproj.exceptions.CRSError as e:
            logger.error(
                f"Failed to initialize UTM projection for {self.location_name}: {e}. Calculation may be inaccurate."
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
                    "rtree_items": self.streets_index.count(self.streets_index.bounds)
                    if self.streets_index
                    else 0,
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
            logger.error(f"Task {self.task_id}: Error updating progress: {e}")

    async def initialize_workers(self) -> None:
        """Creates the ProcessPoolExecutor if max_workers > 0."""
        if self.process_pool is None and self.max_workers > 0:
            try:
                # Using 'spawn' context is generally safer across platforms than 'fork'
                context = multiprocessing.get_context("spawn")
                self.process_pool = ProcessPoolExecutor(
                    max_workers=self.max_workers, mp_context=context
                )
                logger.info(
                    f"Task {self.task_id}: Initialized ProcessPoolExecutor with {self.max_workers} workers."
                )
            except Exception as e:
                logger.error(
                    f"Task {self.task_id}: Failed to create process pool: {e}. Running sequentially."
                )
                self.max_workers = 0
                self.process_pool = None
        elif self.max_workers <= 0:
            logger.info(
                f"Task {self.task_id}: Running sequentially (max_workers <= 0)."
            )
            self.process_pool = None

    async def shutdown_workers(self) -> None:
        """Shuts down the ProcessPoolExecutor gracefully."""
        if self.process_pool:
            pool = self.process_pool
            self.process_pool = None  # Prevent reuse during shutdown
            try:
                logger.info(f"Task {self.task_id}: Shutting down process pool...")
                # Give workers some time to finish, then force shutdown
                pool.shutdown(wait=True, cancel_futures=True)
                logger.info(f"Task {self.task_id}: Process pool shut down.")
            except Exception as e:
                logger.error(
                    f"Task {self.task_id}: Error shutting down process pool: {e}"
                )

    async def build_spatial_index_and_stats(self) -> bool:
        """
        Builds the R-tree spatial index, calculates total street length, identifies
        initially driven segments, and populates the minimal streets_lookup cache.
        Performs a single pass over the streets collection.

        Returns:
            True if successful, False otherwise.
        """
        logger.info(
            f"Task {self.task_id}: Building spatial index for {self.location_name}..."
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
                f"Task {self.task_id}: Failed to count streets for {self.location_name}: {e}"
            )
            await self.update_progress("error", 0, f"Failed to count streets: {e}")
            return False

        if total_streets_count == 0:
            logger.warning(
                f"Task {self.task_id}: No streets found for location {self.location_name}."
            )
            await self.update_progress("error", 0, "No streets found for location.")
            # Not necessarily an error state for the task if the area truly has no streets
            return True  # Allow process to complete, result will show 0 coverage

        logger.info(
            f"Task {self.task_id}: Found {total_streets_count} streets to index."
        )

        # Fetch only necessary fields using projection
        streets_cursor = streets_collection.find(
            streets_query,
            {
                "geometry": 1,
                "properties.segment_id": 1,
                "properties.highway": 1,
                "properties.driven": 1,
                "_id": 0,
            },
        )

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
                # This part remains sequential for simplicity; parallelize if it becomes a bottleneck
                for street in street_batch:
                    processed_count += 1
                    try:
                        props = street.get("properties", {})
                        segment_id = props.get("segment_id")
                        geometry_data = street.get("geometry")

                        if not segment_id or not geometry_data:
                            # logger.warning(f"Task {self.task_id}: Skipping street due to missing segment_id or geometry (Processed: {processed_count}).")
                            continue

                        geom_wgs84 = shape(geometry_data)
                        bounds = geom_wgs84.bounds  # Use WGS84 bounds for R-tree

                        # Calculate length in UTM
                        geom_utm = transform(self.project_to_utm, geom_wgs84)
                        segment_length_m = geom_utm.length

                        if (
                            segment_length_m <= 0.1
                        ):  # Use a small threshold instead of zero
                            # logger.debug(f"Task {self.task_id}: Skipping street {segment_id} with negligible length ({segment_length_m:.2f}m).")
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
                            f"Task {self.task_id}: Error processing street geometry (Segment ID: {segment_id_str}): {e}",
                            exc_info=False,
                        )
                    except Exception as e:
                        segment_id_str = (
                            segment_id if "segment_id" in locals() else "N/A"
                        )
                        logger.error(
                            f"Task {self.task_id}: Unexpected error indexing street (Segment ID: {segment_id_str}): {e}",
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
                f"Task {self.task_id}: Finished building spatial index for {self.location_name}. "
                f"Total length: {self.total_length_calculated:.2f}m. R-tree items: {rtree_idx_counter}. "
                f"Initial driven: {len(self.initial_covered_segments)} segments ({self.initial_driven_length:.2f}m)."
            )

            if total_streets_count > 0 and rtree_idx_counter == 0:
                logger.warning(
                    f"Task {self.task_id}: No valid street segments were added to the spatial index for {self.location_name}, though {total_streets_count} were found."
                )
                # Don't fail the task, let it report 0% coverage

            return True

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Critical error during spatial index build for {self.location_name}: {e}",
                exc_info=True,
            )
            await self.update_progress(
                "error", 5, f"Error building spatial index: {e}"
            )
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
                    # logger.debug("Invalid JSON in GPS data string.")
                    return False, []
            else:
                # logger.debug(f"Unparseable GPS data type: {type(gps_data)}")
                return False, []

            coords = data.get("coordinates", [])
            if not isinstance(coords, list) or len(coords) < 2:
                # logger.debug(f"Invalid coordinates structure or length < 2. Length: {len(coords)}")
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
                # logger.debug("Invalid coordinate structure or non-numeric values in start/end points.")
                return False, []

            # Optional: Add check for coordinate range validity (-180 to 180 lon, -90 to 90 lat)
            # lon1, lat1 = p_start[:2]
            # lon2, lat2 = p_end[:2]
            # if not (-180 <= lon1 <= 180 and -90 <= lat1 <= 90 and -180 <= lon2 <= 180 and -90 <= lat2 <= 90):
            #     logger.debug("Coordinates out of valid range.")
            #     return False, []

            return True, coords
        except Exception:
            # logger.error(f"Error decoding/validating GPS data: {e}", exc_info=False)
            return False, []

    async def process_trips(self, processed_trip_ids_set: Set[str]) -> bool:
        """
        Fetches relevant trips, distributes them to worker processes for matching,
        and aggregates the results (newly covered segment IDs).

        Args:
            processed_trip_ids_set: A set of trip IDs that have already been processed
                                     in previous runs (used for incremental updates).

        Returns:
            True if trip processing completed (even if no new trips), False on critical failure.
        """
        await self.update_progress(
            "processing_trips", 50, f"Querying trips for {self.location_name}..."
        )

        # --- Trip Querying ---
        trip_filter: Dict[str, Any] = {
            "gps": {"$exists": True, "$ne": None, "$ne": ""}
        }
        bbox = self.location.get("boundingbox")
        if bbox and len(bbox) == 4:
            try:
                min_lat, max_lat, min_lon, max_lon = map(float, bbox)
                # Ensure correct order for $box: [ [minLon, minLat], [maxLon, maxLat] ]
                box_query = [[min_lon, min_lat], [max_lon, max_lat]]
                # Query trips whose start OR end point is within the bbox
                # Requires 2dsphere index on startGeoPoint and destinationGeoPoint
                trip_filter["$or"] = [
                    {"startGeoPoint": {"$geoWithin": {"$box": box_query}}},
                    {"destinationGeoPoint": {"$geoWithin": {"$box": box_query}}},
                ]
            except (ValueError, TypeError):
                logger.warning(
                    f"Task {self.task_id}: Invalid bounding box format for trip query, querying all trips."
                )
                # No spatial filter if bbox is invalid
        else:
            logger.warning(
                f"Task {self.task_id}: No bounding box for trip query, querying all trips."
            )

        # --- Exclude Already Processed Trips ---
        # Handle both ObjectId and string IDs robustly
        processed_object_ids = set()
        processed_string_ids = (
            set()
        )  # Keep strings for potential fallback fields like transactionId
        for tid in processed_trip_ids_set:
            if ObjectId.is_valid(tid):
                processed_object_ids.add(ObjectId(tid))
            processed_string_ids.add(tid)

        id_filters = []
        if processed_object_ids:
            id_filters.append({"_id": {"$nin": list(processed_object_ids)}})
        # Example: Add filter for string IDs if trips might use transactionId primarily
        # if processed_string_ids:
        #    id_filters.append({"transactionId": {"$nin": list(processed_string_ids)}})

        if id_filters:
            # Combine ID filters with the main trip filter using $and
            if "$and" in trip_filter:
                trip_filter["$and"].extend(id_filters)
            elif len(id_filters) == 1:
                # If only one ID filter, merge it directly
                trip_filter.update(id_filters[0])
            else:
                # If multiple ID filters (e.g., _id and transactionId), use $and
                trip_filter["$and"] = id_filters

        # --- Count Trips to Process ---
        try:
            # Use retry wrapper for count
            self.total_trips_to_process = await count_documents_with_retry(
                trips_collection, trip_filter
            )
            logger.info(
                f"Task {self.task_id}: Found {self.total_trips_to_process} new trips to process for {self.location_name}."
            )
        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error counting trips: {e}", exc_info=True
            )
            await self.update_progress("error", 50, f"Error counting trips: {e}")
            return False

        if self.total_trips_to_process == 0:
            logger.info(
                f"Task {self.task_id}: No new trips to process for {self.location_name}."
            )
            await self.update_progress(
                "processing_trips", 90, "No new trips found."
            )  # Jump progress
            return True  # Not an error, just no work to do

        # --- Initialize Worker Pool ---
        await self.initialize_workers()

        # --- Trip Processing Loop ---
        # Fetch only necessary fields: _id and gps
        trips_cursor = trips_collection.find(trip_filter, {"gps": 1, "_id": 1})
        pending_futures: Dict[
            Future, List[Tuple[str, List[Any]]]
        ] = {}  # Future -> List[(trip_id, coords)]

        processed_count_local = 0  # Local counter for this run
        batch_num = 0
        last_progress_update_pct = 50

        try:
            # Iterate through trips in batches
            async for trip_batch_docs in batch_cursor(
                trips_cursor, self.trip_batch_size
            ):
                batch_num += 1
                valid_trips_in_batch: List[
                    Tuple[str, List[Any]]
                ] = []  # List of (trip_id, coords)

                # Validate trips in the current batch
                for trip_doc in trip_batch_docs:
                    trip_id = str(trip_doc["_id"])
                    # Double-check if a processed trip slipped through (should be rare)
                    if trip_id in processed_trip_ids_set:
                        continue

                    is_valid, coords = self._is_valid_trip(trip_doc.get("gps"))
                    if is_valid:
                        valid_trips_in_batch.append((trip_id, coords))
                    else:
                        # Add invalid trip ID to processed set to avoid re-processing
                        processed_trip_ids_set.add(trip_id)
                        # logger.debug(f"Task {self.task_id}: Skipping invalid trip {trip_id}")

                if not valid_trips_in_batch:
                    continue  # Skip batch if no valid trips

                # --- Distribute Valid Trips to Workers ---
                for i in range(
                    0, len(valid_trips_in_batch), self.trip_worker_sub_batch
                ):
                    sub_batch = valid_trips_in_batch[
                        i : i + self.trip_worker_sub_batch
                    ]
                    sub_batch_coords = [coords for _, coords in sub_batch]
                    sub_batch_trip_ids = [tid for tid, _ in sub_batch]

                    # --- Find Candidate Segments for Sub-batch ---
                    candidate_segment_ids_map: Dict[int, List[str]] = defaultdict(list)
                    try:
                        # Use MultiPoint buffer for efficient bounds calculation
                        all_coords = [
                            coord
                            for coords_list in sub_batch_coords
                            for coord in coords_list
                        ]
                        if all_coords:
                            multi_point = MultiPoint(all_coords)
                            # Buffer in degrees (approximate) for R-tree query
                            buffer_deg = (
                                self.match_buffer / 111000
                            )  # Rough conversion meters to WGS84 degrees
                            combined_bounds = multi_point.buffer(buffer_deg).bounds

                            # Query R-tree once for the combined bounds
                            candidate_indices = list(
                                self.streets_index.intersection(combined_bounds)
                            )

                            # Map R-tree indices to segment IDs
                            candidate_segment_ids_list = [
                                self.streets_lookup[idx]["segment_id"]
                                for idx in candidate_indices
                                if idx in self.streets_lookup
                            ]

                            # Assign the same candidate list to all trips in this sub-batch
                            # The worker will perform the precise intersection check.
                            for trip_idx in range(len(sub_batch)):
                                candidate_segment_ids_map[trip_idx] = (
                                    candidate_segment_ids_list
                                )
                        else:
                            # If no coordinates, no candidates needed
                            pass

                    except (GEOSException, ValueError, TypeError, Exception) as e:
                        logger.warning(
                            f"Task {self.task_id}: Error finding candidates for sub-batch: {e}. Skipping sub-batch."
                        )
                        # Mark trips as processed to avoid retrying infinitely
                        processed_count_local += len(sub_batch)
                        processed_trip_ids_set.update(sub_batch_trip_ids)
                        continue  # Skip this sub-batch

                    if not any(candidate_segment_ids_map.values()):
                        # No candidates found for any trip in this sub-batch
                        processed_count_local += len(sub_batch)
                        processed_trip_ids_set.update(sub_batch_trip_ids)
                        # logger.debug(f"Task {self.task_id}: No candidates for sub-batch starting with trip {sub_batch_trip_ids[0]}.")
                        continue

                    # --- Submit to Worker Pool (or run sequentially) ---
                    if self.process_pool and self.max_workers > 0:
                        try:
                            future = self.process_pool.submit(
                                process_trip_worker,
                                sub_batch_coords,
                                dict(candidate_segment_ids_map),  # Convert defaultdict
                                self.utm_proj.to_string(),
                                WGS84.to_string(),
                                self.match_buffer,
                                self.min_match_length,
                                self.db_connection_string,  # Pass DB details
                                self.db_name,
                                self.streets_collection_name,
                            )
                            pending_futures[future] = (
                                sub_batch  # Store original data mapped to future
                            )
                        except Exception as submit_err:
                            logger.error(
                                f"Task {self.task_id}: Error submitting sub-batch to process pool: {submit_err}"
                            )
                            # Mark trips as processed to avoid retrying infinitely
                            processed_count_local += len(sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)
                    else:
                        # --- Sequential Fallback ---
                        # logger.debug(f"Task {self.task_id}: Running trip sub-batch sequentially.")
                        try:
                            # Simulate worker call in the main thread/process
                            result_map = process_trip_worker(
                                sub_batch_coords,
                                dict(candidate_segment_ids_map),
                                self.utm_proj.to_string(),
                                WGS84.to_string(),
                                self.match_buffer,
                                self.min_match_length,
                                self.db_connection_string,
                                self.db_name,
                                self.streets_collection_name,
                            )
                            # Process result immediately
                            for trip_idx, matched_ids in result_map.items():
                                self.newly_covered_segments.update(matched_ids)
                            processed_count_local += len(sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)
                        except Exception as seq_err:
                            logger.error(
                                f"Task {self.task_id}: Error during sequential trip processing: {seq_err}",
                                exc_info=True,
                            )
                            processed_count_local += len(sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)

                # --- Process Completed Futures Asynchronously ---
                if pending_futures:
                    # Use asyncio.as_completed for non-blocking check
                    done_futures = set()
                    try:
                        for future in asyncio.as_completed(
                            [asyncio.wrap_future(f) for f in pending_futures.keys()],
                            timeout=0.1,
                        ):  # Short timeout to avoid blocking
                            try:
                                completed_future = await future
                                original_sub_batch = pending_futures.pop(
                                    completed_future, []
                                )
                                sub_batch_trip_ids = [
                                    tid for tid, _ in original_sub_batch
                                ]

                                try:
                                    # Get result with worker timeout
                                    result_map = completed_future.result(
                                        timeout=PROCESS_TIMEOUT_WORKER
                                    )
                                    for trip_idx, matched_ids in result_map.items():
                                        self.newly_covered_segments.update(matched_ids)
                                    processed_count_local += len(original_sub_batch)
                                    processed_trip_ids_set.update(sub_batch_trip_ids)
                                    done_futures.add(completed_future)
                                except TimeoutError:
                                    logger.error(
                                        f"Task {self.task_id}: Worker task timed out for trips: {sub_batch_trip_ids}. Marking as processed."
                                    )
                                    processed_count_local += len(original_sub_batch)
                                    processed_trip_ids_set.update(sub_batch_trip_ids)
                                    done_futures.add(completed_future)
                                except Exception as e:
                                    logger.error(
                                        f"Task {self.task_id}: Worker task failed for trips {sub_batch_trip_ids}: {e}",
                                        exc_info=True,
                                    )
                                    processed_count_local += len(original_sub_batch)
                                    processed_trip_ids_set.update(sub_batch_trip_ids)
                                    done_futures.add(completed_future)
                            except asyncio.TimeoutError:
                                # Timeout waiting for future completion in as_completed, continue checking others
                                pass
                    except Exception as gather_err:
                        logger.error(
                            f"Task {self.task_id}: Error processing completed futures: {gather_err}"
                        )

                # --- Update Progress ---
                self.processed_trips_count = (
                    processed_count_local  # Update class attribute
                )
                # Progress for trip processing stage (e.g., 50% to 90%)
                current_progress_pct = 50 + (
                    processed_count_local / self.total_trips_to_process * 40
                )
                if (
                    batch_num % PROGRESS_UPDATE_INTERVAL_TRIPS == 0
                    or processed_count_local == self.total_trips_to_process
                ):
                    if (
                        current_progress_pct - last_progress_update_pct >= 1
                        or processed_count_local == self.total_trips_to_process
                    ):  # Update at least every 1%
                        await self.update_progress(
                            "processing_trips",
                            current_progress_pct,
                            f"Processed {processed_count_local}/{self.total_trips_to_process} trips",
                        )
                        last_progress_update_pct = current_progress_pct
                        await asyncio.sleep(BATCH_PROCESS_DELAY)  # Yield control

            # --- Process Any Remaining Futures After Loop ---
            logger.info(
                f"Task {self.task_id}: Processing remaining {len(pending_futures)} trip futures..."
            )
            if pending_futures:
                original_futures_map = {
                    asyncio.wrap_future(f): f for f in pending_futures.keys()
                }
                wrapped_futures = list(original_futures_map.keys())

                try:
                    # Wait for all remaining futures with a generous timeout
                    overall_wait_timeout = (
                        PROCESS_TIMEOUT_WORKER * 2
                    )  # Adjust as needed
                    done, pending = await asyncio.wait(
                        wrapped_futures,
                        timeout=overall_wait_timeout,
                        return_when=asyncio.ALL_COMPLETED,
                    )

                    for wrapped_done_future in done:
                        original_future = original_futures_map.get(wrapped_done_future)
                        if not original_future:
                            continue  # Should not happen

                        original_sub_batch = pending_futures.pop(original_future, [])
                        sub_batch_trip_ids = [tid for tid, _ in original_sub_batch]

                        try:
                            # Get result from the completed asyncio.Future
                            result_map = (
                                wrapped_done_future.result()
                            )  # This might raise if the worker failed
                            for trip_idx, matched_ids in result_map.items():
                                self.newly_covered_segments.update(matched_ids)
                            processed_count_local += len(original_sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)
                        except (
                            TimeoutError
                        ):  # Should not happen with ALL_COMPLETED, but defensive check
                            logger.error(
                                f"Task {self.task_id}: Worker task timed out (in final wait) for trips: {sub_batch_trip_ids}. Marking as processed."
                            )
                            processed_count_local += len(original_sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)
                        except Exception as e:
                            # This catches errors *within* the worker process itself
                            logger.error(
                                f"Task {self.task_id}: Worker task failed (in final wait) for trips {sub_batch_trip_ids}: {e}",
                                exc_info=True,
                            )
                            processed_count_local += len(original_sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)

                    # Handle futures that were still pending (meaning asyncio.wait timed out)
                    for wrapped_pending_future in pending:
                        original_future = original_futures_map.get(
                            wrapped_pending_future
                        )
                        if not original_future:
                            continue

                        original_sub_batch = pending_futures.pop(original_future, [])
                        sub_batch_trip_ids = [tid for tid, _ in original_sub_batch]
                        logger.error(
                            f"Task {self.task_id}: Overall timeout waiting for future completion for trips: {sub_batch_trip_ids}. Marking as processed."
                        )
                        processed_count_local += len(original_sub_batch)
                        processed_trip_ids_set.update(sub_batch_trip_ids)
                        try:
                            wrapped_pending_future.cancel()  # Attempt to cancel
                        except:
                            pass  # Ignore cancellation errors

                except Exception as final_gather_err:
                    logger.error(
                        f"Task {self.task_id}: Error processing final futures with asyncio.wait: {final_gather_err}",
                        exc_info=True,
                    )
                    # Mark all remaining as processed on error
                    for original_future, remaining_batch in pending_futures.items():
                        remaining_ids = [tid for tid, _ in remaining_batch]
                        processed_count_local += len(remaining_batch)
                        processed_trip_ids_set.update(remaining_ids)
                    pending_futures.clear()

            self.processed_trips_count = processed_count_local  # Final update
            logger.info(
                f"Task {self.task_id}: Finished processing trips for {self.location_name}. "
                f"Processed: {self.processed_trips_count}/{self.total_trips_to_process}. "
                f"Newly covered segments found: {len(self.newly_covered_segments)}."
            )
            return True

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Critical error during trip processing loop for {self.location_name}: {e}",
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
        """
        Updates the 'driven' status of streets in the database based on newly covered
        segments, calculates final coverage statistics using a MongoDB aggregation pipeline,
        and updates the coverage metadata document.

        Args:
            processed_trip_ids_set: The complete set of trip IDs processed up to this point.

        Returns:
            A dictionary containing the final coverage statistics (total_length, driven_length,
            coverage_percentage, total_segments, street_types), or None if finalization failed.
            Does NOT include the full GeoJSON data.
        """
        await self.update_progress(
            "finalizing", 90, f"Updating street statuses for {self.location_name}..."
        )

        # --- Bulk Update Driven Status ---
        # Identify segments that were not driven before but are now covered by this run
        segments_to_update = list(
            self.newly_covered_segments - self.initial_covered_segments
        )

        if segments_to_update:
            logger.info(
                f"Task {self.task_id}: Updating 'driven' status for {len(segments_to_update)} newly covered segments..."
            )
            try:
                # Use retry wrapper for DB operation
                update_result = await update_many_with_retry(
                    streets_collection,
                    {"properties.segment_id": {"$in": segments_to_update}},
                    {
                        "$set": {
                            "properties.driven": True,
                            "properties.last_coverage_update": datetime.now(
                                timezone.utc
                            ),
                        }
                        # Optional: Add trip IDs if needed, but beware of document size limits
                        # "$addToSet": {"properties.covered_by_trips": {"$each": list_of_trip_ids_affecting_these}}
                    },
                )
                logger.info(
                    f"Task {self.task_id}: Bulk update result: Matched={update_result.matched_count}, Modified={update_result.modified_count}"
                )
                if update_result.modified_count != len(segments_to_update):
                    # This might happen if a segment was deleted between indexing and update, or if segment_id isn't unique (which it should be)
                    logger.warning(
                        f"Task {self.task_id}: Mismatch in bulk update count. Expected {len(segments_to_update)}, modified {update_result.modified_count}. Check for potential data inconsistencies."
                    )

            except BulkWriteError as bwe:
                logger.error(
                    f"Task {self.task_id}: Bulk write error updating street status: {bwe.details}"
                )
                # Continue, but stats might be slightly off if update failed partially
            except Exception as e:
                logger.error(
                    f"Task {self.task_id}: Error bulk updating street status: {e}",
                    exc_info=True,
                )
                await self.update_progress("error", 90, f"Error updating DB: {e}")
                return None  # Cannot reliably calculate stats if update failed
        else:
            logger.info(
                f"Task {self.task_id}: No new segments to mark as driven for {self.location_name}."
            )

        # --- Calculate Final Stats using Aggregation ---
        await self.update_progress(
            "finalizing",
            95,
            f"Calculating final statistics for {self.location_name}...",
        )
        try:
            coverage_stats = await self._run_coverage_aggregation()
            if not coverage_stats:
                # This can happen if the aggregation pipeline itself fails or returns nothing
                logger.error(
                    f"Task {self.task_id}: Failed to calculate coverage statistics via aggregation for {self.location_name}."
                )
                await self.update_progress(
                    "error", 95, "Failed to calculate statistics."
                )
                return None

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error calculating final stats via aggregation: {e}",
                exc_info=True,
            )
            await self.update_progress("error", 95, f"Error calculating stats: {e}")
            return None

        # --- Update Metadata Document ---
        # Store the final aggregated stats and the complete list of processed trip IDs
        logger.info(
            f"Task {self.task_id}: Updating coverage metadata for {self.location_name}..."
        )
        try:
            # Use retry wrapper for DB operation
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": self.location_name},
                {
                    "$set": {
                        "total_length": coverage_stats["total_length"],
                        "driven_length": coverage_stats["driven_length"],
                        "coverage_percentage": coverage_stats["coverage_percentage"],
                        "street_types": coverage_stats["street_types"],
                        "total_segments": coverage_stats["total_segments"],
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",  # Mark as completed in metadata
                        "last_error": None,  # Clear any previous error
                        # Store all processed trip IDs (initial + new from this run)
                        "processed_trips.trip_ids": list(processed_trip_ids_set),
                        "processed_trips.last_processed_timestamp": datetime.now(
                            timezone.utc
                        ),
                        # Note: streets_data (GeoJSON) is NOT set here. It's handled by generate_and_store_geojson.
                    }
                },
                upsert=True,  # Ensure metadata document exists
            )
            logger.info(
                f"Task {self.task_id}: Coverage metadata updated for {self.location_name}."
            )
        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error updating coverage metadata: {e}",
                exc_info=True,
            )
            # Log error but proceed to return calculated stats if available
            # Don't set task progress to error here, as calculation might be done, just metadata update failed

        # --- Prepare Result Dictionary ---
        # Return only the calculated statistics. GeoJSON is handled separately.
        final_result = {
            "total_length": coverage_stats["total_length"],
            "driven_length": coverage_stats["driven_length"],
            "coverage_percentage": coverage_stats["coverage_percentage"],
            "total_segments": coverage_stats["total_segments"],
            "street_types": coverage_stats["street_types"],
            # Add some context about this specific run
            "run_details": {
                "newly_covered_segment_count": len(segments_to_update),
                "total_processed_trips_in_run": self.processed_trips_count,
            },
        }

        # Final progress update
        await self.update_progress("complete", 100, "Coverage calculation complete.")
        logger.info(
            f"Task {self.task_id}: Coverage calculation complete for {self.location_name}."
        )
        return final_result

    async def _run_coverage_aggregation(self) -> Optional[Dict[str, Any]]:
        """
        Executes the MongoDB aggregation pipeline to calculate coverage statistics
        based on the current 'driven' status of streets in the database.

        Returns:
            A dictionary containing the aggregated statistics (total_length, driven_length,
            coverage_percentage, total_segments, street_types), or None if aggregation fails.
        """
        logger.debug(
            f"Task {self.task_id}: Running coverage aggregation pipeline for {self.location_name}..."
        )
        pipeline = [
            # Filter for the specific location
            {"$match": {"properties.location": self.location_name}},
            # Ensure segment_length exists, is numeric, and positive for calculations
            {
                "$match": {
                    "properties.segment_length": {
                        "$exists": True,
                        "$type": "number",
                        "$gt": 0,
                    }
                }
            },
            # Group by highway type to calculate stats per type
            {
                "$group": {
                    "_id": "$properties.highway",  # Group key is highway type
                    "total_count": {"$sum": 1},  # Count total segments per type
                    "driven_count": {  # Count driven segments per type
                        "$sum": {
                            "$cond": [{"$eq": ["$properties.driven", True]}, 1, 0]
                        }
                    },
                    "total_length": {
                        "$sum": "$properties.segment_length"
                    },  # Sum total length per type
                    "driven_length": {  # Sum driven length per type
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$properties.driven", True]},
                                "$properties.segment_length",
                                0,
                            ]
                        }
                    },
                }
            },
            # Reshape the output for each street type
            {
                "$project": {
                    "_id": 0,  # Exclude the default _id
                    "type": "$_id",  # Rename _id to type
                    "total": "$total_count",
                    "covered": "$driven_count",
                    "length": "$total_length",
                    "covered_length": "$driven_length",
                    "coverage_percentage": {  # Calculate coverage percentage per type
                        "$cond": [
                            {"$gt": ["$total_length", 0]},  # Avoid division by zero
                            {
                                "$multiply": [
                                    {"$divide": ["$driven_length", "$total_length"]},
                                    100,
                                ]
                            },
                            0,  # Return 0 if total_length is 0
                        ]
                    },
                }
            },
            # Group all type results together to calculate overall totals
            {
                "$group": {
                    "_id": None,  # Group all documents into one
                    "street_types": {
                        "$push": "$$ROOT"
                    },  # Push individual type stats into an array
                    "overall_total_length": {
                        "$sum": "$length"
                    },  # Sum total length across all types
                    "overall_driven_length": {
                        "$sum": "$covered_length"
                    },  # Sum driven length across all types
                    "overall_total_segments": {
                        "$sum": "$total"
                    },  # Sum total segments across all types
                }
            },
            # Final projection for the overall result format
            {
                "$project": {
                    "_id": 0,  # Exclude the default _id
                    # Sort the street_types array by total length descending
                    "street_types": {
                        "$sortArray": {
                            "input": "$street_types",
                            "sortBy": {"length": -1},
                        }
                    },
                    "total_length": "$overall_total_length",
                    "driven_length": "$overall_driven_length",
                    "total_segments": "$overall_total_segments",
                    "coverage_percentage": {  # Calculate overall coverage percentage
                        "$cond": [
                            {
                                "$gt": ["$overall_total_length", 0]
                            },  # Avoid division by zero
                            {
                                "$multiply": [
                                    {
                                        "$divide": [
                                            "$overall_driven_length",
                                            "$overall_total_length",
                                        ]
                                    },
                                    100,
                                ]
                            },
                            0,  # Return 0 if total length is 0
                        ]
                    },
                }
            },
        ]

        try:
            # Use retry wrapper for aggregation
            aggregation_result = await aggregate_with_retry(
                streets_collection, pipeline
            )

            if not aggregation_result:
                # This happens if no streets match the initial location filter
                logger.warning(
                    f"Task {self.task_id}: Coverage aggregation returned no results for {self.location_name}. Assuming 0 coverage."
                )
                # Return zeroed stats
                return {
                    "total_length": 0.0,
                    "driven_length": 0.0,
                    "coverage_percentage": 0.0,
                    "total_segments": 0,
                    "street_types": [],
                }

            # Aggregation pipeline returns a list containing a single result document
            final_stats = aggregation_result[0]
            logger.debug(
                f"Task {self.task_id}: Aggregation successful for {self.location_name}."
            )
            return final_stats

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error during coverage aggregation pipeline: {e}",
                exc_info=True,
            )
            return None  # Indicate failure

    async def compute_coverage(
        self, run_incremental: bool = False
    ) -> Optional[Dict[str, Any]]:
        """
        Main orchestrator method to compute coverage statistics.

        Handles initialization, index building, trip processing (full or incremental),
        and finalization.

        Args:
            run_incremental: If True, loads previously processed trip IDs and only processes
                             new trips. If False, performs a full calculation (still
                             respecting the 'driven' status from previous runs).

        Returns:
            A dictionary containing the final coverage statistics, or None if a critical
            error occurred during the process. Does NOT include the full GeoJSON.
        """
        start_time = datetime.now(timezone.utc)
        run_type = "incremental" if run_incremental else "full"
        logger.info(
            f"Task {self.task_id}: Starting {run_type} coverage computation for {self.location_name}"
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
                    f"Task {self.task_id}: Projection initialization failed: {proj_err}"
                )
                await self.update_progress("error", 0, f"Projection Error: {proj_err}")
                return None

            # --- Step 1: Build Index & Get Initial State ---
            # This step reads all streets for the location, builds the R-tree,
            # calculates total length, and identifies segments already marked as driven.
            index_success = await self.build_spatial_index_and_stats()
            if not index_success:
                # Error already logged and progress updated in build_spatial_index
                logger.error(
                    f"Task {self.task_id}: Failed during spatial index build for {self.location_name}."
                )
                return None
            # Handle case where area has 0 streets after indexing
            if (
                self.total_length_calculated == 0
                and self.streets_index.count(self.streets_index.bounds) == 0
            ):
                logger.info(
                    f"Task {self.task_id}: No valid streets found for {self.location_name}. Reporting 0% coverage."
                )
                # Skip trip processing and go straight to finalization which will report 0s
                processed_trip_ids_set: Set[str] = set()  # Empty set for finalization
            else:
                # --- Step 2: Determine Processed Trips ---
                processed_trip_ids_set = set()
                if run_incremental:
                    # Load existing processed trips from metadata for incremental run
                    try:
                        # Use retry wrapper for DB operation
                        metadata = await find_one_with_retry(
                            coverage_metadata_collection,
                            {"location.display_name": self.location_name},
                            {"processed_trips.trip_ids": 1},  # Fetch only needed field
                        )
                        if (
                            metadata
                            and "processed_trips" in metadata
                            and "trip_ids" in metadata["processed_trips"]
                        ):
                            # Ensure trip_ids is a list/set before creating the set
                            trip_ids_data = metadata["processed_trips"]["trip_ids"]
                            if isinstance(trip_ids_data, (list, set)):
                                processed_trip_ids_set = set(trip_ids_data)
                                logger.info(
                                    f"Task {self.task_id}: Loaded {len(processed_trip_ids_set)} previously processed trip IDs for incremental run."
                                )
                            else:
                                logger.warning(
                                    f"Task {self.task_id}: 'processed_trips.trip_ids' in metadata is not a list/set for {self.location_name}. Running as full."
                                )
                        else:
                            logger.warning(
                                f"Task {self.task_id}: Incremental run requested for {self.location_name}, but no previous processed trips found in metadata. Running as full."
                            )
                    except Exception as meta_err:
                        logger.error(
                            f"Task {self.task_id}: Error loading processed trips from metadata: {meta_err}. Running as full."
                        )
                else:
                    # For full run, start with empty set (will process all trips not filtered out by DB query)
                    logger.info(
                        f"Task {self.task_id}: Starting full coverage run for {self.location_name}."
                    )

                # --- Step 3: Process Trips ---
                # Fetches trips, distributes to workers, aggregates newly covered segments.
                trips_success = await self.process_trips(processed_trip_ids_set)
                if not trips_success:
                    # Error likely logged and progress updated in process_trips
                    logger.error(
                        f"Task {self.task_id}: Failed during trip processing stage for {self.location_name}."
                    )
                    return None  # Critical error during trip processing

            # --- Step 4: Finalize and Update ---
            # Updates DB 'driven' status, runs aggregation, updates metadata.
            final_stats = await self.finalize_coverage(processed_trip_ids_set)
            # final_stats will be None if finalization failed

            end_time = datetime.now(timezone.utc)
            duration = (end_time - start_time).total_seconds()
            logger.info(
                f"Task {self.task_id}: Coverage computation ({run_type}) for {self.location_name} finished in {duration:.2f} seconds."
            )

            return final_stats  # Contains aggregated stats, excludes GeoJSON

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Unhandled error in compute_coverage for {self.location_name}: {e}",
                exc_info=True,
            )
            await self.update_progress("error", 0, f"Unhandled error: {e}")
            return None
        finally:
            # --- Cleanup ---
            await self.shutdown_workers()  # Ensure pool is closed even on error
            self.streets_lookup = {}  # Clear lookup cache
            self.streets_index = None  # Allow R-tree object to be GC'd
            logger.debug(
                f"Task {self.task_id}: Cleanup completed for {self.location_name}."
            )


# --- Top-Level Functions (Called by Celery tasks or API endpoints) ---


async def compute_coverage_for_location(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """
    High-level function to compute full coverage for a specific location.
    Instantiates CoverageCalculator and runs the full computation.

    Args:
        location: Location dictionary.
        task_id: Task identifier for progress tracking.

    Returns:
        Coverage statistics dictionary or None if an error occurred.
        Does NOT include the full GeoJSON data.
    """
    logger.info(
        f"Task {task_id}: Received request for full coverage calculation for {location.get('display_name')}"
    )
    calculator = None
    try:
        # Ensure required DB indexes exist before starting
        await ensure_street_coverage_indexes()

        calculator = CoverageCalculator(location, task_id)
        # Run the full calculation with overall timeout
        result = await asyncio.wait_for(
            calculator.compute_coverage(run_incremental=False),
            timeout=PROCESS_TIMEOUT_OVERALL,
        )

        # If calculation succeeded, trigger GeoJSON generation (runs independently)
        if result:
            asyncio.create_task(
                generate_and_store_geojson(location.get("display_name"), task_id)
            )
            # Return the stats immediately, don't wait for GeoJSON
            return result
        else:
            # compute_coverage should have updated progress on failure
            logger.error(
                f"Task {task_id}: Full coverage calculation failed for {location.get('display_name')}"
            )
            return None

    except asyncio.TimeoutError:
        error_msg = f"Calculation timed out after {PROCESS_TIMEOUT_OVERALL}s"
        logger.error(
            f"Task {task_id}: Full coverage calculation for {location.get('display_name')} timed out."
        )
        # Update progress and metadata to reflect timeout
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
            {"location.display_name": location.get("display_name")},
            {
                "$set": {
                    "status": "error",
                    "last_error": error_msg,
                    "last_updated": datetime.now(timezone.utc),
                }
            },
        )
        return None
    except Exception as e:
        error_msg = f"Unexpected error: {e}"
        logger.exception(
            f"Task {task_id}: Error in compute_coverage_for_location wrapper for {location.get('display_name')}: {e}"
        )
        # Ensure progress/metadata reflect error state if not already done by calculator
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
            {"location.display_name": location.get("display_name")},
            {
                "$set": {
                    "status": "error",
                    "last_error": str(e),
                    "last_updated": datetime.now(timezone.utc),
                }
            },
        )
        return None
    finally:
        # Ensure calculator cleanup runs even if wrapper fails early
        if calculator:
            await calculator.shutdown_workers()
            calculator.streets_lookup = {}
            calculator.streets_index = None


async def compute_incremental_coverage(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """
    High-level function to compute incremental coverage update for a specific location.
    Instantiates CoverageCalculator and runs the incremental computation.

    Args:
        location: Location dictionary.
        task_id: Task identifier for progress tracking.

    Returns:
        Coverage statistics dictionary or None if an error occurred.
        Does NOT include the full GeoJSON data.
    """
    logger.info(
        f"Task {task_id}: Received request for incremental coverage update for {location.get('display_name')}"
    )
    calculator = None
    try:
        # Ensure required DB indexes exist before starting
        await ensure_street_coverage_indexes()

        # Check if metadata exists, if not, log warning but proceed (will run as full)
        metadata_exists = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location.get("display_name")},
            {"_id": 1},  # Just check existence
        )
        if not metadata_exists:
            logger.warning(
                f"Task {task_id}: No metadata found for {location.get('display_name')} during incremental request. Calculation will run as full."
            )

        calculator = CoverageCalculator(location, task_id)
        # Run the incremental calculation with overall timeout
        result = await asyncio.wait_for(
            calculator.compute_coverage(run_incremental=True),
            timeout=PROCESS_TIMEOUT_INCREMENTAL,
        )

        # If calculation succeeded, trigger GeoJSON generation
        if result:
            asyncio.create_task(
                generate_and_store_geojson(location.get("display_name"), task_id)
            )
            # Return the stats immediately
            return result
        else:
            # compute_coverage should have updated progress on failure
            logger.error(
                f"Task {task_id}: Incremental coverage calculation failed for {location.get('display_name')}"
            )
            return None

    except asyncio.TimeoutError:
        error_msg = (
            f"Incremental calculation timed out after {PROCESS_TIMEOUT_INCREMENTAL}s"
        )
        logger.error(
            f"Task {task_id}: Incremental coverage for {location.get('display_name')} timed out."
        )
        # Update progress and metadata to reflect timeout
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
            {"location.display_name": location.get("display_name")},
            {
                "$set": {
                    "status": "error",
                    "last_error": error_msg,
                    "last_updated": datetime.now(timezone.utc),
                }
            },
        )
        return None
    except Exception as e:
        error_msg = f"Unexpected error: {e}"
        logger.exception(
            f"Task {task_id}: Error in compute_incremental_coverage wrapper for {location.get('display_name')}: {e}"
        )
        # Ensure progress/metadata reflect error state
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
            {"location.display_name": location.get("display_name")},
            {
                "$set": {
                    "status": "error",
                    "last_error": str(e),
                    "last_updated": datetime.now(timezone.utc),
                }
            },
        )
        return None
    finally:
        # Ensure calculator cleanup runs even if wrapper fails early
        if calculator:
            await calculator.shutdown_workers()
            calculator.streets_lookup = {}
            calculator.streets_index = None


async def generate_and_store_geojson(
    location_name: Optional[str], task_id: str
) -> None:
    """
    Generates the final GeoJSON output based on the current state of streets
    in the database for a given location and stores it in the corresponding
    coverage_metadata document.

    This is designed to run *after* the main coverage calculation and database updates
    (setting 'driven' flags) are complete.

    Args:
        location_name: The display name of the location.
        task_id: The ID of the original calculation task (for progress updates).
    """
    if not location_name:
        logger.error(
            f"Task {task_id}: Cannot generate GeoJSON, location name is missing."
        )
        return

    logger.info(f"Task {task_id}: Starting GeoJSON generation for {location_name}...")
    # Update progress to indicate GeoJSON generation start
    await progress_collection.update_one(
        {"_id": task_id},
        {"$set": {"message": "Generating final GeoJSON output..."}},
        # Don't upsert here, progress should exist from main task
    )

    features = []
    streets_cursor = streets_collection.find(
        {"properties.location": location_name},
        # Project only necessary fields for GeoJSON to reduce memory/bandwidth
        {"geometry": 1, "properties": 1, "_id": 0},
    )
    batch_num = 0
    total_features = 0
    try:
        # Process streets in batches to build the features list
        async for street_batch in batch_cursor(
            streets_cursor, 2000
        ):  # Read in larger batches
            batch_num += 1
            for street in street_batch:
                # Basic feature structure
                feature = {
                    "type": "Feature",
                    "geometry": street.get("geometry"),
                    # Include all properties for now, can be pruned later if needed
                    "properties": street.get("properties", {}),
                }
                # Ensure key properties exist, provide defaults if necessary
                props = feature["properties"]
                props["segment_id"] = props.get(
                    "segment_id", f"missing_{total_features}"
                )
                props["driven"] = props.get("driven", False)
                props["highway"] = props.get("highway", "unknown")
                props["segment_length"] = props.get(
                    "segment_length", 0.0
                )  # Should exist from preprocessing/aggregation

                features.append(feature)
                total_features += 1

            # logger.debug(f"Task {task_id}: Processed GeoJSON batch {batch_num} for {location_name}")
            await asyncio.sleep(0.01)  # Yield briefly during large reads

        logger.info(
            f"Task {task_id}: Generated {total_features} features for {location_name} GeoJSON."
        )

        # Fetch the latest aggregated stats from metadata to include
        # These should have been updated by finalize_coverage just before this
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
                f"Task {task_id}: Could not retrieve metadata stats for {location_name} while generating GeoJSON."
            )
            # Proceed without metadata, or handle error differently?
            metadata_stats = {}  # Use empty dict as fallback

        # Construct the final GeoJSON FeatureCollection object
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

        # --- Store the GeoJSON in the metadata document ---
        # WARNING: This can make the MongoDB document very large (> 16MB limit eventually).
        # Consider alternatives for very large areas:
        # 1. Store in GridFS and link the GridFS ID in the metadata.
        # 2. Store in a separate collection keyed by location_name.
        # 3. Store externally (e.g., S3) and link the URL.
        # 4. Generate GeoJSON on-demand via a separate API endpoint (might be slow).
        logger.info(
            f"Task {task_id}: Storing GeoJSON for {location_name} in metadata document..."
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {"$set": {"streets_data": streets_geojson}},
        )
        logger.info(
            f"Task {task_id}: Successfully stored GeoJSON for {location_name}."
        )

        # Update progress message
        await progress_collection.update_one(
            {"_id": task_id},
            {"$set": {"message": "GeoJSON generation complete."}},
        )

    except Exception as e:
        error_msg = f"Error generating/storing GeoJSON: {e}"
        logger.error(f"Task {task_id}: {error_msg}", exc_info=True)
        # Update progress and metadata to indicate GeoJSON failure
        await progress_collection.update_one(
            {"_id": task_id},
            {"$set": {"message": error_msg, "error": str(e)}},
        )
        # Don't mark the main task as failed, just add error context to metadata
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {"$set": {"last_error": f"GeoJSON generation failed: {e}"}},
        )
    finally:
        # Ensure cursor is closed
        if "streets_cursor" in locals() and hasattr(streets_cursor, "close"):
            await streets_cursor.close()


# --- Bulk Update Function (Example - can be called by a Celery task) ---


async def update_coverage_for_all_locations() -> Dict[str, Any]:
    """
    Triggers incremental coverage updates for all known locations.
    Designed to be called periodically (e.g., by a Celery Beat task).

    Returns:
        Dictionary summarizing the results (updated, failed, skipped counts).
    """
    logger.info("Starting bulk incremental coverage update for all locations...")
    results = {"updated": 0, "failed": 0, "skipped": 0, "locations": []}

    # Find all locations, prioritizing older ones or those with errors
    cursor = coverage_metadata_collection.find(
        {"status": {"$ne": "processing"}},  # Avoid locations already being processed
        {"location": 1, "_id": 1, "last_updated": 1, "status": 1},
    ).sort(
        [("status", 1), ("last_updated", 1)]
    )  # Process errored/canceled first, then oldest

    async for doc in batch_cursor(cursor, 5):  # Process locations in small batches
        loc = doc.get("location")
        if not loc or not isinstance(loc, dict) or not loc.get("display_name"):
            logger.warning(f"Skipping doc {doc.get('_id')} - invalid location format")
            results["skipped"] += 1
            continue

        display_name = loc.get("display_name")
        # Generate a unique task ID for tracking this specific update run
        task_id = f"bulk_update_{display_name.replace(' ', '_')}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        logger.info(
            f"Queueing incremental update for {display_name} (Task: {task_id})"
        )

        # --- Prevent Concurrent Updates ---
        # Attempt to atomically set status to 'processing'
        update_res = await update_one_with_retry(
            coverage_metadata_collection,
            {
                "_id": doc["_id"],
                "status": {"$ne": "processing"},
            },  # Condition: not already processing
            {
                "$set": {
                    "status": "processing",
                    "last_updated": datetime.now(timezone.utc),
                    "last_error": None,
                }
            },  # Set status, clear error
        )

        if update_res.matched_count == 0:
            logger.warning(
                f"Location {display_name} was already processing or status changed concurrently, skipping."
            )
            results["skipped"] += 1
            continue
        # --- Run Incremental Update ---
        try:
            # Call the high-level incremental function with a timeout per location
            result = await asyncio.wait_for(
                compute_incremental_coverage(loc, task_id),
                timeout=PROCESS_TIMEOUT_INCREMENTAL,
            )

            if result:
                # Status ('completed') is set within compute_incremental_coverage/finalize_coverage
                logger.info(
                    f"Successfully updated coverage for {display_name}: {result.get('coverage_percentage', 'N/A'):.2f}%"
                )
                results["updated"] += 1
                results["locations"].append(
                    {
                        "name": display_name,
                        "coverage": result.get("coverage_percentage", 0),
                    }
                )
            else:
                # Error status should have been set by compute_incremental_coverage
                logger.error(
                    f"Incremental update failed for {display_name} (check task {task_id} progress)."
                )
                results["failed"] += 1

        except asyncio.TimeoutError:
            error_msg = (
                f"Incremental update timed out after {PROCESS_TIMEOUT_INCREMENTAL}s"
            )
            logger.error(f"Coverage update for {display_name} timed out")
            results["failed"] += 1
            # Update status to error if timeout occurred outside compute_incremental_coverage's handling
            await update_one_with_retry(
                coverage_metadata_collection,
                {"_id": doc["_id"]},
                {
                    "$set": {
                        "status": "error",
                        "last_error": error_msg,
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as e:
            error_msg = f"Error updating coverage for {display_name}: {e}"
            logger.error(error_msg, exc_info=True)
            results["failed"] += 1
            # Update status to error
            await update_one_with_retry(
                coverage_metadata_collection,
                {"_id": doc["_id"]},
                {
                    "$set": {
                        "status": "error",
                        "last_error": str(e),
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )

        # Optional: Short delay between processing locations to reduce load spikes
        await asyncio.sleep(2)

    logger.info(
        f"Finished bulk coverage update run: {results['updated']} updated, {results['failed']} failed, {results['skipped']} skipped"
    )
    return results
