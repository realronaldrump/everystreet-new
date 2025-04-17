"""Street coverage calculation module.

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
from concurrent.futures import CancelledError, Future, ProcessPoolExecutor, TimeoutError
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import bson.json_util
import numpy as np
import pyproj
import rtree
from bson import ObjectId
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorGridFSBucket
from pymongo.errors import BulkWriteError, OperationFailure
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPoint, box, shape
from shapely.ops import transform

from db import (
    batch_cursor,
    count_documents_with_retry,
    coverage_metadata_collection,
    db_manager,
    ensure_street_coverage_indexes,
    find_one_with_retry,
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

MAX_STREETS_PER_INDEX_BATCH = 10000
MAX_TRIPS_PER_BATCH = 500
TRIP_WORKER_SUB_BATCH = 100
BATCH_PROCESS_DELAY = 0.01
WORKER_RESULT_WAIT_TIMEOUT_S = 600
PROCESS_TIMEOUT_OVERALL = 7200
PROCESS_TIMEOUT_INCREMENTAL = 3600
PROGRESS_UPDATE_INTERVAL_TRIPS = 10

MAX_WORKERS_DEFAULT = max(1, multiprocessing.cpu_count())

MAX_STREETS_PER_WORKER_TASK = 5000

DEFAULT_MATCH_BUFFER_METERS = 15.0
DEFAULT_MIN_MATCH_LENGTH_METERS = 5.0


def process_trip_worker(
    trip_coords_list: List[List[Any]],
    candidate_utm_geoms: Dict[str, Any],
    candidate_utm_bboxes: Dict[str, Tuple[float, float, float, float]],
    utm_proj_string: str,
    wgs84_proj_string: str,
    match_buffer: float,
    min_match_length: float,
) -> Dict[int, Set[str]]:
    """Processes a batch of trips against candidate street UTM geometries."""
    start_time = datetime.now(timezone.utc)
    worker_pid = os.getpid()
    logger.debug(
        f"Worker {worker_pid}: Starting processing for {len(trip_coords_list)} trips "
        f"against {len(candidate_utm_geoms)} segments."
    )

    results: Dict[int, Set[str]] = defaultdict(set)
    if not trip_coords_list or not candidate_utm_geoms:
        logger.warning(
            f"Worker {worker_pid}: Empty trip list or candidate UTM geometries received."
        )
        return {}

    try:
        try:
            utm_proj = pyproj.CRS.from_string(utm_proj_string)
            wgs84_proj = pyproj.CRS.from_string(wgs84_proj_string)
            project_to_utm = pyproj.Transformer.from_crs(
                wgs84_proj,
                utm_proj,
                always_xy=True,
            ).transform
        except pyproj.exceptions.CRSError as e:
            logger.error(f"Worker {worker_pid}: Failed to initialize projections: {e}")
            return {}
        except Exception as proj_e:
            logger.error(
                f"Worker {worker_pid}: Unexpected error during projection setup: {proj_e}"
            )
            return {}

        street_utm_geoms = candidate_utm_geoms
        street_utm_bboxes_np = {
            seg_id: np.array(bbox)
            for seg_id, bbox in candidate_utm_bboxes.items()
            if bbox
        }

        for trip_index, trip_coords in enumerate(trip_coords_list):
            if len(trip_coords) < 2:
                continue

            try:
                trip_line_wgs84 = LineString(trip_coords)
                trip_line_utm = transform(
                    project_to_utm,
                    trip_line_wgs84,
                )
                trip_buffer_utm = trip_line_utm.buffer(match_buffer)
                trip_buffer_bounds = trip_buffer_utm.bounds
                trip_bbox_np = np.array(trip_buffer_bounds)

                for (
                    seg_id,
                    street_utm_geom,
                ) in street_utm_geoms.items():
                    if not street_utm_geom or seg_id not in street_utm_bboxes_np:
                        continue

                    street_bbox_np = street_utm_bboxes_np[seg_id]

                    if (
                        trip_bbox_np[0] > street_bbox_np[2]
                        or trip_bbox_np[2] < street_bbox_np[0]
                        or trip_bbox_np[1] > street_bbox_np[3]
                        or trip_bbox_np[3] < street_bbox_np[1]
                    ):
                        continue

                    intersection = trip_buffer_utm.intersection(street_utm_geom)

                    if (
                        not intersection.is_empty
                        and intersection.length >= min_match_length
                    ):
                        results[trip_index].add(seg_id)

            except (
                GEOSException,
                ValueError,
                TypeError,
            ) as trip_proc_err:
                logger.warning(
                    f"Worker {worker_pid}: Error processing trip at index {trip_index}: {trip_proc_err}"
                )
            except Exception as trip_e:
                logger.error(
                    f"Worker {worker_pid}: Unexpected error processing trip at index {trip_index}: {trip_e}"
                )

    except Exception as outer_e:
        logger.error(
            f"Worker {worker_pid}: Unhandled exception in process_trip_worker: {outer_e}",
            exc_info=True,
        )
        return {}

    end_time = datetime.now(timezone.utc)
    duration = (end_time - start_time).total_seconds()
    logger.debug(
        f"Worker {worker_pid}: Finished processing. Found matches for {len(results)} trips. "
        f"Duration: {duration:.2f}s"
    )

    return dict(results)


class CoverageCalculator:
    def __init__(
        self,
        location: Dict[str, Any],
        task_id: str,
    ) -> None:
        self.location = location
        self.location_name = location.get("display_name", "Unknown Location")
        self.task_id = task_id

        self.streets_index = rtree.index.Index()
        self.streets_lookup: Dict[int, Dict[str, Any]] = {}
        self.street_utm_geoms_cache: Dict[str, Any] = {}
        self.street_utm_bboxes_cache: Dict[str, Tuple[float, float, float, float]] = {}
        self.street_wgs84_geoms_cache: Dict[str, Dict] = {}

        self.utm_proj: Optional[pyproj.CRS] = None
        self.project_to_utm = None

        self.match_buffer: float = DEFAULT_MATCH_BUFFER_METERS
        self.min_match_length: float = DEFAULT_MIN_MATCH_LENGTH_METERS

        self.street_index_batch_size: int = MAX_STREETS_PER_INDEX_BATCH
        self.trip_batch_size: int = MAX_TRIPS_PER_BATCH
        self.trip_worker_sub_batch: int = TRIP_WORKER_SUB_BATCH
        self.process_pool: Optional[ProcessPoolExecutor] = None
        self.max_workers = int(
            os.getenv(
                "MAX_COVERAGE_WORKERS",
                str(MAX_WORKERS_DEFAULT),
            )
        )
        logger.info(
            "CoverageCalculator configured with max_workers=%d",
            self.max_workers,
        )

        self.total_length_calculated: float = 0.0
        self.total_driveable_length: float = 0.0
        self.initial_driven_length: float = 0.0
        self.initial_covered_segments: Set[str] = set()
        self.newly_covered_segments: Set[str] = set()
        self.total_trips_to_process: int = 0
        self.processed_trips_count: int = 0
        self.submitted_trips_count: int = 0

    def initialize_projections(self) -> None:
        """Initializes WGS84 and appropriate UTM projection."""
        bbox = self.location.get("boundingbox")
        center_lat, center_lon = 0.0, 0.0

        if bbox and len(bbox) == 4:
            try:
                (
                    min_lat,
                    max_lat,
                    min_lon,
                    max_lon,
                ) = map(float, bbox)
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
                        "Task %s: Invalid coordinate values in bounding box for %s. Using default UTM.",
                        self.task_id,
                        self.location_name,
                    )
            except (ValueError, TypeError):
                logger.warning(
                    "Task %s: Invalid bounding box format for %s. Using default UTM.",
                    self.task_id,
                    self.location_name,
                )
        else:
            logger.warning(
                "Task %s: Missing or invalid bounding box for %s. Using default UTM.",
                self.task_id,
                self.location_name,
            )

        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"
        epsg_code = 32600 + utm_zone if center_lat >= 0 else 32700 + utm_zone

        try:
            self.utm_proj = pyproj.CRS(f"EPSG:{epsg_code}")
            self.project_to_utm = pyproj.Transformer.from_crs(
                WGS84,
                self.utm_proj,
                always_xy=True,
            ).transform
            logger.info(
                "Task %s: Initialized UTM projection for %s: EPSG:%d (Zone %d%s)",
                self.task_id,
                self.location_name,
                epsg_code,
                utm_zone,
                hemisphere.upper()[0],
            )
        except pyproj.exceptions.CRSError as e:
            logger.error(
                "Task %s: Failed to initialize UTM projection EPSG:%d for %s: %s. Calculation may be inaccurate.",
                self.task_id,
                epsg_code,
                self.location_name,
                e,
            )
            raise ValueError(f"UTM Projection initialization failed: {e}") from e

    async def update_progress(
        self,
        stage: str,
        progress: float,
        message: str = "",
        error: str = "",
    ) -> None:
        """Updates the progress document in MongoDB."""
        try:
            current_covered_length = self.initial_driven_length
            newly_covered_driveable_length = 0.0
            newly_covered_driveable_count = 0

            for (
                rtree_id,
                info,
            ) in self.streets_lookup.items():
                if (
                    info["segment_id"] in self.newly_covered_segments
                    and info["segment_id"] not in self.initial_covered_segments
                    and not info.get("undriveable", False)
                ):
                    newly_covered_driveable_length += info["length_m"]
                    newly_covered_driveable_count += 1

            current_covered_length += newly_covered_driveable_length
            coverage_pct = (
                (current_covered_length / self.total_driveable_length * 100)
                if self.total_driveable_length > 0
                else 0.0
            )

            total_covered_segments_count = (
                len(self.initial_covered_segments) + newly_covered_driveable_count
            )

            enhanced_metrics = {
                "total_trips_to_process": self.total_trips_to_process,
                "processed_trips": self.processed_trips_count,
                "total_length_m": round(
                    self.total_length_calculated,
                    2,
                ),
                "driveable_length_m": round(self.total_driveable_length, 2),
                "covered_length_m": round(current_covered_length, 2),
                "coverage_percentage": round(coverage_pct, 2),
                "initial_covered_segments": len(self.initial_covered_segments),
                "newly_covered_segments": newly_covered_driveable_count,
                "total_covered_segments": total_covered_segments_count,
                "rtree_items": (
                    self.streets_index.count(self.streets_index.bounds)
                    if self.streets_index
                    else 0
                ),
            }

            update_data = {
                "stage": stage,
                "progress": round(progress, 2),
                "message": message,
                "updated_at": datetime.now(timezone.utc),
                "location": self.location_name,
                "metrics": enhanced_metrics,
            }
            if error:
                update_data["error"] = error
                update_data["status"] = "error"

            await update_one_with_retry(
                progress_collection,
                {"_id": self.task_id},
                {"$set": update_data},
                upsert=True,
            )
        except Exception as e:
            logger.error(
                "Task %s: Error updating progress: %s",
                self.task_id,
                e,
            )

    async def initialize_workers(self) -> None:
        """Initializes the ProcessPoolExecutor."""
        if self.process_pool is None and self.max_workers > 0:
            try:
                context = multiprocessing.get_context("spawn")
                self.process_pool = ProcessPoolExecutor(
                    max_workers=self.max_workers,
                    mp_context=context,
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
        """Shuts down the ProcessPoolExecutor."""
        if self.process_pool:
            pool = self.process_pool
            self.process_pool = None
            try:
                logger.info(
                    "Task %s: Shutting down process pool...",
                    self.task_id,
                )
                pool.shutdown(
                    wait=True,
                    cancel_futures=False,
                )
                logger.info(
                    "Task %s: Process pool shut down.",
                    self.task_id,
                )
            except Exception as e:
                logger.error(
                    "Task %s: Error shutting down process pool: %s",
                    self.task_id,
                    e,
                )

    async def build_spatial_index_and_stats(
        self,
    ) -> bool:
        """Loads streets, builds R-tree index, precomputes UTM geometries/bboxes, and calculates initial stats."""
        logger.info(
            "Task %s: Building spatial index and precomputing geometries for %s...",
            self.task_id,
            self.location_name,
        )
        await self.update_progress(
            "indexing",
            5,
            f"Starting street index build for {self.location_name}",
        )

        self.total_length_calculated = 0.0
        self.total_driveable_length = 0.0
        self.initial_driven_length = 0.0
        self.initial_covered_segments = set()
        self.streets_lookup = {}
        self.street_utm_geoms_cache = {}
        self.street_utm_bboxes_cache = {}
        self.street_wgs84_geoms_cache = {}

        if self.streets_index:
            try:
                self.streets_index.close()
            except Exception as e:
                logger.warning(
                    f"Task {self.task_id}: Error closing previous R-tree index: {e}"
                )
            self.streets_index = rtree.index.Index()

        if not self.project_to_utm:
            logger.error(
                f"Task {self.task_id}: UTM projection not initialized before indexing."
            )
            await self.update_progress(
                "error",
                0,
                "Projection Error during indexing setup",
            )
            return False

        streets_query = {"properties.location": self.location_name}
        try:
            total_streets_count = await count_documents_with_retry(
                streets_collection,
                streets_query,
            )
        except Exception as e:
            logger.error(
                "Task %s: Failed to count streets for %s: %s",
                self.task_id,
                self.location_name,
                e,
            )
            await self.update_progress(
                "error",
                0,
                f"Failed to count streets: {e}",
            )
            return False

        if total_streets_count == 0:
            logger.warning(
                "Task %s: No streets found for location %s.",
                self.task_id,
                self.location_name,
            )
            return True

        logger.info(
            "Task %s: Found %d streets to index.",
            self.task_id,
            total_streets_count,
        )

        streets_cursor = streets_collection.find(
            streets_query,
            {
                "geometry": 1,
                "properties.segment_id": 1,
                "properties.highway": 1,
                "properties.driven": 1,
                "properties.undriveable": 1,
                "_id": 0,
            },
        ).batch_size(self.street_index_batch_size)

        processed_count = 0
        rtree_idx_counter = 0
        last_progress_update_pct = 0

        try:
            async for street_batch in batch_cursor(
                streets_cursor,
                self.street_index_batch_size,
            ):
                if not self.project_to_utm:
                    raise ValueError(
                        "UTM projection became unavailable during indexing."
                    )

                for street in street_batch:
                    processed_count += 1
                    segment_id = None
                    try:
                        props = street.get("properties", {})
                        segment_id = props.get("segment_id")
                        geometry_data = street.get("geometry")
                        is_undriveable = props.get(
                            "undriveable",
                            False,
                        )

                        if not segment_id or not geometry_data:
                            continue

                        self.street_wgs84_geoms_cache[segment_id] = geometry_data

                        geom_wgs84 = shape(geometry_data)
                        geom_utm = transform(
                            self.project_to_utm,
                            geom_wgs84,
                        )
                        segment_length_m = geom_utm.length

                        if segment_length_m <= 0.1:
                            continue

                        self.street_utm_geoms_cache[segment_id] = geom_utm
                        utm_bounds = geom_utm.bounds
                        self.street_utm_bboxes_cache[segment_id] = utm_bounds

                        is_driven = props.get("driven", False)

                        self.streets_lookup[rtree_idx_counter] = {
                            "segment_id": segment_id,
                            "length_m": segment_length_m,
                            "highway": props.get(
                                "highway",
                                "unknown",
                            ),
                            "driven": is_driven,
                            "undriveable": is_undriveable,
                        }
                        self.streets_index.insert(
                            rtree_idx_counter,
                            geom_wgs84.bounds,
                        )
                        rtree_idx_counter += 1

                        self.total_length_calculated += segment_length_m
                        if not is_undriveable:
                            self.total_driveable_length += segment_length_m
                            if is_driven:
                                self.initial_driven_length += segment_length_m
                                self.initial_covered_segments.add(segment_id)

                    except (
                        GEOSException,
                        ValueError,
                        TypeError,
                    ) as e:
                        logger.warning(
                            f"Task {self.task_id}: Error processing street geom (Seg ID: {segment_id or 'N/A'}): {e}. Skipping segment."
                        )
                    except Exception as e:
                        logger.error(
                            f"Task {self.task_id}: Unexpected error indexing street (Seg ID: {segment_id or 'N/A'}): {e}",
                            exc_info=False,
                        )

                current_progress_pct = 5 + (processed_count / total_streets_count * 45)
                if (current_progress_pct - last_progress_update_pct >= 5) or (
                    processed_count == total_streets_count
                ):
                    length_km = self.total_length_calculated / 1000
                    driveable_km = self.total_driveable_length / 1000
                    driven_km = self.initial_driven_length / 1000
                    await self.update_progress(
                        "indexing",
                        current_progress_pct,
                        (
                            f"Indexed {processed_count:,}/{total_streets_count:,} streets | "
                            f"{rtree_idx_counter:,} valid segments | "
                            f"{driveable_km:.2f}km driveable | "
                            f"{driven_km:.2f}km initially driven"
                        ),
                    )
                    last_progress_update_pct = current_progress_pct
                    await asyncio.sleep(BATCH_PROCESS_DELAY)

            logger.info(
                f"Task {self.task_id}: Finished building index for {self.location_name}. "
                f"Total Length: {self.total_length_calculated:.2f}m. "
                f"Driveable Length: {self.total_driveable_length:.2f}m. "
                f"R-tree items: {rtree_idx_counter}. "
                f"Initial Driven (Driveable): {len(self.initial_covered_segments)} segments ({self.initial_driven_length:.2f}m)."
            )

            if total_streets_count > 0 and rtree_idx_counter == 0:
                logger.warning(
                    f"Task {self.task_id}: No valid segments added to index for {self.location_name} "
                    f"({total_streets_count} streets found in DB)."
                )

            return True

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Critical error during index build for {self.location_name}: {e}",
                exc_info=True,
            )
            await self.update_progress(
                "error",
                5,
                f"Error building spatial index: {e}",
            )
            return False
        finally:
            if "streets_cursor" in locals() and hasattr(streets_cursor, "close"):
                await streets_cursor.close()

    @staticmethod
    def _get_trip_bounding_box(
        coords: List[Any],
    ) -> Optional[Tuple[float, float, float, float]]:
        """Calculate the WGS84 bounding box for a list of coordinates."""
        if not coords or len(coords) < 1:
            return None
        try:
            lons = [
                c[0]
                for c in coords
                if isinstance(c, (list, tuple))
                and len(c) >= 2
                and isinstance(c[0], (int, float))
            ]
            lats = [
                c[1]
                for c in coords
                if isinstance(c, (list, tuple))
                and len(c) >= 2
                and isinstance(c[1], (int, float))
            ]
            if not lons or not lats:
                return None
            return (
                min(lons),
                min(lats),
                max(lons),
                max(lats),
            )
        except (
            TypeError,
            IndexError,
            ValueError,
        ):
            logger.debug(
                "Could not extract coordinates for trip bounding box calculation."
            )
            return None

    @staticmethod
    def _is_valid_trip(
        gps_data: Any,
    ) -> Tuple[bool, List[Any]]:
        """Validates GPS data structure and basic coordinate validity."""
        try:
            if isinstance(gps_data, (dict, list)):
                coords = (
                    gps_data.get("coordinates", [])
                    if isinstance(gps_data, dict)
                    else gps_data
                )
            elif isinstance(gps_data, str):
                try:
                    data = json.loads(gps_data)
                    coords = (
                        data.get("coordinates", []) if isinstance(data, dict) else data
                    )
                except json.JSONDecodeError:
                    return False, []
            else:
                return False, []

            if not isinstance(coords, list) or len(coords) < 2:
                return False, []

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
        """Processes trips to find newly covered street segments."""
        await self.update_progress(
            "processing_trips",
            50,
            f"Starting trip analysis for {self.location_name}",
        )

        base_trip_filter: Dict[str, Any] = {
            "gps": {
                "$exists": True,
                "$ne": None,
                "$not": {"$size": 0},
            }
        }

        location_bbox_wgs84: Optional[box] = None
        bbox = self.location.get("boundingbox")
        if bbox and len(bbox) == 4:
            try:
                (
                    min_lat,
                    max_lat,
                    min_lon,
                    max_lon,
                ) = map(float, bbox)
                if (
                    -90 <= min_lat <= 90
                    and -90 <= max_lat <= 90
                    and -180 <= min_lon <= 180
                    and -180 <= max_lon <= 180
                    and min_lat <= max_lat
                    and min_lon <= max_lon
                ):
                    location_bbox_wgs84 = box(
                        min_lon,
                        min_lat,
                        max_lon,
                        max_lat,
                    )
                    logger.info(
                        "Task %s: Location BBox (LonMin, LatMin, LonMax, LatMax): [%f, %f, %f, %f]",
                        self.task_id,
                        min_lon,
                        min_lat,
                        max_lon,
                        max_lat,
                    )
                    await self.update_progress(
                        "processing_trips",
                        51,
                        "Filtering trips by location boundary",
                    )
                else:
                    logger.warning(
                        "Task %s: Invalid coordinate values in location bounding box. Will process all trips.",
                        self.task_id,
                    )
                    await self.update_progress(
                        "processing_trips",
                        51,
                        "Invalid location BBox - processing all trips",
                    )
            except (ValueError, TypeError):
                logger.warning(
                    "Task %s: Invalid location bounding box format. Will process all trips.",
                    self.task_id,
                )
                await self.update_progress(
                    "processing_trips",
                    51,
                    "Invalid location BBox - processing all trips",
                )
        else:
            logger.warning(
                "Task %s: No location bounding box available. Will process all trips.",
                self.task_id,
            )
            await self.update_progress(
                "processing_trips",
                51,
                "No location BBox - processing all trips",
            )

        processed_object_ids = set()
        for tid in processed_trip_ids_set:
            if ObjectId.is_valid(tid):
                processed_object_ids.add(ObjectId(tid))

        if processed_object_ids:
            base_trip_filter["_id"] = {"$nin": list(processed_object_ids)}
            await self.update_progress(
                "processing_trips",
                52,
                f"Excluding {len(processed_object_ids):,} previously processed trips",
            )
        else:
            await self.update_progress(
                "processing_trips",
                52,
                "Processing all available trips",
            )

        await self.update_progress(
            "processing_trips",
            53,
            "Counting trips matching criteria",
        )
        try:
            self.total_trips_to_process = await count_documents_with_retry(
                trips_collection,
                base_trip_filter,
            )
            logger.info(
                "Task %s: Found %d potential trips matching initial filter.",
                self.task_id,
                self.total_trips_to_process,
            )
            await self.update_progress(
                "processing_trips",
                55,
                f"Found {self.total_trips_to_process:,} potential trips - preparing workers",
            )
        except OperationFailure as e:
            logger.error(
                "Task %s: MongoDB Error counting trips (Code: %s): %s. Filter: %s",
                self.task_id,
                e.code,
                e.details,
                str(base_trip_filter)[:500],
            )
            await self.update_progress(
                "error",
                50,
                f"Error counting trips: {e.details}",
            )
            return False
        except Exception as e:
            logger.error(
                "Task %s: Error counting trips: %s",
                self.task_id,
                e,
                exc_info=True,
            )
            await self.update_progress(
                "error",
                50,
                f"Error counting trips: {e}",
            )
            return False

        if self.total_trips_to_process == 0:
            logger.info(
                "Task %s: No new trips to process for %s.",
                self.task_id,
                self.location_name,
            )
            await self.update_progress(
                "processing_trips",
                90,
                "No new trips found to process",
            )
            return True

        await self.initialize_workers()
        await self.update_progress(
            "processing_trips",
            56,
            f"Initialized {self.max_workers} workers - loading trips",
        )

        trips_cursor = trips_collection.find(
            base_trip_filter,
            {"gps": 1, "_id": 1},
        ).batch_size(self.trip_batch_size)

        pending_futures_map: Dict[Future, List[Tuple[str, List[Any]]]] = {}
        processed_count_local = 0
        completed_futures_count = 0
        failed_futures_count = 0
        batch_num = 0
        last_progress_update_pct = 56
        last_progress_update_time = datetime.now(timezone.utc)
        self.processed_trips_count = 0

        try:
            async for trip_batch_docs in batch_cursor(
                trips_cursor, self.trip_batch_size
            ):
                batch_num += 1
                valid_trips_for_processing: List[Tuple[str, List[Any]]] = []

                logger.debug(
                    f"Task {self.task_id}: Processing main trip batch {batch_num} ({len(trip_batch_docs)} docs)..."
                )

                for trip_doc in trip_batch_docs:
                    trip_id = str(trip_doc["_id"])
                    if trip_id in processed_trip_ids_set:
                        continue

                    is_valid, coords = self._is_valid_trip(trip_doc.get("gps"))

                    if is_valid:
                        if location_bbox_wgs84:
                            trip_bbox_coords = self._get_trip_bounding_box(coords)
                            if trip_bbox_coords:
                                trip_bbox = box(*trip_bbox_coords)
                                if location_bbox_wgs84.intersects(trip_bbox):
                                    valid_trips_for_processing.append(
                                        (
                                            trip_id,
                                            coords,
                                        )
                                    )
                                else:
                                    processed_trip_ids_set.add(trip_id)
                            else:
                                logger.warning(
                                    f"Task {self.task_id}: Could not calculate bounding box for valid trip {trip_id}. Processing anyway."
                                )
                                valid_trips_for_processing.append(
                                    (
                                        trip_id,
                                        coords,
                                    )
                                )
                        else:
                            valid_trips_for_processing.append((trip_id, coords))
                    else:
                        processed_trip_ids_set.add(trip_id)

                processed_count_local += len(trip_batch_docs)

                if not valid_trips_for_processing:
                    logger.debug(
                        f"Task {self.task_id}: No trips passed validation/filtering in batch {batch_num} requiring worker processing."
                    )
                    continue

                all_batch_coords = []
                for (
                    _,
                    coords,
                ) in valid_trips_for_processing:
                    all_batch_coords.extend(coords)

                batch_candidate_segment_ids = set()
                if all_batch_coords:
                    try:
                        multi_point_wgs84 = MultiPoint(all_batch_coords)
                        buffer_deg = self.match_buffer / 111000
                        batch_query_bounds = multi_point_wgs84.convex_hull.buffer(
                            buffer_deg
                        ).bounds
                        candidate_indices = list(
                            self.streets_index.intersection(batch_query_bounds)
                        )

                        for idx in candidate_indices:
                            if idx in self.streets_lookup:
                                street_info = self.streets_lookup[idx]
                                if not street_info.get(
                                    "undriveable",
                                    False,
                                ):
                                    batch_candidate_segment_ids.add(
                                        street_info["segment_id"]
                                    )
                    except (
                        GEOSException,
                        ValueError,
                        TypeError,
                    ) as e:
                        logger.warning(
                            f"Task {self.task_id}: Error finding candidates for batch {batch_num}: {e}. Skipping worker processing for this batch."
                        )
                        continue
                    except Exception as e:
                        logger.error(
                            f"Task {self.task_id}: Unexpected error finding candidates for batch {batch_num}: {e}. Skipping worker processing."
                        )
                        continue

                if not batch_candidate_segment_ids:
                    logger.debug(
                        f"Task {self.task_id}: No driveable candidate segments found intersecting batch {batch_num}. Trips in batch will be marked processed."
                    )
                    processed_trip_ids_set.update(
                        [tid for tid, _ in valid_trips_for_processing]
                    )
                    continue

                batch_candidate_utm_geoms: Dict[str, Any] = {}
                batch_candidate_utm_bboxes: Dict[
                    str,
                    Tuple[float, float, float, float],
                ] = {}
                missing_geoms = []

                for seg_id in batch_candidate_segment_ids:
                    utm_geom = self.street_utm_geoms_cache.get(seg_id)
                    utm_bbox = self.street_utm_bboxes_cache.get(seg_id)
                    if utm_geom and utm_bbox:
                        batch_candidate_utm_geoms[seg_id] = utm_geom
                        batch_candidate_utm_bboxes[seg_id] = utm_bbox
                    else:
                        missing_geoms.append(seg_id)
                        logger.warning(
                            f"Task {self.task_id}: Missing cached UTM geometry or bbox for candidate segment {seg_id} in batch {batch_num}."
                        )

                if not batch_candidate_utm_geoms:
                    logger.warning(
                        f"Task {self.task_id}: No valid UTM geoms found for candidates in batch {batch_num}. Trips in batch will be marked processed."
                    )
                    processed_trip_ids_set.update(
                        [tid for tid, _ in valid_trips_for_processing]
                    )
                    continue

                logger.debug(
                    f"Task {self.task_id}: Submitting {len(valid_trips_for_processing)} trips "
                    f"against {len(batch_candidate_utm_geoms)} candidates for batch {batch_num}..."
                )

                if len(batch_candidate_utm_geoms) > MAX_STREETS_PER_WORKER_TASK:
                    chunk_size = MAX_STREETS_PER_WORKER_TASK
                    seg_ids = list(batch_candidate_utm_geoms.keys())
                    geom_chunks = []
                    bbox_chunks = []
                    for i in range(
                        0,
                        len(seg_ids),
                        chunk_size,
                    ):
                        chunk_seg_ids = seg_ids[i : i + chunk_size]
                        geom_chunks.append(
                            {
                                seg_id: batch_candidate_utm_geoms[seg_id]
                                for seg_id in chunk_seg_ids
                            }
                        )
                        bbox_chunks.append(
                            {
                                seg_id: batch_candidate_utm_bboxes[seg_id]
                                for seg_id in chunk_seg_ids
                            }
                        )
                    logger.info(
                        f"Task {self.task_id}: Split {len(batch_candidate_utm_geoms)} candidates "
                        f"into {len(geom_chunks)} chunks for batch {batch_num}."
                    )
                else:
                    geom_chunks = [batch_candidate_utm_geoms]
                    bbox_chunks = [batch_candidate_utm_bboxes]

                for i in range(
                    0,
                    len(valid_trips_for_processing),
                    self.trip_worker_sub_batch,
                ):
                    trip_sub_batch = valid_trips_for_processing[
                        i : i + self.trip_worker_sub_batch
                    ]
                    sub_batch_coords = [coords for _, coords in trip_sub_batch]
                    sub_batch_trip_ids = [tid for tid, _ in trip_sub_batch]

                    for chunk_idx, (
                        geom_chunk,
                        bbox_chunk,
                    ) in enumerate(
                        zip(
                            geom_chunks,
                            bbox_chunks,
                        )
                    ):
                        if not geom_chunk or not sub_batch_coords:
                            continue

                        self.submitted_trips_count += len(trip_sub_batch)

                        if self.process_pool and self.max_workers > 0:
                            try:
                                future = self.process_pool.submit(
                                    process_trip_worker,
                                    sub_batch_coords,
                                    geom_chunk,
                                    bbox_chunk,
                                    self.utm_proj.to_string(),
                                    WGS84.to_string(),
                                    self.match_buffer,
                                    self.min_match_length,
                                )
                                pending_futures_map[future] = trip_sub_batch
                            except Exception as submit_err:
                                logger.error(
                                    f"Task {self.task_id}: Error submitting sub-batch: {submit_err}"
                                )
                                failed_futures_count += 1
                        else:
                            try:
                                result_map = process_trip_worker(
                                    sub_batch_coords,
                                    geom_chunk,
                                    bbox_chunk,
                                    self.utm_proj.to_string(),
                                    WGS84.to_string(),
                                    self.match_buffer,
                                    self.min_match_length,
                                )
                                for (
                                    trip_idx_in_sub_batch,
                                    matched_segment_ids,
                                ) in result_map.items():
                                    if isinstance(
                                        matched_segment_ids,
                                        set,
                                    ):
                                        valid_new_segments = {
                                            seg_id
                                            for seg_id in matched_segment_ids
                                            if seg_id in self.street_utm_geoms_cache
                                        }
                                        self.newly_covered_segments.update(
                                            valid_new_segments
                                        )
                                processed_trip_ids_set.update(sub_batch_trip_ids)
                                completed_futures_count += 1
                                self.processed_trips_count += len(trip_sub_batch)

                            except Exception as seq_err:
                                logger.error(
                                    f"Task {self.task_id}: Error during sequential processing: {seq_err}"
                                )
                                failed_futures_count += 1

                if (
                    pending_futures_map
                    and len(pending_futures_map) > self.max_workers * 1.5
                ):
                    logger.debug(
                        f"Task {self.task_id}: Processing {len(pending_futures_map)} pending futures..."
                    )
                    done_futures = []
                    try:
                        for future in list(pending_futures_map.keys()):
                            if future.done():
                                done_futures.append(future)
                                original_trip_sub_batch = pending_futures_map.pop(
                                    future, []
                                )
                                sub_batch_trip_ids = [
                                    tid for tid, _ in original_trip_sub_batch
                                ]
                                try:
                                    result_map = future.result(timeout=0.1)
                                    for (
                                        trip_idx_in_sub_batch,
                                        matched_segment_ids,
                                    ) in result_map.items():
                                        if isinstance(
                                            matched_segment_ids,
                                            set,
                                        ):
                                            valid_new_segments = {
                                                seg_id
                                                for seg_id in matched_segment_ids
                                                if seg_id in self.street_utm_geoms_cache
                                            }
                                            self.newly_covered_segments.update(
                                                valid_new_segments
                                            )

                                    processed_trip_ids_set.update(sub_batch_trip_ids)
                                    completed_futures_count += 1
                                    self.processed_trips_count += len(
                                        original_trip_sub_batch
                                    )

                                except TimeoutError:
                                    logger.debug(
                                        f"Task {self.task_id}: Future result not ready, will check again later."
                                    )
                                    pending_futures_map[future] = (
                                        original_trip_sub_batch
                                    )
                                except (
                                    CancelledError,
                                    Exception,
                                ) as e:
                                    logger.error(
                                        f"Task {self.task_id}: Future failed: {type(e).__name__}. NOT marking trips as processed."
                                    )
                                    failed_futures_count += 1
                    except Exception as check_err:
                        logger.error(
                            f"Task {self.task_id}: Error checking completed futures: {check_err}"
                        )

                now = datetime.now(timezone.utc)
                should_update_progress = (
                    (batch_num % PROGRESS_UPDATE_INTERVAL_TRIPS == 0)
                    or (processed_count_local >= self.total_trips_to_process)
                    or ((now - last_progress_update_time).total_seconds() > 20)
                )

                if should_update_progress:
                    progress_pct = 50 + (
                        (self.processed_trips_count / self.total_trips_to_process * 40)
                        if self.total_trips_to_process > 0
                        else 40
                    )
                    progress_pct = min(progress_pct, 90.0)

                    new_segments_found_count = len(
                        self.newly_covered_segments - self.initial_covered_segments
                    )

                    message = (
                        f"Processed {self.processed_trips_count:,}/{self.total_trips_to_process:,} trips | "
                        f"Submitted: {self.submitted_trips_count:,} | "
                        f"Done OK: {completed_futures_count:,} | Failed: {failed_futures_count:,} | Pending: {len(pending_futures_map):,} | "
                        f"New Segments Found: {new_segments_found_count:,}"
                    )

                    await self.update_progress(
                        "processing_trips",
                        progress_pct,
                        message,
                    )
                    last_progress_update_pct = progress_pct
                    last_progress_update_time = now
                    await asyncio.sleep(BATCH_PROCESS_DELAY)

            if pending_futures_map:
                logger.info(
                    f"Task {self.task_id}: Waiting for {len(pending_futures_map)} remaining trip futures..."
                )
                remaining_futures = list(pending_futures_map.keys())
                wrapped_futures = [asyncio.wrap_future(f) for f in remaining_futures]

                try:
                    done, pending = await asyncio.wait(
                        wrapped_futures,
                        timeout=WORKER_RESULT_WAIT_TIMEOUT_S,
                        return_when=asyncio.ALL_COMPLETED,
                    )

                    for (
                        i,
                        wrapped_done_future,
                    ) in enumerate(done):
                        original_future = remaining_futures[i]
                        original_trip_sub_batch = pending_futures_map.pop(
                            original_future, []
                        )
                        sub_batch_trip_ids = [tid for tid, _ in original_trip_sub_batch]
                        try:
                            result_map = wrapped_done_future.result()
                            for (
                                trip_idx,
                                matched_ids,
                            ) in result_map.items():
                                if isinstance(
                                    matched_ids,
                                    set,
                                ):
                                    valid_new_segments = {
                                        seg_id
                                        for seg_id in matched_ids
                                        if seg_id in self.street_utm_geoms_cache
                                    }
                                    self.newly_covered_segments.update(
                                        valid_new_segments
                                    )
                            processed_trip_ids_set.update(sub_batch_trip_ids)
                            completed_futures_count += 1
                            self.processed_trips_count += len(original_trip_sub_batch)

                        except (
                            CancelledError,
                            Exception,
                        ) as e:
                            logger.error(
                                f"Task {self.task_id}: Final future processing error: {type(e).__name__}. NOT marking trips."
                            )
                            failed_futures_count += 1

                    for (
                        i,
                        wrapped_pending_future,
                    ) in enumerate(pending):
                        original_future = remaining_futures[i]
                        original_trip_sub_batch = pending_futures_map.pop(
                            original_future, []
                        )
                        sub_batch_trip_ids = [tid for tid, _ in original_trip_sub_batch]

                        logger.error(
                            f"Task {self.task_id}: Timeout waiting for final future result. NOT marking trips."
                        )
                        failed_futures_count += 1
                        try:
                            wrapped_pending_future.cancel()
                            original_future.cancel()
                        except Exception as cancel_err:
                            logger.warning(
                                f"Task {self.task_id}: Error cancelling timed-out future: {cancel_err}"
                            )

                except Exception as wait_err:
                    logger.error(
                        f"Task {self.task_id}: Error during final asyncio.wait: {wait_err}"
                    )
                    for (
                        future,
                        batch_data,
                    ) in list(pending_futures_map.items()):
                        failed_futures_count += 1
                        try:
                            future.cancel()
                        except Exception:
                            pass
                    pending_futures_map.clear()

            for future, batch_data in list(pending_futures_map.items()):
                logger.warning(
                    f"Task {self.task_id}: Future unexpectedly still pending after final wait. Marking as failed. NOT marking trips."
                )
                failed_futures_count += 1
                try:
                    future.cancel()
                except Exception:
                    pass
            pending_futures_map.clear()

            final_new_segments = len(
                self.newly_covered_segments - self.initial_covered_segments
            )
            logger.info(
                f"Task {self.task_id}: Finished trip processing stage for {self.location_name}. "
                f"DB Trips Checked: {processed_count_local}/{self.total_trips_to_process}. "
                f"Successfully Processed by Workers/Seq: {self.processed_trips_count}. "
                f"Submitted to Workers: {self.submitted_trips_count}. "
                f"Failed/Timeout: {failed_futures_count}. "
                f"Newly covered segments found (incl. non-driveable): {final_new_segments}."
            )
            await self.update_progress(
                "processing_trips",
                90,
                f"Trip processing complete. Found {final_new_segments} new segments.",
            )
            return True

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Critical error during trip processing loop for {self.location_name}: {e}",
                exc_info=True,
            )
            await self.update_progress(
                "error",
                50,
                f"Error processing trips: {e}",
            )
            return False
        finally:
            if "trips_cursor" in locals() and hasattr(trips_cursor, "close"):
                await trips_cursor.close()
            await self.shutdown_workers()

    async def finalize_coverage(
        self, processed_trip_ids_set: Set[str]
    ) -> Optional[Dict[str, Any]]:
        """Updates street 'driven' status in DB, calculates final stats, and updates metadata."""

        segments_to_update_in_db = set()
        newly_driven_count = 0
        for seg_id in self.newly_covered_segments:
            if seg_id not in self.initial_covered_segments:
                street_info = None
                for (
                    rtree_id,
                    info,
                ) in self.streets_lookup.items():
                    if info["segment_id"] == seg_id:
                        street_info = info
                        break
                if street_info and not street_info.get("undriveable", False):
                    segments_to_update_in_db.add(seg_id)
                    newly_driven_count += 1
                elif not street_info:
                    logger.warning(
                        f"Task {self.task_id}: Segment {seg_id} found by trip but not in streets_lookup during finalize."
                    )

        await self.update_progress(
            "finalizing",
            90,
            f"Updating {newly_driven_count:,} newly driven, driveable segments in database.",
        )

        if segments_to_update_in_db:
            logger.info(
                f"Task {self.task_id}: Updating 'driven' status for {len(segments_to_update_in_db)} segments...",
            )
            segment_list = list(segments_to_update_in_db)
            update_timestamp = datetime.now(timezone.utc)
            try:
                max_update_batch = 10000
                for i in range(
                    0,
                    len(segment_list),
                    max_update_batch,
                ):
                    segment_batch = segment_list[i : i + max_update_batch]
                    current_batch_num = i // max_update_batch + 1
                    total_batches = (
                        len(segment_list) + max_update_batch - 1
                    ) // max_update_batch

                    await self.update_progress(
                        "finalizing",
                        90 + (i / len(segment_list) * 5),
                        f"Updating DB batch {current_batch_num}/{total_batches} ({len(segment_batch):,} segments)",
                    )

                    update_result = await update_many_with_retry(
                        streets_collection,
                        {"properties.segment_id": {"$in": segment_batch}},
                        {
                            "$set": {
                                "properties.driven": True,
                                "properties.last_coverage_update": update_timestamp,
                            }
                        },
                    )
                    logger.info(
                        f"Task {self.task_id}: DB Update Batch {current_batch_num}: "
                        f"Matched={update_result.matched_count}, Modified={update_result.modified_count}"
                    )
                    if update_result.modified_count != len(segment_batch):
                        logger.warning(
                            f"Task {self.task_id}: DB Update Batch {current_batch_num} modified count ({update_result.modified_count}) doesn't match expected ({len(segment_batch)})."
                        )

                    await asyncio.sleep(BATCH_PROCESS_DELAY)

            except BulkWriteError as bwe:
                logger.error(
                    f"Task {self.task_id}: Bulk write error updating street status: {bwe.details}"
                )
            except Exception as e:
                logger.error(
                    f"Task {self.task_id}: Error bulk updating street status: {e}",
                    exc_info=True,
                )
                await self.update_progress(
                    "error",
                    90,
                    f"Error updating DB: {e}",
                )
        else:
            logger.info(
                f"Task {self.task_id}: No new driveable segments to mark as driven for {self.location_name}."
            )
            await self.update_progress(
                "finalizing",
                95,
                "No new segments to update in DB.",
            )

        await self.update_progress(
            "finalizing",
            95,
            f"Calculating final coverage statistics for {self.location_name}",
        )
        try:
            final_total_length = 0.0
            final_driven_length = 0.0
            final_driveable_length = 0.0
            final_covered_segments_count = 0
            final_total_segments = len(self.streets_lookup)

            street_type_stats = defaultdict(
                lambda: {
                    "total": 0,
                    "covered": 0,
                    "length_m": 0.0,
                    "covered_length_m": 0.0,
                    "undriveable_length_m": 0.0,
                }
            )

            final_driven_segment_ids = self.initial_covered_segments.union(
                segments_to_update_in_db
            )

            for (
                rtree_id,
                street_info,
            ) in self.streets_lookup.items():
                segment_id = street_info["segment_id"]
                length = street_info["length_m"]
                highway = street_info["highway"]
                is_undriveable = street_info.get("undriveable", False)
                is_driven = segment_id in final_driven_segment_ids

                final_total_length += length
                street_type_stats[highway]["total"] += 1
                street_type_stats[highway]["length_m"] += length

                if is_undriveable:
                    street_type_stats[highway]["undriveable_length_m"] += length
                else:
                    final_driveable_length += length
                    if is_driven:
                        final_driven_length += length
                        street_type_stats[highway]["covered"] += 1
                        street_type_stats[highway]["covered_length_m"] += length
                        final_covered_segments_count += 1

            final_coverage_percentage = (
                (final_driven_length / final_driveable_length * 100)
                if final_driveable_length > 0
                else 0.0
            )

            final_street_types = []
            for (
                highway_type,
                stats,
            ) in street_type_stats.items():
                type_driveable_length = (
                    stats["length_m"] - stats["undriveable_length_m"]
                )
                coverage_pct = (
                    (stats["covered_length_m"] / type_driveable_length * 100)
                    if type_driveable_length > 0
                    else 0.0
                )
                final_street_types.append(
                    {
                        "type": highway_type,
                        "total_segments": stats["total"],
                        "covered_segments": stats["covered"],
                        "total_length_m": round(stats["length_m"], 2),
                        "covered_length_m": round(
                            stats["covered_length_m"],
                            2,
                        ),
                        "driveable_length_m": round(
                            type_driveable_length,
                            2,
                        ),
                        "undriveable_length_m": round(
                            stats["undriveable_length_m"],
                            2,
                        ),
                        "coverage_percentage": round(coverage_pct, 2),
                    }
                )
            final_street_types.sort(
                key=lambda x: x["total_length_m"],
                reverse=True,
            )

            coverage_stats = {
                "total_length_m": round(final_total_length, 2),
                "driven_length_m": round(final_driven_length, 2),
                "driveable_length_m": round(final_driveable_length, 2),
                "coverage_percentage": round(final_coverage_percentage, 2),
                "total_segments": final_total_segments,
                "covered_segments": final_covered_segments_count,
                "street_types": final_street_types,
            }
            logger.info(
                f"Task {self.task_id}: Final stats: {final_coverage_percentage:.2f}% coverage "
                f"({final_driven_length:.2f}m / {final_driveable_length:.2f}m driveable). "
                f"{final_covered_segments_count}/{final_total_segments} segments covered (driveable/total)."
            )

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error calculating final stats: {e}",
                exc_info=True,
            )
            await self.update_progress(
                "error",
                95,
                f"Error calculating stats: {e}",
            )
            return None

        logger.info(
            f"Task {self.task_id}: Updating coverage metadata for {self.location_name}..."
        )
        try:
            trip_ids_list = list(processed_trip_ids_set)
            processed_trips_info = {
                "last_processed_timestamp": datetime.now(timezone.utc),
                "count_in_last_run": len(trip_ids_list),
            }

            update_doc = {
                "$set": {
                    **coverage_stats,
                    "last_updated": datetime.now(timezone.utc),
                    "status": "completed_stats",
                    "last_error": None,
                    "processed_trips": processed_trips_info,
                    "needs_stats_update": False,
                    "last_stats_update": datetime.now(timezone.utc),
                },
            }

            MAX_TRIP_IDS_TO_STORE = 50000
            if len(trip_ids_list) <= MAX_TRIP_IDS_TO_STORE:
                pass
            else:
                logger.warning(
                    f"Task {self.task_id}: Not storing {len(trip_ids_list)} trip IDs in metadata due to size limit."
                )

            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": self.location_name},
                update_doc,
                upsert=True,
            )
            logger.info(
                f"Task {self.task_id}: Coverage metadata updated successfully for {self.location_name}."
            )

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error updating coverage metadata: {e}",
                exc_info=True,
            )
            await self.update_progress(
                "error",
                97,
                f"Failed to update metadata: {e}",
            )

        final_result = {
            **coverage_stats,
            "run_details": {
                "newly_covered_segment_count": newly_driven_count,
                "total_processed_trips_in_run": self.processed_trips_count,
                "submitted_trips_to_workers": self.submitted_trips_count,
            },
        }

        await self.update_progress(
            "complete_stats",
            98,
            "Coverage statistics calculation complete.",
        )
        logger.info(
            "Task %s: Finalization complete for %s.",
            self.task_id,
            self.location_name,
        )
        return final_result

    async def compute_coverage(
        self,
        run_incremental: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Main orchestration method for the coverage calculation process."""
        start_time = datetime.now(timezone.utc)
        run_type = "incremental" if run_incremental else "full"
        logger.info(
            "Task %s: Starting %s coverage computation for %s",
            self.task_id,
            run_type,
            self.location_name,
        )
        calculation_error = None

        try:
            await self.update_progress(
                "initializing",
                0,
                f"Initializing {run_type} calculation...",
            )

            try:
                self.initialize_projections()
            except ValueError as proj_err:
                logger.error(
                    "Task %s: Projection initialization failed: %s",
                    self.task_id,
                    proj_err,
                )
                await self.update_progress(
                    "error",
                    0,
                    f"Projection Error: {proj_err}",
                )
                return None

            index_success = await self.build_spatial_index_and_stats()
            if not index_success:
                logger.error(
                    "Task %s: Failed during spatial index build for %s.",
                    self.task_id,
                    self.location_name,
                )
                return None
            elif self.total_driveable_length == 0 and self.total_length_calculated > 0:
                logger.warning(
                    f"Task {self.task_id}: No driveable streets found for {self.location_name}. Reporting 0% coverage."
                )
            elif self.total_length_calculated == 0:
                logger.info(
                    f"Task {self.task_id}: No streets found or indexed for {self.location_name}. Finalizing with empty stats."
                )
                processed_trip_ids_set: Set[str] = set()
                final_stats = await self.finalize_coverage(processed_trip_ids_set)
                asyncio.create_task(
                    generate_and_store_geojson(
                        self.location_name,
                        self.task_id,
                    )
                )
                return final_stats

            processed_trip_ids_set = set()
            if run_incremental:
                logger.info(
                    f"Task {self.task_id}: Incremental run requested. Loading previous state."
                )
                try:
                    metadata = await find_one_with_retry(
                        coverage_metadata_collection,
                        {"location.display_name": self.location_name},
                        {"processed_trips.trip_ids": 1},
                    )
                    if (
                        metadata
                        and "processed_trips" in metadata
                        and "trip_ids" in metadata["processed_trips"]
                    ):
                        trip_ids_data = metadata["processed_trips"]["trip_ids"]
                        if isinstance(
                            trip_ids_data,
                            (list, set),
                        ):
                            processed_trip_ids_set = set(
                                map(
                                    str,
                                    trip_ids_data,
                                )
                            )
                            logger.info(
                                "Task %s: Loaded %d previously processed trip IDs for incremental run.",
                                self.task_id,
                                len(processed_trip_ids_set),
                            )
                        else:
                            logger.warning(
                                "Task %s: 'trip_ids' field has unexpected type. Running as full.",
                                self.task_id,
                            )
                    else:
                        logger.warning(
                            "Task %s: No previously processed trip IDs found in metadata. Running as full.",
                            self.task_id,
                        )
                        run_incremental = False
                except Exception as meta_err:
                    logger.error(
                        "Task %s: Error loading processed trips metadata: %s. Running as full.",
                        self.task_id,
                        meta_err,
                    )
                    run_incremental = False
            else:
                logger.info(
                    "Task %s: Starting full coverage run for %s.",
                    self.task_id,
                    self.location_name,
                )

            trips_success = await self.process_trips(processed_trip_ids_set)
            if not trips_success:
                calculation_error = "Trip processing stage failed"
                logger.error(
                    "Task %s: Failed during trip processing stage for %s.",
                    self.task_id,
                    self.location_name,
                )

            final_stats = await self.finalize_coverage(processed_trip_ids_set)

            if final_stats is None:
                logger.error(
                    f"Task {self.task_id}: Finalization failed for {self.location_name}."
                )
                await self.update_progress(
                    "error",
                    99,
                    "Finalization failed",
                )
                await coverage_metadata_collection.update_one(
                    {"location.display_name": self.location_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": "Finalization failed",
                        }
                    },
                    upsert=False,
                )
                return None

            if calculation_error:
                final_stats["status"] = "error"
                final_stats["last_error"] = calculation_error
                logger.warning(
                    f"Task {self.task_id}: Calculation completed with error: {calculation_error}"
                )
                await self.update_progress(
                    "error",
                    100,
                    f"Completed with error: {calculation_error}",
                )
                await coverage_metadata_collection.update_one(
                    {"location.display_name": self.location_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": calculation_error,
                        }
                    },
                    upsert=False,
                )

            if not calculation_error and final_stats is not None:
                logger.info(
                    f"Task {self.task_id}: Triggering background GeoJSON generation."
                )
                asyncio.create_task(
                    generate_and_store_geojson(
                        self.location_name,
                        self.task_id,
                    )
                )
            elif calculation_error:
                logger.warning(
                    f"Task {self.task_id}: Skipping GeoJSON generation due to prior error: {calculation_error}."
                )
            else:
                logger.error(
                    f"Task {self.task_id}: Skipping GeoJSON generation due to finalization failure."
                )

            end_time = datetime.now(timezone.utc)
            duration = (end_time - start_time).total_seconds()
            logger.info(
                "Task %s: Coverage computation (%s) for %s main logic finished in %.2f seconds.",
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
            await self.update_progress(
                "error",
                0,
                f"Unhandled error: {e}",
            )
            try:
                await coverage_metadata_collection.update_one(
                    {"location.display_name": self.location_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": f"Unhandled: {str(e)[:200]}",
                        }
                    },
                    upsert=True,
                )
            except Exception as db_err:
                logger.error(
                    f"Task {self.task_id}: Failed to update error status after unhandled exception: {db_err}"
                )
            return None
        finally:
            await self.shutdown_workers()
            self.streets_lookup = {}
            self.street_utm_geoms_cache = {}
            self.street_utm_bboxes_cache = {}
            self.street_wgs84_geoms_cache = {}
            if self.streets_index:
                try:
                    self.streets_index.close()
                except Exception as rtree_close_err:
                    logger.warning(
                        f"Task {self.task_id}: Error closing R-tree index: {rtree_close_err}"
                    )
                self.streets_index = None
            logger.debug(
                "Task %s: Cleanup completed for %s.",
                self.task_id,
                self.location_name,
            )


