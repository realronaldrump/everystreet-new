"""
Street coverage calculation module.
Calculates the percentage of street segments that have been driven based on trip data.
Optimized for memory efficiency with batch processing, incremental updates and proper cleanup.
"""

import asyncio
import json
import logging
import gc
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple, Iterable

import multiprocessing
from concurrent.futures import ProcessPoolExecutor, TimeoutError

import pyproj
import rtree
from shapely.geometry import box, LineString, shape
from shapely.ops import transform
from pyproj import Transformer
from dotenv import load_dotenv

from db import (
    db_manager,
    streets_collection,
    trips_collection,
    coverage_metadata_collection,
    progress_collection,
    ensure_street_coverage_indexes,
    batch_cursor,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

WGS84 = pyproj.CRS("EPSG:4326")

# Constants for memory and batch management
MAX_STREETS_PER_BATCH = 1000
MAX_TRIPS_PER_BATCH = 50
BATCH_PROCESS_DELAY = 0.2
PROCESS_TIMEOUT = 1200
PROGRESS_UPDATE_INTERVAL = 2


class CoverageCalculator:
    """
    Memory-efficient implementation for calculating street coverage based on trips.
    Uses batch processing and careful memory management to avoid OOM issues.
    """

    def __init__(self, location: Dict[str, Any], task_id: str) -> None:
        self.location = location
        self.task_id = task_id
        self.streets_index = rtree.index.Index()
        self.streets_lookup: Dict[int, Dict[str, Any]] = {}
        self.utm_proj: Optional[pyproj.CRS] = None
        self.utm_transformer = None
        self.wgs84_transformer = None
        self.project_to_utm = None
        self.project_to_wgs84 = None

        self.match_buffer: float = 15.0
        self.min_match_length: float = 5.0
        self.street_chunk_size: int = MAX_STREETS_PER_BATCH
        self.trip_batch_size: int = MAX_TRIPS_PER_BATCH
        self.boundary_box = None

        self.total_length: float = 0.0
        self.covered_segments: Set[str] = set()
        self.segment_coverage = defaultdict(int)
        self.total_trips: int = 0
        self.processed_trips: int = 0
        self.batch_counter: int = 0

        # Process pool with proper lifecycle management
        self.process_pool = None
        self.max_workers = max(
            2, min(multiprocessing.cpu_count() // 2, 3)
        )  # Reduced worker count to avoid memory pressure

    def initialize_projections(self) -> None:
        """Initialize map projections based on location center."""
        center_lat, center_lon = self._get_location_center()
        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"
        self.utm_proj = pyproj.CRS(
            f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84"
        )
        # Store both the transformer object and its transform function
        self.utm_transformer = pyproj.Transformer.from_crs(
            WGS84, self.utm_proj, always_xy=True
        )
        self.project_to_utm = self.utm_transformer.transform

        self.wgs84_transformer = pyproj.Transformer.from_crs(
            self.utm_proj, WGS84, always_xy=True
        )
        self.project_to_wgs84 = self.wgs84_transformer.transform

    def _get_location_center(self) -> Tuple[float, float]:
        """Get the center coordinates of the location."""
        if "boundingbox" in self.location:
            bbox = self.location["boundingbox"]
            return (float(bbox[0]) + float(bbox[1])) / 2, (
                float(bbox[2]) + float(bbox[3])
            ) / 2
        return 0.0, 0.0

    async def update_progress(
        self, stage: str, progress: float, message: str = "", error: str = ""
    ) -> None:
        """Update progress information in the database."""
        try:
            # Only update every PROGRESS_UPDATE_INTERVAL batches to reduce database load
            self.batch_counter += 1
            if (
                self.batch_counter % PROGRESS_UPDATE_INTERVAL != 0
                and stage != "complete"
                and stage != "error"
            ):
                return

            update_data = {
                "stage": stage,
                "progress": progress,
                "message": message,
                "updated_at": datetime.now(timezone.utc),
                "location": self.location.get("display_name", "Unknown"),
                "total_trips": self.total_trips,
                "processed_trips": self.processed_trips,
                "total_length": self.total_length,
                "covered_segments": len(self.covered_segments),
            }
            if error:
                update_data["error"] = error
            await progress_collection.update_one(
                {"_id": self.task_id}, {"$set": update_data}, upsert=True
            )
        except Exception as e:
            logger.error("Error updating progress: %s", e)

    async def initialize(self) -> None:
        """Initialize projections and create process pool."""
        self.initialize_projections()
        # Create process pool when needed
        if self.process_pool is None:
            try:
                self.process_pool = ProcessPoolExecutor(max_workers=self.max_workers)
                # Set a lower max_tasks_per_child to prevent memory build-up
                if hasattr(self.process_pool, "_max_workers"):
                    self.process_pool._max_workers = self.max_workers
            except Exception as e:
                logger.error("Failed to create process pool: %s", e)
                # Fall back to a single worker as safety
                self.process_pool = ProcessPoolExecutor(max_workers=1)

    async def build_spatial_index(self, streets_cursor) -> None:
        """
        Build spatial index for streets in memory-efficient batches.

        Args:
            streets_cursor: MongoDB cursor for streets
        """
        logger.info("Building spatial index for streets...")
        batch_num = 0
        total_streets = 0

        try:
            # Process in batches using the batch_cursor helper
            async for street_batch in batch_cursor(
                streets_cursor, self.street_chunk_size
            ):
                batch_num += 1
                batch_len = len(street_batch)
                total_streets += batch_len

                logger.info(
                    f"Processing street batch {batch_num} with {batch_len} streets"
                )
                try:
                    # Process with timeout to avoid hanging
                    await asyncio.wait_for(
                        asyncio.to_thread(self._process_street_chunk, street_batch),
                        timeout=PROCESS_TIMEOUT,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        f"Timeout processing street batch {batch_num}, continuing with partial data"
                    )

                # Update progress
                await self.update_progress(
                    "indexing",
                    min(50, 20 + (batch_num * 5)),
                    f"Indexed {total_streets} streets ({batch_num} batches)",
                )

                # Yield to event loop to prevent blocking
                await asyncio.sleep(BATCH_PROCESS_DELAY)

                # Explicitly run garbage collection every few batches
                if batch_num % 5 == 0:
                    gc.collect()

            logger.info(
                f"Completed building spatial index with {total_streets} streets"
            )

        except Exception as e:
            logger.error(f"Error in build_spatial_index: {str(e)}", exc_info=True)
            await self.update_progress(
                "error", 0, f"Error building spatial index: {str(e)}", error=str(e)
            )
            raise

    def _process_street_chunk(self, streets: List[Dict[str, Any]]) -> None:
        """Process a batch of streets to add to the spatial index."""
        for street in streets:
            try:
                geom = shape(street["geometry"])
                bounds = geom.bounds
                current_idx = len(self.streets_lookup)
                self.streets_index.insert(current_idx, bounds)

                # Store only essential data to reduce memory usage
                essential_props = {
                    "segment_id": street.get("properties", {}).get("segment_id"),
                    "location": street.get("properties", {}).get("location"),
                    "highway": street.get("properties", {}).get("highway", "unknown"),
                    "name": street.get("properties", {}).get("name", "Unnamed Street"),
                    "driven": street.get("properties", {}).get("driven", False),
                }

                # Keep only necessary parts of the street object
                self.streets_lookup[current_idx] = {
                    "geometry": street["geometry"],
                    "properties": essential_props,
                }

                street_utm = transform(self.project_to_utm, geom)
                street["properties"]["segment_length"] = street_utm.length
                self.total_length += street_utm.length

                # Add segment to covered_segments if it's already marked as driven
                if essential_props["driven"]:
                    segment_id = essential_props["segment_id"]
                    if segment_id:
                        self.covered_segments.add(segment_id)
            except Exception as e:
                logger.error(
                    "Error indexing street (ID %s): %s",
                    street.get("properties", {}).get("segment_id"),
                    e,
                )

    async def calculate_boundary_box(self, streets_cursor) -> box:
        """
        Calculate the bounding box of all streets.

        Args:
            streets_cursor: MongoDB cursor for streets

        Returns:
            shapely.geometry.box: Bounding box
        """
        bounds: Optional[Tuple[float, float, float, float]] = None
        batch_num = 0

        try:
            async for street_batch in batch_cursor(
                streets_cursor, self.street_chunk_size
            ):
                batch_num += 1
                try:
                    # Process with timeout
                    chunk_bounds = await asyncio.wait_for(
                        asyncio.to_thread(self._process_boundary_chunk, street_batch),
                        timeout=PROCESS_TIMEOUT,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        f"Timeout processing boundary chunk {batch_num}, continuing with partial data"
                    )
                    continue

                if chunk_bounds is None:
                    continue

                if bounds is None:
                    bounds = chunk_bounds
                else:
                    bounds = (
                        min(bounds[0], chunk_bounds[0]),
                        min(bounds[1], chunk_bounds[1]),
                        max(bounds[2], chunk_bounds[2]),
                        max(bounds[3], chunk_bounds[3]),
                    )

                # Avoid blocking the event loop
                await asyncio.sleep(BATCH_PROCESS_DELAY)

                # Run GC occasionally
                if batch_num % 5 == 0:
                    gc.collect()

            logger.info(f"Boundary calculation completed after {batch_num} batches")
            return box(*bounds) if bounds else box(0, 0, 0, 0)

        except Exception as e:
            logger.error(f"Error in calculate_boundary_box: {str(e)}", exc_info=True)
            await self.update_progress(
                "error", 0, f"Error calculating boundary: {str(e)}", error=str(e)
            )
            raise

    @staticmethod
    def _process_boundary_chunk(
        streets: List[Dict[str, Any]],
    ) -> Optional[Tuple[float, float, float, float]]:
        """Calculate boundary from a batch of streets."""
        bounds: Optional[List[float]] = None
        for street in streets:
            try:
                geom = shape(street["geometry"])
                if bounds is None:
                    bounds = list(geom.bounds)
                else:
                    bounds[0] = min(bounds[0], geom.bounds[0])
                    bounds[1] = min(bounds[1], geom.bounds[1])
                    bounds[2] = max(bounds[2], geom.bounds[2])
                    bounds[3] = max(bounds[3], geom.bounds[3])
            except Exception as e:
                logger.error("Error computing boundary for a street: %s", e)
        return tuple(bounds) if bounds else None

    @staticmethod
    def _is_valid_trip(gps_data: Any) -> Tuple[bool, List[Any]]:
        """Check if trip GPS data is valid and extract coordinates."""
        try:
            data = json.loads(gps_data) if isinstance(gps_data, str) else gps_data
            coords = data.get("coordinates", [])
            return (False, []) if len(coords) < 2 else (True, coords)
        except Exception as e:
            logger.error("Error decoding GPS data: %s", e, exc_info=True)
            return False, []

    def is_trip_in_boundary(self, trip: Dict[str, Any]) -> bool:
        """Check if a trip intersects with the boundary box."""
        try:
            gps_data = trip.get("gps")
            if not gps_data:
                return False
            valid, coords = self._is_valid_trip(gps_data)
            if not valid or not coords:
                return False

            # Create a simplified line for boundary check to reduce computation
            if len(coords) > 50:
                stride = len(coords) // 50
                simplified_coords = coords[::stride]
                if simplified_coords[-1] != coords[-1]:
                    simplified_coords.append(coords[-1])
            else:
                simplified_coords = coords

            return self.boundary_box.intersects(LineString(simplified_coords))
        except Exception as e:
            logger.error("Error checking boundary for trip %s: %s", trip.get("_id"), e)
            return False

    def _process_trip_sync(self, coords: List[Any]) -> Set[str]:
        """
        Process a single trip's coordinates to find covered street segments.
        This runs in a worker process.
        """
        covered: Set[str] = set()
        try:
            # Handle case with too few points
            if len(coords) < 2:
                return covered

            trip_line = LineString(coords)
            trip_line_utm = transform(self.project_to_utm, trip_line)
            trip_buffer = trip_line_utm.buffer(self.match_buffer)
            trip_buffer_wgs84 = transform(self.project_to_wgs84, trip_buffer)

            # Get candidate streets from the spatial index
            candidates = list(self.streets_index.intersection(trip_buffer_wgs84.bounds))

            for idx in candidates:
                street = self.streets_lookup[idx]
                street_geom = shape(street["geometry"])
                street_utm = transform(self.project_to_utm, street_geom)
                intersection = trip_buffer.intersection(street_utm)
                if (
                    not intersection.is_empty
                    and intersection.length >= self.min_match_length
                ):
                    seg_id = street["properties"].get("segment_id")
                    if seg_id:
                        covered.add(seg_id)
        except Exception as e:
            logger.error("Error processing trip synchronously: %s", e, exc_info=True)
        return covered

    @staticmethod
    def _process_trip_sync_worker(
        coords: List[Any],
        utm_proj_string: str,
        wgs84_proj_string: str,
        streets_data: List[Dict],
        match_buffer: float,
        min_match_length: float,
    ) -> Set[str]:
        """
        Static worker function that can be pickled for multiprocessing.
        Optimized to reduce memory usage by passing minimal data.
        """
        covered: Set[str] = set()
        try:
            # Handle case with too few points
            if len(coords) < 2:
                return covered

            # Recreate the transformers in the worker process
            utm_proj = pyproj.CRS.from_string(utm_proj_string)
            wgs84_proj = pyproj.CRS.from_string(wgs84_proj_string)

            # Create transform functions
            project_to_utm = pyproj.Transformer.from_crs(
                wgs84_proj, utm_proj, always_xy=True
            ).transform

            project_to_wgs84 = pyproj.Transformer.from_crs(
                utm_proj, wgs84_proj, always_xy=True
            ).transform

            # Process the trip
            trip_line = LineString(coords)
            trip_line_utm = transform(project_to_utm, trip_line)
            trip_buffer = trip_line_utm.buffer(match_buffer)

            # Process each street
            for street in streets_data:
                try:
                    street_geom = shape(street["geometry"])

                    # Quick boundary check before more expensive operations
                    if (
                        not trip_buffer.bounds[0] <= street_geom.bounds[2]
                        and not trip_buffer.bounds[2] >= street_geom.bounds[0]
                        and not trip_buffer.bounds[1] <= street_geom.bounds[3]
                        and not trip_buffer.bounds[3] >= street_geom.bounds[1]
                    ):
                        continue

                    street_utm = transform(project_to_utm, street_geom)
                    intersection = trip_buffer.intersection(street_utm)

                    if (
                        not intersection.is_empty
                        and intersection.length >= min_match_length
                    ):
                        seg_id = street.get("properties", {}).get("segment_id")
                        if seg_id:
                            covered.add(seg_id)
                except Exception:
                    # Skip problematic streets
                    continue

        except Exception as e:
            # Use string formatting with % for logging as per requirements
            logger.error("Error processing trip in worker: %s", e)

        return covered

    async def process_trip_batch(self, trips: List[Dict[str, Any]]) -> None:
        """Process a batch of trips to update coverage statistics."""
        valid_trips = []

        # Filter trips that are in the boundary
        for trip in trips:
            if self.boundary_box and self.is_trip_in_boundary(trip):
                gps_data = trip.get("gps")
                if gps_data:
                    valid, coords = self._is_valid_trip(gps_data)
                    if valid:
                        valid_trips.append(coords)

        # Process valid trips
        if valid_trips:
            # Process trips in smaller sub-batches to avoid memory pressure
            sub_batch_size = 5  # Reduced from 10 to 5
            for i in range(0, len(valid_trips), sub_batch_size):
                sub_batch = valid_trips[i : i + sub_batch_size]

                # Use process pool for CPU-intensive work if available
                if self.process_pool is not None:
                    try:
                        # Prepare minimal data for multiprocessing
                        utm_proj_string = self.utm_proj.to_string()
                        wgs84_proj_string = WGS84.to_string()

                        # Instead of passing the entire streets lookup, filter to likely candidates
                        # based on the trip's bounding box
                        candidate_streets = []
                        for trip_coords in sub_batch:
                            try:
                                trip_line = LineString(trip_coords)
                                bounds = trip_line.bounds
                                # Expand bounds a bit to ensure we catch all relevant streets
                                expanded_bounds = (
                                    bounds[0] - 0.01,
                                    bounds[1] - 0.01,
                                    bounds[2] + 0.01,
                                    bounds[3] + 0.01,
                                )
                                for idx in self.streets_index.intersection(
                                    expanded_bounds
                                ):
                                    if idx not in candidate_streets:
                                        candidate_streets.append(
                                            self.streets_lookup[idx]
                                        )
                            except Exception:
                                continue

                        # If we have too many candidates, sample them to reduce memory
                        if len(candidate_streets) > 100000:
                            logger.warning(
                                f"Too many candidate streets ({len(candidate_streets)}), sampling to 100000"
                            )
                            # Take a sample by stride
                            stride = len(candidate_streets) // 5000
                            candidate_streets = candidate_streets[::stride]

                        # Submit trips to process pool with timeout
                        futures = []
                        for coords in sub_batch:
                            future = self.process_pool.submit(
                                self._process_trip_sync_worker,
                                coords,
                                utm_proj_string,
                                wgs84_proj_string,
                                candidate_streets,
                                self.match_buffer,
                                self.min_match_length,
                            )
                            futures.append(future)

                        # Gather results as they complete, with timeouts
                        for future in futures:
                            try:
                                # Add a timeout to prevent hung workers
                                covered_segments = future.result(timeout=60)
                                for seg in covered_segments:
                                    self.covered_segments.add(seg)
                                    self.segment_coverage[seg] += 1
                            except TimeoutError:
                                logger.warning(
                                    "Worker process timed out, skipping trip"
                                )
                                continue
                    except Exception as e:
                        logger.error("Error in multiprocessing: %s", e, exc_info=True)
                        # Fall back to sequential processing
                        for coords in sub_batch:
                            covered = self._process_trip_sync(coords)
                            for seg in covered:
                                self.covered_segments.add(seg)
                                self.segment_coverage[seg] += 1
                else:
                    # Fall back to sequential processing if pool unavailable
                    for coords in sub_batch:
                        try:
                            covered = await asyncio.wait_for(
                                asyncio.to_thread(self._process_trip_sync, coords),
                                timeout=30,
                            )
                            for seg in covered:
                                self.covered_segments.add(seg)
                                self.segment_coverage[seg] += 1
                        except asyncio.TimeoutError:
                            logger.warning("Trip processing timed out, skipping")

                # Update progress tracking
                self.processed_trips += len(sub_batch)
                progress_val = (
                    (self.processed_trips / self.total_trips * 100)
                    if self.total_trips > 0
                    else 0
                )

                # Update progress and yield to event loop
                await self.update_progress(
                    "processing_trips",
                    progress_val,
                    f"Processed {self.processed_trips} of {self.total_trips} trips",
                )
                await asyncio.sleep(BATCH_PROCESS_DELAY)

                # Run garbage collection regularly
                if i % 10 == 0:
                    gc.collect()

    async def compute_coverage(self) -> Optional[Dict[str, Any]]:
        """
        Main method to compute coverage statistics.

        Returns:
            Dict with coverage results or None if error
        """
        try:
            await self.update_progress(
                "initializing", 0, "Starting coverage calculation..."
            )

            # Ensure proper indexes exist
            await ensure_street_coverage_indexes()

            # Initialize projections and process pool
            await self.initialize()

            # Fetch streets for this location
            await self.update_progress("loading_streets", 10, "Loading street data...")
            streets_query = {"properties.location": self.location.get("display_name")}

            # Check if we have any streets
            streets_count = await streets_collection.count_documents(streets_query)
            if streets_count == 0:
                msg = "No streets found for location"
                logger.warning(msg)
                await self.update_progress("error", 0, msg)
                return None

            # Build spatial index in batches
            await self.update_progress("indexing", 20, "Building spatial index...")
            try:
                streets_cursor = streets_collection.find(streets_query)
                await self.build_spatial_index(streets_cursor)
            except Exception as e:
                logger.error(f"Error building spatial index: {str(e)}", exc_info=True)
                await self.update_progress("error", 0, f"Error: {str(e)}")
                return None

            # Calculate boundary
            try:
                streets_cursor = streets_collection.find(streets_query)
                self.boundary_box = await self.calculate_boundary_box(streets_cursor)
            except Exception as e:
                logger.error(f"Error calculating boundary: {str(e)}", exc_info=True)
                await self.update_progress("error", 0, f"Error: {str(e)}")
                return None

            # Retrieve processed trip data from metadata
            metadata = await coverage_metadata_collection.find_one(
                {"location.display_name": self.location.get("display_name")}
            )
            processed_trip_ids = []
            if metadata and "processed_trips" in metadata:
                processed_trip_ids = metadata.get("processed_trips", {}).get(
                    "trip_ids", []
                )

            # Count trips before processing to support progress reporting
            await self.update_progress("counting_trips", 30, "Counting trips...")
            bbox = self.boundary_box.bounds
            trip_filter = {
                "gps": {"$exists": True},
                "$or": [
                    {
                        "startGeoPoint": {
                            "$geoWithin": {
                                "$box": [[bbox[0], bbox[1]], [bbox[2], bbox[3]]]
                            }
                        }
                    },
                    {
                        "destinationGeoPoint": {
                            "$geoWithin": {
                                "$box": [[bbox[0], bbox[1]], [bbox[2], bbox[3]]]
                            }
                        }
                    },
                ],
            }

            # Exclude already processed trips if available
            if processed_trip_ids:
                str_ids = [str(id) for id in processed_trip_ids]
                trip_filter["_id"] = {
                    "$nin": [ObjectId(id) for id in str_ids if ObjectId.is_valid(id)]
                }
                trip_filter["transactionId"] = {"$nin": str_ids}

            try:
                self.total_trips = await trips_collection.count_documents(trip_filter)
            except Exception as e:
                logger.error(f"Error counting trips: {str(e)}", exc_info=True)
                self.total_trips = 0  # Continue with a default

            # Process trips in batches
            await self.update_progress(
                "processing_trips", 40, f"Processing {self.total_trips} trips..."
            )

            try:
                # Process trips in batches using cursor to limit memory usage
                trips_cursor = trips_collection.find(trip_filter)
                async for trip_batch in batch_cursor(
                    trips_cursor, self.trip_batch_size
                ):
                    await self.process_trip_batch(trip_batch)
                    # Add processed trip IDs to the list
                    for trip in trip_batch:
                        processed_trip_ids.append(str(trip.get("_id")))
            except Exception as e:
                logger.error(f"Error processing trips: {str(e)}", exc_info=True)
                await self.update_progress("error", 0, f"Error: {str(e)}")
                return None

            # Clean up process pool
            if self.process_pool:
                self.process_pool.shutdown(wait=False)
                self.process_pool = None

            # Force garbage collection before generating statistics
            gc.collect()

            # Generate final statistics
            await self.update_progress(
                "finalizing", 95, "Calculating final coverage..."
            )

            # Calculate street type statistics and coverage
            covered_length = 0.0
            features = []
            street_type_stats = defaultdict(
                lambda: {"total": 0, "covered": 0, "length": 0, "covered_length": 0}
            )

            try:
                # Process streets in smaller batches
                streets_cursor = streets_collection.find(streets_query)
                batch_size = self.street_chunk_size  # Reduced batch size

                batch_idx = 0
                async for streets_batch in batch_cursor(streets_cursor, batch_size):
                    batch_idx += 1

                    for street in streets_batch:
                        seg_id = street["properties"].get("segment_id")
                        geom = shape(street["geometry"])
                        street_utm = transform(self.project_to_utm, geom)
                        seg_length = street_utm.length
                        is_covered = seg_id in self.covered_segments
                        street_type = street["properties"].get("highway", "unknown")

                        # Update street type statistics
                        street_type_stats[street_type]["total"] += 1
                        street_type_stats[street_type]["length"] += seg_length
                        if is_covered:
                            covered_length += seg_length
                            street_type_stats[street_type]["covered"] += 1
                            street_type_stats[street_type][
                                "covered_length"
                            ] += seg_length

                        # Create enhanced feature for visualization
                        feature = {
                            "type": "Feature",
                            "geometry": street["geometry"],
                            "properties": {
                                **street["properties"],
                                "driven": is_covered,
                                "coverage_count": self.segment_coverage.get(seg_id, 0),
                                "segment_length": seg_length,
                                "segment_id": seg_id,
                                "street_type": street_type,
                                "name": street["properties"].get(
                                    "name", "Unnamed Street"
                                ),
                            },
                        }
                        features.append(feature)

                        # Update the street document with driven status
                        if is_covered:
                            await streets_collection.update_one(
                                {"properties.segment_id": seg_id},
                                {
                                    "$set": {
                                        "properties.driven": True,
                                        "properties.last_coverage_update": datetime.now(
                                            timezone.utc
                                        ),
                                    }
                                },
                            )

                    # Yield to event loop occasionally and run GC periodically
                    if batch_idx % 3 == 0:
                        await asyncio.sleep(BATCH_PROCESS_DELAY)
                        gc.collect()
            except Exception as e:
                logger.error(f"Error generating statistics: {str(e)}", exc_info=True)
                await self.update_progress("error", 0, f"Error: {str(e)}")
                return None

            # Calculate coverage percentage
            coverage_percentage = (
                (covered_length / self.total_length * 100)
                if self.total_length > 0
                else 0
            )

            # Prepare street type stats for output
            street_types = []
            for street_type, stats in street_type_stats.items():
                coverage_pct = (
                    (stats["covered_length"] / stats["length"] * 100)
                    if stats["length"] > 0
                    else 0
                )
                street_types.append(
                    {
                        "type": street_type,
                        "total": stats["total"],
                        "covered": stats["covered"],
                        "length": stats["length"],
                        "covered_length": stats["covered_length"],
                        "coverage_percentage": coverage_pct,
                    }
                )

            # Sort by total length
            street_types.sort(key=lambda x: x["length"], reverse=True)

            # Prepare GeoJSON output - can be very large, so be careful with memory
            streets_geojson = {
                "type": "FeatureCollection",
                "features": features,
                "metadata": {
                    "total_length": self.total_length,
                    "total_length_miles": self.total_length * 0.000621371,
                    "driven_length": covered_length,
                    "driven_length_miles": covered_length * 0.000621371,
                    "coverage_percentage": coverage_percentage,
                    "street_types": street_types,
                    "updated_at": datetime.now().isoformat(),
                },
            }

            # Update processed trips in metadata
            await coverage_metadata_collection.update_one(
                {"location.display_name": self.location.get("display_name")},
                {
                    "$set": {
                        "processed_trips.trip_ids": processed_trip_ids,
                        "processed_trips.last_processed_timestamp": datetime.now(
                            timezone.utc
                        ),
                    }
                },
                upsert=True,
            )

            await self.update_progress("complete", 100, "Coverage calculation complete")

            return {
                "total_length": self.total_length,
                "driven_length": covered_length,
                "coverage_percentage": coverage_percentage,
                "streets_data": streets_geojson,
                "total_segments": len(features),
                "street_types": street_types,
            }

        except Exception as e:
            logger.error("Error computing coverage: %s", e, exc_info=True)
            await self.update_progress("error", 0, f"Error: {str(e)}")

            # Clean up resources
            if self.process_pool:
                self.process_pool.shutdown(wait=False)
                self.process_pool = None

            return None
        finally:
            # Ensure resources are cleaned up
            self.streets_lookup = {}
            self.streets_index = None
            gc.collect()


async def compute_coverage_for_location(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """
    Compute coverage for a specific location.

    Args:
        location: Location dictionary
        task_id: Task identifier for progress tracking

    Returns:
        Coverage statistics or None if error
    """
    calculator = CoverageCalculator(location, task_id)
    try:
        # Set a timeout for the entire operation
        return await asyncio.wait_for(
            calculator.compute_coverage(),
            timeout=3600,  # 1 hour timeout for the whole operation
        )
    except asyncio.TimeoutError:
        logger.error(
            f"Coverage calculation for {location.get('display_name')} timed out"
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "progress": 0,
                    "message": "Calculation timed out after 1 hour",
                    "error": "Operation timed out",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        return None
    except Exception as e:
        logger.exception(f"Error in coverage calculation: {str(e)}")
        return None
    finally:
        # Ensure resources are cleaned up
        if calculator.process_pool:
            calculator.process_pool.shutdown(wait=False)
            calculator.process_pool = None
        # Clean up memory
        gc.collect()


async def compute_incremental_coverage(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """
    Compute coverage only for new trips since the last update.

    Args:
        location: Location dictionary containing display_name and boundary info
        task_id: Task identifier for progress tracking

    Returns:
        Dictionary with coverage statistics or None if error
    """
    try:
        # Get current metadata including last processed timestamp
        metadata = await coverage_metadata_collection.find_one(
            {"location.display_name": location.get("display_name")}
        )

        if not metadata:
            logger.warning(
                f"No metadata found for {location.get('display_name')}, running full calculation"
            )
            return await compute_coverage_for_location(location, task_id)

        # Get latest timestamp or default to very old date
        last_processed = metadata.get("processed_trips", {}).get(
            "last_processed_timestamp", datetime(1970, 1, 1, tzinfo=timezone.utc)
        )

        processed_trip_ids = set(
            metadata.get("processed_trips", {}).get("trip_ids", [])
        )
        logger.info(f"Found {len(processed_trip_ids)} previously processed trips")

        # Get boundary box for location
        bbox = location.get("boundingbox", [])
        if len(bbox) != 4:
            raise ValueError("Invalid bounding box in location data")

        # Create boundary box for geospatial queries
        boundary_box = box(
            float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
        )

        # Find only new trips since the last update
        new_trips_query = {
            "startTime": {"$gt": last_processed},
            "$or": [
                {
                    "startGeoPoint": {
                        "$geoWithin": {
                            "$box": [
                                [float(bbox[0]), float(bbox[1])],
                                [float(bbox[2]), float(bbox[3])],
                            ]
                        }
                    }
                },
                {
                    "destinationGeoPoint": {
                        "$geoWithin": {
                            "$box": [
                                [float(bbox[0]), float(bbox[1])],
                                [float(bbox[2]), float(bbox[3])],
                            ]
                        }
                    }
                },
            ],
        }

        # Update progress
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "counting_trips",
                    "progress": 20,
                    "message": "Finding new trips since last update",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )

        # Count new trips for progress reporting
        new_trips_count = await trips_collection.count_documents(new_trips_query)
        logger.info(f"Found {new_trips_count} new trips to process")

        # No new trips to process
        if new_trips_count == 0:
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "complete",
                        "progress": 100,
                        "message": "No new trips to process",
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )

            # Return current coverage stats
            return {
                "total_length": metadata.get("total_length", 0),
                "driven_length": metadata.get("driven_length", 0),
                "coverage_percentage": metadata.get("coverage_percentage", 0),
                "total_segments": metadata.get("total_segments", 0),
                "street_types": metadata.get("street_types", []),
            }

        # Process new trips in batches
        new_trips_cursor = trips_collection.find(new_trips_query)
        processed_count = 0
        new_covered_segments = set()

        # Update progress
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "processing_trips",
                    "progress": 30,
                    "message": f"Processing {new_trips_count} new trips",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )

        # Process trips in batches
        async for trip_batch in batch_cursor(new_trips_cursor, 50):
            batch_covered_segments = await process_trip_batch_for_coverage(
                trip_batch, location.get("display_name"), boundary_box
            )

            # Track newly processed trips and covered segments
            for trip in trip_batch:
                processed_trip_ids.add(str(trip.get("_id")))

            new_covered_segments.update(batch_covered_segments)
            processed_count += len(trip_batch)

            # Update progress
            progress = 30 + (processed_count / new_trips_count * 50)
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "progress": min(80, progress),
                        "message": f"Processed {processed_count} of {new_trips_count} trips",
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )

            # Allow event loop to process other tasks
            await asyncio.sleep(0.1)

        # Update progress
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "finalizing",
                    "progress": 90,
                    "message": "Calculating final coverage statistics",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )

        # Calculate updated coverage statistics
        coverage_stats = await calculate_coverage_summary(location.get("display_name"))

        # Update metadata with new processed trips list
        await coverage_metadata_collection.update_one(
            {"location.display_name": location.get("display_name")},
            {
                "$set": {
                    "total_length": coverage_stats["total_length"],
                    "driven_length": coverage_stats["driven_length"],
                    "coverage_percentage": coverage_stats["coverage_percentage"],
                    "street_types": coverage_stats["street_types"],
                    "total_segments": coverage_stats["total_segments"],
                    "last_updated": datetime.now(timezone.utc),
                    "processed_trips.trip_ids": list(processed_trip_ids),
                    "processed_trips.last_processed_timestamp": datetime.now(
                        timezone.utc
                    ),
                }
            },
        )

        # Mark calculation complete
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "complete",
                    "progress": 100,
                    "message": "Incremental coverage calculation complete",
                    "result": coverage_stats,
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )

        logger.info(
            f"Completed incremental coverage update for {location.get('display_name')}"
        )
        return coverage_stats

    except Exception as e:
        logger.exception(f"Error in incremental coverage calculation: {str(e)}")
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "progress": 0,
                    "message": f"Error: {str(e)}",
                    "error": str(e),
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )
        return None