async def compute_coverage_for_location(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """Entry point for a full coverage calculation."""
    location_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Task %s: Received request for FULL coverage calculation for %s",
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

        if result is None:
            logger.error(
                f"Task {task_id}: Full coverage calculation returned None for {location_name}"
            )
        elif result.get("status") == "error":
            logger.error(
                f"Task {task_id}: Full coverage calculation completed with error for {location_name}: {result.get('last_error')}"
            )
        else:
            logger.info(
                f"Task {task_id}: Full coverage calculation stats phase complete for {location_name}. GeoJSON generation may be ongoing."
            )

        return result

    except asyncio.TimeoutError:
        error_msg = f"Full calculation timed out after {PROCESS_TIMEOUT_OVERALL}s"
        logger.error(
            "Task %s: %s for %s.",
            task_id,
            error_msg,
            location_name,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": "Timeout",
                    "updated_at": datetime.now(timezone.utc),
                    "status": "error",
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
        error_msg = f"Unexpected error in wrapper: {e}"
        logger.exception(
            "Task %s: Error in compute_coverage_for_location wrapper for %s",
            task_id,
            location_name,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": str(e)[:200],
                    "status": "error",
                }
            },
            upsert=True,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"Wrapper error: {str(e)[:200]}",
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        return None
    finally:
        if calculator:
            pass


async def compute_incremental_coverage(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """Entry point for an incremental coverage calculation."""
    location_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Task %s: Received request for INCREMENTAL coverage update for %s",
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
                "Task %s: No existing metadata found for %s. Cannot run incrementally. Switching to FULL run.",
                task_id,
                location_name,
            )
            return await compute_coverage_for_location(location, task_id)

        calculator = CoverageCalculator(location, task_id)
        result = await asyncio.wait_for(
            calculator.compute_coverage(run_incremental=True),
            timeout=PROCESS_TIMEOUT_INCREMENTAL,
        )

        if result is None:
            logger.error(
                f"Task {task_id}: Incremental coverage calculation returned None for {location_name}"
            )
        elif result.get("status") == "error":
            logger.error(
                f"Task {task_id}: Incremental coverage calculation completed with error for {location_name}: {result.get('last_error')}"
            )
        else:
            logger.info(
                f"Task {task_id}: Incremental coverage stats phase complete for {location_name}. GeoJSON generation may be ongoing."
            )

        return result

    except asyncio.TimeoutError:
        error_msg = (
            f"Incremental calculation timed out after {PROCESS_TIMEOUT_INCREMENTAL}s"
        )
        logger.error(
            "Task %s: %s for %s.",
            task_id,
            error_msg,
            location_name,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": "Timeout",
                    "updated_at": datetime.now(timezone.utc),
                    "status": "error",
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
            upsert=False,
        )
        return None
    except Exception as e:
        error_msg = f"Unexpected error in incremental wrapper: {e}"
        logger.exception(
            "Task %s: Error in compute_incremental_coverage wrapper for %s",
            task_id,
            location_name,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg,
                    "error": str(e)[:200],
                    "status": "error",
                }
            },
            upsert=True,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"Incr Wrapper error: {str(e)[:200]}",
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=False,
        )
        return None
    finally:
        if calculator:
            pass


async def generate_and_store_geojson(
    location_name: Optional[str], task_id: str
) -> None:
    """Generates a GeoJSON FeatureCollection of streets and stores it in GridFS."""
    if not location_name:
        logger.error(
            "Task %s: Cannot generate GeoJSON, location name is missing.",
            task_id,
        )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": "GeoJSON generation failed: Missing location name",
                    "error": "Missing Location",
                    "status": "error",
                }
            },
            upsert=True,
        )
        return

    logger.info(
        "Task %s: Starting GeoJSON generation and storage for %s...",
        task_id,
        location_name,
    )
    await progress_collection.update_one(
        {"_id": task_id},
        {
            "$set": {
                "stage": "generating_geojson",
                "progress": 98,
                "message": "Creating map data...",
                "status": "processing",
            }
        },
        upsert=True,
    )

    fs: AsyncIOMotorGridFSBucket = db_manager.gridfs_bucket
    safe_location_name = "".join(
        (c if c.isalnum() or c in ["_", "-"] else "_") for c in location_name
    )
    gridfs_filename = f"{safe_location_name}_streets.geojson"

    total_features = 0
    file_id = None
    upload_stream = None
    geojson_generation_successful = False

    try:
        existing_meta = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {"streets_geojson_gridfs_id": 1},
        )
        if existing_meta and existing_meta.get("streets_geojson_gridfs_id"):
            old_gridfs_id = existing_meta["streets_geojson_gridfs_id"]
            try:
                logger.info(
                    f"Task {task_id}: Attempting to delete old GridFS file {old_gridfs_id} for {location_name}."
                )
                await fs.delete(old_gridfs_id)
                logger.info(f"Task {task_id}: Deleted old GridFS file {old_gridfs_id}.")
            except Exception as del_err:
                logger.warning(
                    f"Task {task_id}: Failed to delete old GridFS file {old_gridfs_id} (might not exist): {del_err}"
                )

        upload_stream = fs.open_upload_stream(
            gridfs_filename,
            metadata={
                "contentType": "application/json",
                "location": location_name,
                "task_id": task_id,
                "generated_at": datetime.now(timezone.utc),
            },
        )

        await upload_stream.write(b'{"type": "FeatureCollection", "features": [\n')

        streets_cursor = streets_collection.find(
            {"properties.location": location_name},
            {
                "_id": 0,
                "geometry": 1,
                "properties.segment_id": 1,
                "properties.driven": 1,
                "properties.highway": 1,
                "properties.undriveable": 1,
                "properties.name": 1,
                "properties.maxspeed": 1,
            },
        ).batch_size(1000)

        first_feature = True
        async for street_batch in batch_cursor(streets_cursor, 1000):
            features_to_write = []
            for street in street_batch:
                if "geometry" not in street or not street.get("properties", {}).get(
                    "segment_id"
                ):
                    continue

                props = street["properties"]

                props["driven"] = props.get("driven", False)
                props["undriveable"] = props.get("undriveable", False)
                props["highway"] = props.get("highway", "unknown")

                feature = {
                    "type": "Feature",
                    "geometry": street["geometry"],
                    "properties": props,
                }
                feature_json = bson.json_util.dumps(feature)

                prefix = b"" if first_feature else b",\n"
                features_to_write.append(prefix + feature_json.encode("utf-8"))
                first_feature = False
                total_features += 1

            if features_to_write:
                await upload_stream.write(b"".join(features_to_write))
            await asyncio.sleep(0.01)

        metadata_stats = (
            await find_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "_id": 0,
                    "total_length_m": 1,
                    "driven_length_m": 1,
                    "driveable_length_m": 1,
                    "coverage_percentage": 1,
                    "total_segments": 1,
                    "covered_segments": 1,
                    "street_types": 1,
                    "last_updated": 1,
                },
            )
            or {}
        )

        geojson_metadata = {
            **metadata_stats,
            "total_features_in_file": total_features,
            "geojson_generated_at": datetime.now(timezone.utc).isoformat(),
            "source_task_id": task_id,
        }
        metadata_json = bson.json_util.dumps(geojson_metadata)

        await upload_stream.write(
            f'\n], "metadata": {metadata_json}\n}}'.encode("utf-8")
        )

        await upload_stream.close()
        file_id = upload_stream._id

        if file_id:
            geojson_generation_successful = True
            logger.info(
                f"Task {task_id}: Finished streaming {total_features} features to GridFS for {location_name} (File ID: {file_id})."
            )

            logger.info(
                f"Task {task_id}: Updating metadata for '{location_name}' with GridFS ID: {file_id}"
            )
            update_result = await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {
                    "$set": {
                        "streets_geojson_gridfs_id": file_id,
                        "status": "completed",
                        "last_geojson_update": datetime.now(timezone.utc),
                        "last_error": None,
                    },
                },
            )

            if update_result.matched_count > 0 and update_result.modified_count > 0:
                logger.info(
                    f"Task {task_id}: Successfully updated metadata for '{location_name}' with GridFS ID {file_id}."
                )
                await progress_collection.update_one(
                    {"_id": task_id},
                    {
                        "$set": {
                            "stage": "complete",
                            "progress": 100,
                            "message": f"Coverage analysis complete. Map data generated ({total_features:,} streets).",
                            "status": "complete",
                            "updated_at": datetime.now(timezone.utc),
                        }
                    },
                    upsert=True,
                )
            else:
                error_msg = (
                    "GeoJSON stored in GridFS, but failed to update metadata link."
                )
                logger.error(
                    f"Task {task_id}: {error_msg} (Matched: {update_result.matched_count}, Modified: {update_result.modified_count})"
                )
                await progress_collection.update_one(
                    {"_id": task_id},
                    {
                        "$set": {
                            "stage": "error",
                            "message": error_msg,
                            "error": "Metadata Link Failure",
                            "status": "error",
                        }
                    },
                    upsert=True,
                )
                try:
                    await fs.delete(file_id)
                except Exception:
                    logger.warning(
                        f"Task {task_id}: Failed to delete orphaned GridFS file {file_id} after metadata link failure."
                    )
        else:
            error_msg = "GridFS stream closed successfully but file_id is missing."
            logger.error(f"Task {task_id}: {error_msg} for {location_name}")
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "message": error_msg,
                        "error": "GridFS ID Missing",
                        "status": "error",
                    }
                },
                upsert=True,
            )

    except Exception as e:
        error_msg = f"Error during GeoJSON generation/storage: {e}"
        logger.error(
            f"Task {task_id}: {error_msg}",
            exc_info=True,
        )
        if upload_stream and not upload_stream.closed:
            try:
                await upload_stream.abort()
                logger.info(
                    f"Task {task_id}: Aborted GridFS upload stream for {location_name} due to error."
                )
            except Exception as abort_err:
                logger.error(
                    f"Task {task_id}: Error aborting GridFS stream: {abort_err}"
                )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg[:500],
                    "error": str(e)[:200],
                    "status": "error",
                }
            },
            upsert=True,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"GeoJSON Generation Failed: {str(e)[:200]}",
                }
            },
            upsert=False,
        )

    finally:
        if "streets_cursor" in locals() and hasattr(streets_cursor, "close"):
            try:
                await streets_cursor.close()
            except Exception as cur_close_err:
                logger.warning(
                    f"Task {task_id}: Error closing streets cursor for GeoJSON: {cur_close_err}"
                )