async def process_trip_batch_for_coverage(
    trip_batch: List[Dict[str, Any]],
    location_name: str,
    boundary_box: box,
    buffer_distance: float = 15.0,
    min_match_length: float = 5.0,
) -> Set[str]:
    """
    Process a batch of trips to update street coverage.

    Args:
        trip_batch: List of trip documents
        location_name: Name of location for filtering streets
        boundary_box: Shapely box representing location boundary
        buffer_distance: Buffer around trip lines (meters)
        min_match_length: Minimum intersection length to consider covered (meters)

    Returns:
        Set of segment IDs that were covered by these trips
    """
    covered_segments = set()

    # Prepare projection for distance calculations
    wgs84 = pyproj.CRS("EPSG:4326")

    # Get center of boundary box for appropriate UTM projection
    center_lat = (boundary_box.bounds[1] + boundary_box.bounds[3]) / 2
    center_lon = (boundary_box.bounds[0] + boundary_box.bounds[2]) / 2

    # Determine UTM zone from center coordinates
    utm_zone = int((center_lon + 180) / 6) + 1
    hemisphere = "north" if center_lat >= 0 else "south"

    # Create UTM projection
    utm_proj = pyproj.CRS(f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84")

    # Create transformers
    project_to_utm = pyproj.Transformer.from_crs(
        wgs84, utm_proj, always_xy=True
    ).transform
    project_to_wgs84 = pyproj.Transformer.from_crs(
        utm_proj, wgs84, always_xy=True
    ).transform

    # Process each trip
    for trip in trip_batch:
        trip_id = str(trip.get("_id"))

        # Extract GPS data
        gps_data = trip.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except json.JSONDecodeError:
                logger.warning(f"Could not parse GPS data for trip {trip_id}")
                continue

        # Get coordinates
        if not gps_data or "coordinates" not in gps_data:
            logger.warning(f"No coordinates in GPS data for trip {trip_id}")
            continue

        coordinates = gps_data.get("coordinates", [])
        if len(coordinates) < 2:
            logger.warning(f"Insufficient coordinates for trip {trip_id}")
            continue

        # Create trip line
        try:
            trip_line = LineString(coordinates)

            # Skip if trip doesn't intersect boundary
            if not boundary_box.intersects(trip_line):
                continue

            # Convert to UTM for proper distance measurements
            trip_line_utm = transform(project_to_utm, trip_line)
            trip_buffer = trip_line_utm.buffer(buffer_distance)
            trip_buffer_wgs84 = transform(project_to_wgs84, trip_buffer)

            # Find streets that might be covered using spatial query
            streets_query = {
                "properties.location": location_name,
                "geometry": {
                    "$geoIntersects": {"$geometry": trip_buffer_wgs84.__geo_interface__}
                },
            }

            streets = await streets_collection.find(streets_query).to_list(length=1000)

            # Check each street for coverage
            for street in streets:
                try:
                    street_geom = shape(street.get("geometry"))
                    street_utm = transform(project_to_utm, street_geom)

                    # Test intersection
                    intersection = trip_buffer.intersection(street_utm)

                    if (
                        not intersection.is_empty
                        and intersection.length >= min_match_length
                    ):
                        # This street segment is covered
                        segment_id = street.get("properties", {}).get("segment_id")
                        if segment_id:
                            covered_segments.add(segment_id)

                            # Update street document to mark as driven
                            await streets_collection.update_one(
                                {"properties.segment_id": segment_id},
                                {
                                    "$set": {
                                        "properties.driven": True,
                                        "properties.last_coverage_update": datetime.now(
                                            timezone.utc
                                        ),
                                    },
                                    "$addToSet": {
                                        "properties.covered_by_trips": trip_id
                                    },
                                },
                            )
                except Exception as e:
                    logger.error(f"Error checking street coverage: {str(e)}")
                    continue

        except Exception as e:
            logger.error(f"Error processing trip {trip_id}: {str(e)}")
            continue

    return covered_segments


async def calculate_coverage_summary(location_name: str) -> Dict[str, Any]:
    """
    Calculate coverage metrics from street data without reprocessing all trips.
    Uses aggregation pipeline for efficiency.

    Args:
        location_name: Name of location to calculate coverage for

    Returns:
        Dictionary with coverage statistics
    """
    # Use MongoDB aggregation pipeline for efficient calculation
    pipeline = [
        {"$match": {"properties.location": location_name}},
        {
            "$group": {
                "_id": "$properties.highway",
                "total_count": {"$sum": 1},
                "driven_count": {
                    "$sum": {"$cond": [{"$eq": ["$properties.driven", True]}, 1, 0]}
                },
                "total_length": {"$sum": "$properties.segment_length"},
                "driven_length": {
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
        {
            "$project": {
                "type": "$_id",
                "total": "$total_count",
                "covered": "$driven_count",
                "length": "$total_length",
                "covered_length": "$driven_length",
                "coverage_percentage": {
                    "$cond": [
                        {"$eq": ["$total_length", 0]},
                        0,
                        {
                            "$multiply": [
                                {"$divide": ["$driven_length", "$total_length"]},
                                100,
                            ]
                        },
                    ]
                },
            }
        },
        {"$sort": {"length": -1}},
    ]

    street_types = await streets_collection.aggregate(pipeline).to_list(100)

    # Calculate overall metrics
    total_segments = 0
    total_length = 0
    covered_length = 0

    for st in street_types:
        total_segments += st.get("total", 0)
        total_length += st.get("length", 0)
        covered_length += st.get("covered_length", 0)

    coverage_percentage = (
        (covered_length / total_length * 100) if total_length > 0 else 0
    )

    # Prepare GeoJSON streets data
    streets_query = {"properties.location": location_name}
    streets_cursor = streets_collection.find(streets_query)
    features = []

    async for street in streets_cursor:
        feature = {
            "type": "Feature",
            "geometry": street["geometry"],
            "properties": {
                **street["properties"],
                "segment_id": street["properties"].get("segment_id"),
                "street_type": street["properties"].get("highway", "unknown"),
                "name": street["properties"].get("name", "Unnamed Street"),
            },
        }
        features.append(feature)

    streets_geojson = {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "total_length": total_length,
            "total_length_miles": total_length * 0.000621371,
            "driven_length": covered_length,
            "driven_length_miles": covered_length * 0.000621371,
            "coverage_percentage": coverage_percentage,
            "street_types": street_types,
            "updated_at": datetime.now().isoformat(),
        },
    }

    # Build the complete summary
    return {
        "total_length": total_length,
        "driven_length": covered_length,
        "coverage_percentage": coverage_percentage,
        "total_segments": total_segments,
        "street_types": street_types,
        "streets_data": streets_geojson,
    }


async def update_coverage_for_all_locations() -> Dict[str, Any]:
    """
    Update coverage for all locations in the database incrementally.

    Returns:
        Dict with results summary
    """
    try:
        logger.info("Starting incremental coverage update for all locations...")
        results = {"updated": 0, "failed": 0, "skipped": 0, "locations": []}

        # Find all locations that need updating, sorted by last update time
        cursor = coverage_metadata_collection.find(
            {}, {"location": 1, "_id": 1, "last_updated": 1}
        ).sort("last_updated", 1)

        # Process each location with timeouts
        async for doc in cursor:
            loc = doc.get("location")
            if not loc or isinstance(loc, str):
                logger.warning(
                    f"Skipping doc {doc.get('_id')} - invalid location format"
                )
                results["skipped"] += 1
                continue

            # Generate a task ID for tracking progress
            task_id = f"bulk_update_{doc['_id']}"

            try:
                # Use the incremental update function
                result = await asyncio.wait_for(
                    compute_incremental_coverage(loc, task_id),
                    timeout=3600,  # 1 hour timeout per location
                )

                if result:
                    display_name = loc.get("display_name", "Unknown")

                    # Update the coverage metadata
                    await coverage_metadata_collection.update_one(
                        {"location.display_name": display_name},
                        {
                            "$set": {
                                "location": loc,
                                "total_length": result["total_length"],
                                "driven_length": result["driven_length"],
                                "coverage_percentage": result["coverage_percentage"],
                                "last_updated": datetime.now(timezone.utc),
                                "status": "completed",
                            }
                        },
                        upsert=True,
                    )

                    logger.info(
                        f"Updated coverage for {display_name}: {result['coverage_percentage']:.2f}%"
                    )

                    results["updated"] += 1
                    results["locations"].append(
                        {
                            "name": display_name,
                            "coverage": result["coverage_percentage"],
                        }
                    )
                else:
                    results["failed"] += 1

            except asyncio.TimeoutError:
                logger.error(f"Coverage update for {loc.get('display_name')} timed out")
                results["failed"] += 1

                # Update status to error
                try:
                    await coverage_metadata_collection.update_one(
                        {"_id": doc["_id"]},
                        {
                            "$set": {
                                "status": "error",
                                "last_error": "Calculation timed out after 1 hour",
                                "last_updated": datetime.now(timezone.utc),
                            }
                        },
                    )
                except Exception as update_err:
                    logger.error(f"Failed to update error status: {update_err}")

            except Exception as e:
                logger.error(
                    f"Error updating coverage for {loc.get('display_name')}: {e}"
                )
                results["failed"] += 1

                # Update status to error
                try:
                    await coverage_metadata_collection.update_one(
                        {"_id": doc["_id"]},
                        {
                            "$set": {
                                "status": "error",
                                "last_error": str(e),
                                "last_updated": datetime.now(timezone.utc),
                            }
                        },
                    )
                except Exception as update_err:
                    logger.error(f"Failed to update error status: {update_err}")

            # Force garbage collection after each location
            gc.collect()

        logger.info(
            f"Finished coverage update: {results['updated']} updated, "
            f"{results['failed']} failed, {results['skipped']} skipped"
        )
        return results

    except Exception as e:
        logger.error(f"Error updating coverage for all locations: {e}", exc_info=True)
        return {"error": str(e), "updated": 0, "failed": 0, "skipped": 0}
