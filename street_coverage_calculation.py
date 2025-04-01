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
    CancelledError,
    Future,
    ProcessPoolExecutor,
    TimeoutError,
)
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import bson.json_util
import numpy as np
import pyproj
import rtree
from bson import ObjectId
from dotenv import load_dotenv
from motor.motor_asyncio import (
    AsyncIOMotorGridFSBucket,
)  # Import GridFS bucket class
from pymongo.errors import (
    BulkWriteError,
    OperationFailure,  # Import OperationFailure
)
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPoint, shape
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
BATCH_PROCESS_DELAY = 0.02
PROCESS_TIMEOUT_WORKER = 30000
PROCESS_TIMEOUT_OVERALL = 7200  # Increased from 3600 (2 hours)
PROCESS_TIMEOUT_INCREMENTAL = 3600
PROGRESS_UPDATE_INTERVAL_TRIPS = 10


MAX_WORKERS_DEFAULT = max(1, multiprocessing.cpu_count())


MAX_STREETS_PER_WORKER = 50000
GEOMETRY_SIMPLIFICATION_TOLERANCE = 0.00001
ENABLE_PRECOMPUTE_BBOXES = True
ENABLE_GEOMETRY_SIMPLIFICATION = False
ENABLE_NUMPY_SPEEDUPS = True


def process_trip_worker(
    trip_coords_list: List[List[Any]],
    candidate_geoms_dict: Dict[str, Dict],
    utm_proj_string: str,
    wgs84_proj_string: str,
    match_buffer: float,
    min_match_length: float,
    precomputed_bboxes: Optional[
        Dict[str, Tuple[float, float, float, float]]
    ] = None,
) -> Dict[int, Set[str]]:
    results: Dict[int, Set[str]] = defaultdict(set)
    if not trip_coords_list or not candidate_geoms_dict:
        return {}

    try:
        try:
            utm_proj = pyproj.CRS.from_string(utm_proj_string)
            wgs84_proj = pyproj.CRS.from_string(wgs84_proj_string)
            project_to_utm = pyproj.Transformer.from_crs(
                wgs84_proj, utm_proj, always_xy=True
            ).transform
        except pyproj.exceptions.CRSError:
            return {}

        street_utm_geoms: Dict[str, Any] = {}
        street_utm_bboxes: Dict[str, Tuple[float, float, float, float]] = {}

        has_precomputed = (
            precomputed_bboxes is not None and ENABLE_PRECOMPUTE_BBOXES
        )

        candidate_segment_ids = list(candidate_geoms_dict.keys())

        for seg_id in candidate_segment_ids:
            try:
                geom_dict = candidate_geoms_dict.get(seg_id)
                if not geom_dict:
                    continue

                geom_wgs84 = shape(geom_dict)

                if (
                    ENABLE_GEOMETRY_SIMPLIFICATION
                    and geom_wgs84.geom_type == "LineString"
                ):
                    geom_wgs84 = geom_wgs84.simplify(
                        GEOMETRY_SIMPLIFICATION_TOLERANCE,
                        preserve_topology=True,
                    )

                geom_utm = transform(project_to_utm, geom_wgs84)
                street_utm_geoms[seg_id] = geom_utm

                if has_precomputed:
                    street_utm_bboxes[seg_id] = precomputed_bboxes[seg_id]
                else:
                    street_utm_bboxes[seg_id] = geom_utm.envelope.bounds

            except (GEOSException, ValueError, TypeError, KeyError):
                continue

        for trip_index, trip_coords in enumerate(trip_coords_list):
            if len(trip_coords) < 2:
                continue

            try:
                trip_line_wgs84 = LineString(trip_coords)
                trip_line_utm = transform(project_to_utm, trip_line_wgs84)
                trip_buffer_utm = trip_line_utm.buffer(match_buffer)
                trip_buffer_bounds = trip_buffer_utm.bounds

                if ENABLE_NUMPY_SPEEDUPS:
                    trip_bbox = np.array(trip_buffer_bounds)

                for seg_id, street_utm_geom in street_utm_geoms.items():
                    if not street_utm_geom:
                        continue

                    if ENABLE_NUMPY_SPEEDUPS:
                        street_bbox = np.array(street_utm_bboxes[seg_id])
                        if (
                            trip_bbox[0] > street_bbox[2]
                            or trip_bbox[2] < street_bbox[0]
                            or trip_bbox[1] > street_bbox[3]
                            or trip_bbox[3] < street_bbox[1]
                        ):
                            continue
                    else:
                        street_bbox = street_utm_bboxes[seg_id]
                        if not (
                            trip_buffer_bounds[0] <= street_bbox[2]
                            and trip_buffer_bounds[2] >= street_bbox[0]
                            and trip_buffer_bounds[1] <= street_bbox[3]
                            and trip_buffer_bounds[3] >= street_bbox[1]
                        ):
                            continue

                    intersection = trip_buffer_utm.intersection(
                        street_utm_geom
                    )

                    if (
                        not intersection.is_empty
                        and intersection.length >= min_match_length
                    ):
                        results[trip_index].add(seg_id)

            except (GEOSException, ValueError, TypeError):
                pass

    except Exception:
        return {}

    return dict(results)


class CoverageCalculator:
    def __init__(self, location: Dict[str, Any], task_id: str) -> None:
        self.location = location
        self.location_name = location.get("display_name", "Unknown Location")
        self.task_id = task_id
        self.streets_index = rtree.index.Index()
        self.streets_lookup: Dict[int, Dict[str, Any]] = {}
        self.utm_proj: Optional[pyproj.CRS] = None
        self.project_to_utm = None
        self.project_to_wgs84 = None
        self.street_geoms_cache: Dict[str, Dict] = {}
        self.street_bbox_cache: Dict[
            str, Tuple[float, float, float, float]
        ] = {}
        self.match_buffer: float = 15.0
        self.min_match_length: float = 5.0
        self.street_index_batch_size: int = MAX_STREETS_PER_INDEX_BATCH
        self.trip_batch_size: int = MAX_TRIPS_PER_BATCH
        self.trip_worker_sub_batch: int = TRIP_WORKER_SUB_BATCH
        self.total_length_calculated: float = 0.0
        self.total_driveable_length: float = 0.0
        self.initial_driven_length: float = 0.0
        self.initial_covered_segments: Set[str] = set()
        self.newly_covered_segments: Set[str] = set()
        self.total_trips_to_process: int = 0
        self.processed_trips_count: int = 0
        self.process_pool: Optional[ProcessPoolExecutor] = None
        self.max_workers = int(
            os.getenv("MAX_COVERAGE_WORKERS", str(MAX_WORKERS_DEFAULT))
        )
        logger.info(
            "CoverageCalculator configured with max_workers=%d",
            self.max_workers,
        )
        self.db_connection_string = os.getenv("MONGO_URI")
        self.db_name = os.getenv("MONGODB_DATABASE", "every_street")
        self.streets_collection_name = streets_collection.name

        if not self.db_connection_string:
            raise ValueError(
                "MONGO_URI environment variable is not set. Cannot connect to database."
            )

    def initialize_projections(self) -> None:
        bbox = self.location.get("boundingbox")
        center_lat, center_lon = 0.0, 0.0

        if bbox and len(bbox) == 4:
            try:
                min_lat, max_lat, min_lon, max_lon = map(float, bbox)
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

        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"
        utm_crs_string = f"+proj=utm +zone={utm_zone} +{hemisphere} +datum=WGS84 +units=m +no_defs"

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
            raise ValueError(
                f"UTM Projection initialization failed: {e}"
            ) from e

    async def update_progress(
        self, stage: str, progress: float, message: str = "", error: str = ""
    ) -> None:
        try:
            # Calculate additional metrics for UI
            coverage_pct = 0.0
            if self.total_driveable_length > 0:
                current_covered_length = self.initial_driven_length
                if self.newly_covered_segments:
                    # Estimate additional covered length based on newly covered segments
                    for rtree_id, info in self.streets_lookup.items():
                        if (info["segment_id"] in self.newly_covered_segments and 
                            info["segment_id"] not in self.initial_covered_segments):
                            current_covered_length += info["length_m"]
                coverage_pct = (current_covered_length / self.total_driveable_length) * 100

            newly_covered_count = len(self.newly_covered_segments - self.initial_covered_segments)
            
            # Create enhanced metrics dictionary with detailed stats
            enhanced_metrics = {
                "total_trips_to_process": self.total_trips_to_process,
                "processed_trips": self.processed_trips_count,
                "total_length_m": round(self.total_length_calculated, 2),
                "driveable_length_m": round(self.total_driveable_length, 2),
                "covered_length_m": round(self.initial_driven_length, 2),
                "coverage_percentage": round(coverage_pct, 2),
                "initial_covered_segments": len(self.initial_covered_segments),
                "newly_covered_segments": newly_covered_count,
                "total_covered_segments": len(self.initial_covered_segments) + newly_covered_count,
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

            await update_one_with_retry(
                progress_collection,
                {"_id": self.task_id},
                {"$set": update_data},
                upsert=True,
            )
        except Exception as e:
            logger.error(
                "Task %s: Error updating progress: %s", self.task_id, e
            )

    async def initialize_workers(self) -> None:
        if self.process_pool is None and self.max_workers > 0:
            try:
                context = multiprocessing.get_context("spawn")
                self.process_pool = ProcessPoolExecutor(
                    max_workers=self.max_workers,
                    mp_context=context,
                    initializer=None,
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
        if self.process_pool:
            pool = self.process_pool
            self.process_pool = None
            try:
                logger.info(
                    "Task %s: Shutting down process pool...", self.task_id
                )
                pool.shutdown(wait=True, cancel_futures=False)
                logger.info("Task %s: Process pool shut down.", self.task_id)
            except Exception as e:
                logger.error(
                    "Task %s: Error shutting down process pool: %s",
                    self.task_id,
                    e,
                )

    async def build_spatial_index_and_stats(self) -> bool:
        logger.info(
            "Task %s: Building spatial index for %s...",
            self.task_id,
            self.location_name,
        )
        await self.update_progress(
            "indexing", 5, f"Starting to build street index for {self.location_name}"
        )

        self.total_length_calculated = 0.0
        self.total_driveable_length = 0.0
        self.initial_driven_length = 0.0
        self.initial_covered_segments = set()
        self.streets_lookup = {}
        if self.streets_index:
            try:
                self.streets_index.close()
            except Exception:
                pass
            self.streets_index = rtree.index.Index()

        streets_query = {"properties.location": self.location_name}
        try:
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
            await self.update_progress(
                "error", 0, f"Failed to count streets: {e}"
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
        batch_num = 0

        try:
            async for street_batch in batch_cursor(
                streets_cursor, self.street_index_batch_size
            ):
                batch_num += 1
                if not self.project_to_utm:
                    raise ValueError(
                        "UTM projection not initialized during indexing."
                    )

                for street in street_batch:
                    processed_count += 1
                    try:
                        props = street.get("properties", {})
                        segment_id = props.get("segment_id")
                        geometry_data = street.get("geometry")
                        is_undriveable = props.get("undriveable", False)

                        if not segment_id or not geometry_data:
                            continue

                        self.street_geoms_cache[segment_id] = geometry_data
                        geom_wgs84 = shape(geometry_data)
                        bounds = geom_wgs84.bounds
                        geom_utm = transform(self.project_to_utm, geom_wgs84)
                        segment_length_m = geom_utm.length

                        if ENABLE_PRECOMPUTE_BBOXES:
                            self.street_bbox_cache[segment_id] = (
                                geom_utm.bounds
                            )

                        if segment_length_m <= 0.1:
                            continue

                        is_driven = props.get("driven", False)

                        self.streets_lookup[rtree_idx_counter] = {
                            "segment_id": segment_id,
                            "length_m": segment_length_m,
                            "highway": props.get("highway", "unknown"),
                            "driven": is_driven,
                            "undriveable": is_undriveable,
                        }
                        self.streets_index.insert(rtree_idx_counter, bounds)
                        rtree_idx_counter += 1

                        self.total_length_calculated += segment_length_m
                        if not is_undriveable:
                            self.total_driveable_length += segment_length_m
                            if is_driven:
                                self.initial_driven_length += segment_length_m
                                self.initial_covered_segments.add(segment_id)

                    except (GEOSException, ValueError, TypeError) as e:
                        segment_id_str = (
                            segment_id if "segment_id" in locals() else "N/A"
                        )
                        logger.warning(
                            f"Task {self.task_id}: Error processing street geom (Seg ID: {segment_id_str}): {e}"
                        )
                    except Exception as e:
                        segment_id_str = (
                            segment_id if "segment_id" in locals() else "N/A"
                        )
                        logger.error(
                            f"Task {self.task_id}: Unexpected error indexing street (Seg ID: {segment_id_str}): {e}",
                            exc_info=False,
                        )

                current_progress_pct = 5 + (
                    processed_count / total_streets_count * 45
                )
                if (current_progress_pct - last_progress_update_pct >= 5) or (
                    processed_count == total_streets_count
                ):
                    length_km = self.total_length_calculated / 1000
                    driveable_km = self.total_driveable_length / 1000
                    driven_km = self.initial_driven_length / 1000
                    
                    await self.update_progress(
                        "indexing",
                        current_progress_pct,
                        f"Indexed {processed_count:,}/{total_streets_count:,} streets | {rtree_idx_counter:,} valid | {length_km:.2f}km total | {driveable_km:.2f}km driveable | {driven_km:.2f}km already driven",
                    )
                    last_progress_update_pct = current_progress_pct
                    await asyncio.sleep(BATCH_PROCESS_DELAY)

            logger.info(
                "Task %s: Finished building spatial index for %s. Total length: %.2fm. Driveable length: %.2fm. R-tree items: %d. Initial driven (driveable): %d segments (%.2fm).",
                self.task_id,
                self.total_length_calculated,
                self.total_driveable_length,
                rtree_idx_counter,
                len(self.initial_covered_segments),
                self.initial_driven_length,
            )

            if total_streets_count > 0 and rtree_idx_counter == 0:
                logger.warning(
                    f"Task {self.task_id}: No valid segments added to index for {self.location_name} ({total_streets_count} found)."
                )

            return True

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Critical error during index build for {self.location_name}: {e}",
                exc_info=True,
            )
            await self.update_progress(
                "error", 5, f"Error building spatial index: {e}"
            )
            return False
        finally:
            if "streets_cursor" in locals() and hasattr(
                streets_cursor, "close"
            ):
                await streets_cursor.close()

    @staticmethod
    def _is_valid_trip(gps_data: Any) -> Tuple[bool, List[Any]]:
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
        await self.update_progress(
            "processing_trips",
            50,
            f"Starting trip analysis for {self.location_name}",
        )

        # Only filter for valid GPS data without spatial filtering
        base_trip_filter: Dict[str, Any] = {
            "gps": {"$exists": True, "$nin": [None, ""]}
        }
        
        # Store bounding box for later use, but don't use it to filter trips yet
        bbox = self.location.get("boundingbox")
        min_lat, max_lat, min_lon, max_lon = None, None, None, None
        if bbox and len(bbox) == 4:
            try:
                min_lat, max_lat, min_lon, max_lon = map(float, bbox)
                logger.info(
                    "Task %s: Bounding box for intersection check: [%f, %f, %f, %f]",
                    self.task_id, min_lat, max_lat, min_lon, max_lon
                )
                await self.update_progress(
                    "processing_trips",
                    51,
                    "Identifying trips within area boundaries",
                )
            except (ValueError, TypeError):
                logger.warning(
                    "Task %s: Invalid bounding box format, will process all trips.",
                    self.task_id,
                )
                await self.update_progress(
                    "processing_trips",
                    51,
                    "No valid area boundaries found - will check all trips",
                )
        else:
            logger.warning(
                "Task %s: No bounding box available, will process all trips.",
                self.task_id,
            )
            await self.update_progress(
                "processing_trips",
                51,
                "No area boundaries - processing all available trips",
            )

        # Remove already processed trips
        processed_object_ids = set()
        for tid in processed_trip_ids_set:
            if ObjectId.is_valid(tid):
                processed_object_ids.add(ObjectId(tid))
        
        if processed_object_ids:
            await self.update_progress(
                "processing_trips",
                52,
                f"Excluding {len(processed_object_ids):,} previously processed trips",
            )

        filter_components = []
        for key, value in base_trip_filter.items():
            filter_components.append({key: value})

        if processed_object_ids:
            id_filter = {"_id": {"$nin": list(processed_object_ids)}}
            filter_components.append(id_filter)

        if not filter_components:
            final_trip_filter = {}
        elif len(filter_components) == 1:
            final_trip_filter = filter_components[0]
        else:
            final_trip_filter = {"$and": filter_components}

        await self.update_progress(
            "processing_trips",
            53,
            "Querying database for new GPS trips",
        )

        try:
            # Count all trips with GPS data
            await self.update_progress(
                "processing_trips",
                54,
                "Counting available GPS trips in database",
            )
            self.total_trips_to_process = await count_documents_with_retry(
                trips_collection, final_trip_filter
            )
            logger.info(
                "Task %s: Found %d trips with GPS data for processing.",
                self.task_id,
                self.total_trips_to_process,
            )
            
            await self.update_progress(
                "processing_trips",
                55,
                f"Found {self.total_trips_to_process:,} trips to process - preparing workers",
            )
        except OperationFailure as e:
            logger.error(
                "Task %s: MongoDB Error counting trips (Code: %s): %s. Filter: %s",
                self.task_id,
                e.code,
                e.details,
                str(final_trip_filter)[:500],
            )
            await self.update_progress(
                "error", 50, f"Error counting trips: {e.details}"
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
                "error", 50, f"Error counting trips: {e}"
            )
            return False

        if self.total_trips_to_process == 0:
            logger.info(
                "Task %s: No new trips to process for %s.",
                self.task_id,
                self.location_name,
            )
            await self.update_progress(
                "processing_trips", 90, "No new trips found to process"
            )
            return True

        await self.initialize_workers()
        await self.update_progress(
            "processing_trips",
            56,
            f"Initialized {self.max_workers} processing workers - loading trips",
        )

        trips_cursor = trips_collection.find(
            final_trip_filter, {"gps": 1, "_id": 1}
        ).batch_size(self.trip_batch_size)

        pending_futures_map: Dict[Future, List[Tuple[str, List[Any]]]] = {}
        processed_count_local = 0
        intersecting_trips_count = 0
        batch_num = 0
        last_progress_update_pct = 56

        try:
            async for trip_batch_docs in batch_cursor(
                trips_cursor, self.trip_batch_size
            ):
                batch_num += 1
                valid_trips_in_batch: List[Tuple[str, List[Any]]] = []

                logger.debug(
                    f"Task {self.task_id}: Processing main trip batch {batch_num}..."
                )
                for trip_doc in trip_batch_docs:
                    trip_id = str(trip_doc["_id"])
                    if trip_id in processed_trip_ids_set:
                        continue

                    is_valid, coords = self._is_valid_trip(trip_doc.get("gps"))
                    if is_valid:
                        # Additional check: if we have a bounding box, check if any point
                        # in the trip intersects with it
                        if min_lat is not None and max_lat is not None and min_lon is not None and max_lon is not None:
                            has_intersection = False
                            for coord in coords:
                                lon, lat = coord[0], coord[1]
                                if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat:
                                    has_intersection = True
                                    break
                            
                            if has_intersection:
                                valid_trips_in_batch.append((trip_id, coords))
                                intersecting_trips_count += 1
                            else:
                                # Skip trips that don't intersect with the bounding box
                                processed_trip_ids_set.add(trip_id)
                        else:
                            # If no bounding box, include all valid trips
                            valid_trips_in_batch.append((trip_id, coords))
                    else:
                        processed_trip_ids_set.add(trip_id)

                if not valid_trips_in_batch:
                    logger.debug(
                        f"Task {self.task_id}: No valid trips in main batch {batch_num}."
                    )
                    continue

                # Continue with existing processing logic...
                all_coords = []
                for _, coords in valid_trips_in_batch:
                    all_coords.extend(coords)

                batch_candidate_segment_ids = set()
                try:
                    if all_coords:
                        multi_point = MultiPoint(all_coords)
                        buffer_deg = self.match_buffer / 111000
                        batch_bounds = multi_point.buffer(buffer_deg).bounds
                        candidate_indices = list(
                            self.streets_index.intersection(batch_bounds)
                        )
                        for idx in candidate_indices:
                            if idx in self.streets_lookup:
                                if not self.streets_lookup[idx].get(
                                    "undriveable", False
                                ):
                                    batch_candidate_segment_ids.add(
                                        self.streets_lookup[idx]["segment_id"]
                                    )
                    else:
                        batch_candidate_segment_ids = set()

                except (GEOSException, ValueError, TypeError) as e:
                    logger.warning(
                        f"Task {self.task_id}: Error finding batch candidates: {e}. Using per-trip candidates."
                    )
                    batch_candidate_segment_ids = set()
                    for trip_id, coords in valid_trips_in_batch:
                        try:
                            if coords:
                                multi_point = MultiPoint(coords)
                                buffer_deg = self.match_buffer / 111000
                                trip_bounds = multi_point.buffer(
                                    buffer_deg
                                ).bounds
                                candidate_indices = list(
                                    self.streets_index.intersection(
                                        trip_bounds
                                    )
                                )
                                for idx in candidate_indices:
                                    if idx in self.streets_lookup:
                                        if not self.streets_lookup[idx].get(
                                            "undriveable", False
                                        ):
                                            batch_candidate_segment_ids.add(
                                                self.streets_lookup[idx][
                                                    "segment_id"
                                                ]
                                            )
                        except Exception:
                            pass

                if not batch_candidate_segment_ids:
                    logger.debug(
                        f"Task {self.task_id}: No driveable candidate segments found for main batch {batch_num}."
                    )
                    processed_count_local += len(valid_trips_in_batch)
                    processed_trip_ids_set.update(
                        [tid for tid, _ in valid_trips_in_batch]
                    )
                    continue

                batch_candidate_geoms_dict: Dict[str, Dict] = {}
                segments_to_fetch = []

                for seg_id in batch_candidate_segment_ids:
                    if seg_id in self.street_geoms_cache:
                        batch_candidate_geoms_dict[seg_id] = (
                            self.street_geoms_cache[seg_id]
                        )
                    else:
                        segments_to_fetch.append(seg_id)

                if segments_to_fetch:
                    try:
                        geom_cursor = streets_collection.find(
                            {
                                "properties.segment_id": {
                                    "$in": segments_to_fetch
                                }
                            },
                            {
                                "geometry": 1,
                                "properties.segment_id": 1,
                                "_id": 0,
                            },
                        ).batch_size(min(5000, len(segments_to_fetch)))

                        async for street_doc in geom_cursor:
                            seg_id = street_doc.get("properties", {}).get(
                                "segment_id"
                            )
                            if seg_id and "geometry" in street_doc:
                                geom = street_doc["geometry"]
                                batch_candidate_geoms_dict[seg_id] = geom
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

                if len(batch_candidate_geoms_dict) > MAX_STREETS_PER_WORKER:
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

                precomputed_bboxes = None
                if ENABLE_PRECOMPUTE_BBOXES:
                    precomputed_bboxes = {}
                    for seg_id in batch_candidate_geoms_dict:
                        if seg_id in self.street_bbox_cache:
                            precomputed_bboxes[seg_id] = (
                                self.street_bbox_cache[seg_id]
                            )

                logger.debug(
                    f"Task {self.task_id}: Submitting {len(valid_trips_in_batch)} trips to workers for main batch {batch_num}..."
                )

                for i in range(
                    0, len(valid_trips_in_batch), self.trip_worker_sub_batch
                ):
                    sub_batch = valid_trips_in_batch[
                        i : i + self.trip_worker_sub_batch
                    ]
                    sub_batch_coords = [coords for _, coords in sub_batch]
                    sub_batch_trip_ids = [tid for tid, _ in sub_batch]

                    for chunk_idx, geom_chunk in enumerate(geom_chunks):
                        if not geom_chunk:
                            continue

                        if self.process_pool and self.max_workers > 0:
                            try:
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
                                processed_trip_ids_set.update(
                                    sub_batch_trip_ids
                                )
                        else:
                            try:
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
                                        self.newly_covered_segments.update(
                                            matched_ids
                                        )
                                processed_count_local += len(sub_batch)
                                processed_trip_ids_set.update(
                                    sub_batch_trip_ids
                                )
                            except Exception as seq_err:
                                logger.error(
                                    f"Task {self.task_id}: Error sequential processing: {seq_err}"
                                )
                                processed_count_local += len(sub_batch)
                                processed_trip_ids_set.update(
                                    sub_batch_trip_ids
                                )

                if (
                    pending_futures_map
                    and len(pending_futures_map) > self.max_workers * 2
                ):
                    logger.debug(
                        f"Task {self.task_id}: Processing {len(pending_futures_map)} pending futures..."
                    )
                    done_futures = []
                    for future in list(pending_futures_map.keys()):
                        if future.done():
                            done_futures.append(future)

                    for future in done_futures:
                        original_sub_batch = pending_futures_map.pop(
                            future, []
                        )
                        sub_batch_trip_ids = [
                            tid for tid, _ in original_sub_batch
                        ]
                        try:
                            result_map = future.result(timeout=0.1)
                            for trip_idx, matched_ids in result_map.items():
                                if isinstance(matched_ids, set):
                                    self.newly_covered_segments.update(
                                        matched_ids
                                    )
                            processed_count_local += len(original_sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)
                        except (TimeoutError, CancelledError, Exception) as e:
                            logger.error(
                                f"Task {self.task_id}: Error getting result from future: {type(e).__name__}. Marking processed."
                            )
                            processed_count_local += len(original_sub_batch)
                            processed_trip_ids_set.update(sub_batch_trip_ids)

                self.processed_trips_count = processed_count_local
                if self.total_trips_to_process > 0:
                    current_progress_pct = 50 + (
                        processed_count_local
                        / self.total_trips_to_process
                        * 40
                    )
                else:
                    current_progress_pct = 90

                if (batch_num % PROGRESS_UPDATE_INTERVAL_TRIPS == 0) or (
                    processed_count_local >= self.total_trips_to_process
                ):
                    if (
                        current_progress_pct - last_progress_update_pct >= 1
                    ) or (
                        processed_count_local >= self.total_trips_to_process
                    ):
                        new_segments_count = len(self.newly_covered_segments - self.initial_covered_segments)
                        message = (
                            f"Processed {processed_count_local:,}/{self.total_trips_to_process:,} trips "
                            f"| Found {new_segments_count:,} newly covered segments"
                        )
                        
                        if intersecting_trips_count > 0:
                            message += f" | {intersecting_trips_count:,} trips intersect area"
                            
                        await self.update_progress(
                            "processing_trips",
                            current_progress_pct,
                            message,
                        )
                        last_progress_update_pct = current_progress_pct
                        await asyncio.sleep(BATCH_PROCESS_DELAY)

            if pending_futures_map:
                logger.info(
                    f"Task {self.task_id}: Processing {len(pending_futures_map)} remaining trip futures..."
                )
                remaining_futures_chunks = [
                    list(pending_futures_map.keys())[i : i + self.max_workers]
                    for i in range(
                        0, len(pending_futures_map), self.max_workers
                    )
                ]

                for chunk_idx, futures_chunk in enumerate(
                    remaining_futures_chunks
                ):
                    wrapped_futures = [
                        asyncio.wrap_future(f) for f in futures_chunk
                    ]

                    try:
                        chunk_wait_timeout = PROCESS_TIMEOUT_WORKER * 2
                        done, pending = await asyncio.wait(
                            wrapped_futures,
                            timeout=chunk_wait_timeout,
                            return_when=asyncio.ALL_COMPLETED,
                        )

                        for wrapped_done_future in done:
                            original_future = futures_chunk[
                                wrapped_futures.index(wrapped_done_future)
                            ]
                            original_sub_batch = pending_futures_map.pop(
                                original_future, []
                            )
                            sub_batch_trip_ids = [
                                tid for tid, _ in original_sub_batch
                            ]

                            try:
                                result_map = wrapped_done_future.result()
                                for (
                                    trip_idx,
                                    matched_ids,
                                ) in result_map.items():
                                    if isinstance(matched_ids, set):
                                        self.newly_covered_segments.update(
                                            matched_ids
                                        )
                                processed_count_local += len(
                                    original_sub_batch
                                )
                                processed_trip_ids_set.update(
                                    sub_batch_trip_ids
                                )
                            except Exception as e:
                                logger.error(
                                    f"Task {self.task_id}: Final worker error: {type(e).__name__}. Marking processed."
                                )
                                processed_count_local += len(
                                    original_sub_batch
                                )
                                processed_trip_ids_set.update(
                                    sub_batch_trip_ids
                                )

                        for wrapped_pending_future in pending:
                            original_future = futures_chunk[
                                wrapped_futures.index(wrapped_pending_future)
                            ]
                            original_sub_batch = pending_futures_map.pop(
                                original_future, []
                            )
                            sub_batch_trip_ids = [
                                tid for tid, _ in original_sub_batch
                            ]

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
                        for future in futures_chunk:
                            if future in pending_futures_map:
                                batch_data = pending_futures_map.pop(
                                    future, []
                                )
                                ids = [tid for tid, _ in batch_data]
                                processed_count_local += len(batch_data)
                                processed_trip_ids_set.update(ids)
                                try:
                                    future.cancel()
                                except Exception:
                                    pass

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
                "Task %s: Finished processing trips for %s. Total trips processed: %d/%d. Trips intersecting area: %d. Newly covered segments found: %d.",
                self.task_id,
                self.location_name,
                self.processed_trips_count,
                self.total_trips_to_process,
                intersecting_trips_count,
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
            await self.update_progress(
                "error", 50, f"Error processing trips: {e}"
            )
            return False
        finally:
            if "trips_cursor" in locals() and hasattr(trips_cursor, "close"):
                await trips_cursor.close()
            await self.shutdown_workers()

    async def finalize_coverage(
        self, processed_trip_ids_set: Set[str]
    ) -> Optional[Dict[str, Any]]:
        total_driven_before = len(self.initial_covered_segments)
        newly_driven = len(self.newly_covered_segments - self.initial_covered_segments)
        
        await self.update_progress(
            "finalizing",
            90,
            f"Updating {newly_driven:,} newly driven segments of {total_driven_before + newly_driven:,} total",
        )

        segments_to_update = []
        for seg_id in self.newly_covered_segments:
            found = False
            for rtree_id, info in self.streets_lookup.items():
                if info["segment_id"] == seg_id:
                    if not info.get("undriveable", False):
                        if seg_id not in self.initial_covered_segments:
                            segments_to_update.append(seg_id)
                    found = True
                    break
            if not found:
                logger.warning(
                    f"Segment {seg_id} found by trip but not in streets_lookup during finalize."
                )

        if segments_to_update:
            logger.info(
                "Task %s: Updating 'driven' status for %d newly covered (and driveable) segments...",
                self.task_id,
                len(segments_to_update),
            )
            try:
                max_update_batch = 10000
                for i in range(0, len(segments_to_update), max_update_batch):
                    segment_batch = segments_to_update[
                        i : i + max_update_batch
                    ]
                    current_batch = i // max_update_batch + 1
                    total_batches = (len(segments_to_update) + max_update_batch - 1) // max_update_batch
                    
                    await self.update_progress(
                        "finalizing",
                        90 + (i / len(segments_to_update) * 5),
                        f"Updating database (batch {current_batch}/{total_batches}) with {len(segment_batch):,} segments",
                    )
                    
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
                        f"Task {self.task_id}: Bulk update batch {i // max_update_batch + 1} result: Matched={update_result.matched_count}, Modified={update_result.modified_count}"
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
                    "error", 90, f"Error updating DB: {e}"
                )
                return None
        else:
            logger.info(
                f"Task {self.task_id}: No new driveable segments to mark as driven for {self.location_name}."
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
            final_total_segments = len(self.streets_lookup)

            street_type_stats = defaultdict(
                lambda: {
                    "total": 0,
                    "covered": 0,
                    "length": 0.0,
                    "covered_length": 0.0,
                    "undriveable_length": 0.0,
                }
            )

            final_driven_status = {}
            for seg_id in self.initial_covered_segments:
                final_driven_status[seg_id] = True
            for seg_id in segments_to_update:
                final_driven_status[seg_id] = True

            for rtree_id, street_info in self.streets_lookup.items():
                segment_id = street_info["segment_id"]
                length = street_info["length_m"]
                highway = street_info["highway"]
                is_undriveable = street_info.get("undriveable", False)
                is_driven = final_driven_status.get(segment_id, False)

                final_total_length += length
                street_type_stats[highway]["total"] += 1
                street_type_stats[highway]["length"] += length

                if is_undriveable:
                    street_type_stats[highway]["undriveable_length"] += length
                else:
                    final_driveable_length += length
                    if is_driven:
                        final_driven_length += length
                        street_type_stats[highway]["covered"] += 1
                        street_type_stats[highway]["covered_length"] += length

            final_coverage_percentage = (
                (final_driven_length / final_driveable_length * 100)
                if final_driveable_length > 0
                else 0.0
            )

            final_street_types = []
            for highway_type, stats in street_type_stats.items():
                type_driveable_length = (
                    stats["length"] - stats["undriveable_length"]
                )
                coverage_pct = (
                    (stats["covered_length"] / type_driveable_length * 100)
                    if type_driveable_length > 0
                    else 0.0
                )
                final_street_types.append(
                    {
                        "type": highway_type,
                        "total": stats["total"],
                        "covered": stats["covered"],
                        "length": stats["length"],
                        "covered_length": stats["covered_length"],
                        "coverage_percentage": coverage_pct,
                        "undriveable_length": stats["undriveable_length"],
                    }
                )
            final_street_types.sort(key=lambda x: x["length"], reverse=True)

            coverage_stats = {
                "total_length": final_total_length,
                "driven_length": final_driven_length,
                "driveable_length": final_driveable_length,
                "coverage_percentage": final_coverage_percentage,
                "total_segments": final_total_segments,
                "street_types": final_street_types,
            }
            logger.info(
                f"Task {self.task_id}: Final stats calculated: {final_coverage_percentage:.2f}% coverage ({final_driven_length:.2f}m / {final_driveable_length:.2f}m driveable).",
            )

        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error calculating final stats: {e}",
                exc_info=True,
            )
            await self.update_progress(
                "error", 95, f"Error calculating stats: {e}"
            )
            return None

        logger.info(
            f"Task {self.task_id}: Updating coverage metadata for {self.location_name}..."
        )
        try:
            trip_ids_to_store = list(processed_trip_ids_set)
            trip_ids_too_large = len(trip_ids_to_store) > 100000

            update_doc = {
                "$set": {
                    **coverage_stats,
                    "last_updated": datetime.now(timezone.utc),
                    "status": "completed_stats",
                    "last_error": None,
                    "processed_trips.last_processed_timestamp": datetime.now(
                        timezone.utc
                    ),
                    "processed_trips.count": len(processed_trip_ids_set),
                    "needs_stats_update": False,
                    "last_stats_update": datetime.now(timezone.utc),
                },
                "$unset": {"streets_data": ""},
            }

            if not trip_ids_too_large:
                update_doc["$set"]["processed_trips.trip_ids"] = (
                    trip_ids_to_store
                )
            else:
                logger.warning(
                    f"Task {self.task_id}: Too many trip IDs ({len(trip_ids_to_store)}) to store in metadata."
                )
                update_doc["$unset"]["processed_trips.trip_ids"] = ""

            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": self.location_name},
                update_doc,
                upsert=True,
            )
            logger.info(
                f"Task {self.task_id}: Coverage metadata updated for {self.location_name}."
            )
        except Exception as e:
            logger.error(
                f"Task {self.task_id}: Error updating coverage metadata: {e}",
                exc_info=True,
            )

        final_result = {
            **coverage_stats,
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
                "initializing", 0, f"Initializing {run_type} calculation..."
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
                    "error", 0, f"Projection Error: {proj_err}"
                )
                return None

            index_success = await self.build_spatial_index_and_stats()
            if not index_success:
                logger.error(
                    "Task %s: Failed during spatial index build for %s.",
                    self.task_id,
                    self.location_name,
                )
                await self.update_progress(
                    "error", 5, "Failed to build spatial index"
                )
                return None

            if self.total_length_calculated == 0 and not self.streets_lookup:
                logger.info(
                    "Task %s: No valid streets found for %s during indexing. Reporting 0%% coverage.",
                    self.task_id,
                    self.location_name,
                )
                processed_trip_ids_set: Set[str] = set()
                final_stats = await self.finalize_coverage(
                    processed_trip_ids_set
                )
                asyncio.create_task(
                    generate_and_store_geojson(
                        self.location_name, self.task_id
                    )
                )
                return final_stats

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
                            trip_ids_data = metadata["processed_trips"][
                                "trip_ids"
                            ]
                            if isinstance(trip_ids_data, (list, set)):
                                processed_trip_ids_set = set(
                                    map(str, trip_ids_data)
                                )
                                logger.info(
                                    "Task %s: Loaded %d previously processed trip IDs for incremental run.",
                                    self.task_id,
                                    len(processed_trip_ids_set),
                                )
                        else:
                            logger.warning(
                                "Task %s: No 'trip_ids' found in processed_trips. Running as full.",
                                self.task_id,
                            )
                    else:
                        logger.warning(
                            "Task %s: No 'processed_trips' field found. Running as full.",
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

            trips_success = await self.process_trips(processed_trip_ids_set)
            if not trips_success:
                calculation_error = "Trip processing failed"
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
                await coverage_metadata_collection.update_one(
                    {"location.display_name": self.location_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": "Finalization failed",
                        }
                    },
                )
                return None

            if calculation_error:
                await coverage_metadata_collection.update_one(
                    {"location.display_name": self.location_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": calculation_error,
                        }
                    },
                )
                final_stats["status"] = "error"
                final_stats["last_error"] = calculation_error
                logger.warning(
                    f"Task {self.task_id}: Calculation completed with error: {calculation_error}"
                )

            end_time = datetime.now(timezone.utc)
            duration = (end_time - start_time).total_seconds()
            logger.info(
                "Task %s: Coverage computation (%s) for %s finished in %.2f seconds.",
                self.task_id,
                run_type,
                self.location_name,
                duration,
            )

            if not calculation_error and final_stats is not None:
                logger.info(
                    f"Task {self.task_id}: Triggering GeoJSON generation."
                )
                asyncio.create_task(
                    generate_and_store_geojson(
                        self.location_name, self.task_id
                    )
                )
            elif calculation_error:
                logger.warning(
                    f"Task {self.task_id}: Skipping GeoJSON generation due to trip processing error."
                )
                await self.update_progress(
                    "error", 100, f"Completed with error: {calculation_error}"
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
            try:
                await coverage_metadata_collection.update_one(
                    {"location.display_name": self.location_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": f"Unhandled: {str(e)}",
                        }
                    },
                )
            except Exception as db_err:
                logger.error(
                    f"Failed to update error status after unhandled exception: {db_err}"
                )
            return None
        finally:
            await self.shutdown_workers()
            self.streets_lookup = {}
            self.street_geoms_cache = {}
            self.street_bbox_cache = {}
            if self.streets_index:
                try:
                    self.streets_index.close()
                except Exception as rtree_close_err:
                    logger.warning(
                        f"Error closing R-tree index: {rtree_close_err}"
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

        if result is None:
            logger.error(
                f"Task {task_id}: Full coverage calculation failed internally for {location_name}"
            )
            return None
        elif result.get("status") == "error":
            logger.error(
                f"Task {task_id}: Full coverage calculation completed with error for {location_name}: {result.get('last_error')}"
            )
            return result

        logger.info(
            f"Task {task_id}: Full coverage calculation stats phase complete for {location_name}."
        )
        return result

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
            pass


async def compute_incremental_coverage(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
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

        if result is None:
            logger.error(
                f"Task {task_id}: Incremental coverage calculation failed internally for {location_name}"
            )
            return None
        elif result.get("status") == "error":
            logger.error(
                f"Task {task_id}: Incremental coverage calculation completed with error for {location_name}: {result.get('last_error')}"
            )
            return result

        logger.info(
            f"Task {task_id}: Incremental coverage calculation stats phase complete for {location_name}."
        )
        return result

    except asyncio.TimeoutError:
        error_msg = f"Incremental calculation timed out after {PROCESS_TIMEOUT_INCREMENTAL}s"
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
            pass


async def generate_and_store_geojson(
    location_name: Optional[str], task_id: str
) -> None:
    if not location_name:
        logger.error(
            "Task %s: Cannot generate GeoJSON, location name is missing.",
            task_id,
        )
        return

    logger.info(
        "Task %s: Starting streamed GeoJSON generation for %s...",
        task_id,
        location_name,
    )
    await progress_collection.update_one(
        {"_id": task_id},
        {
            "$set": {
                "stage": "generating_geojson",
                "progress": 90,
                "message": "Creating interactive map data for visualization...",
            }
        },
    )

    fs: AsyncIOMotorGridFSBucket = db_manager.gridfs_bucket
    gridfs_filename = (
        f"{location_name.replace(' ', '_').replace(',', '')}_streets.geojson"
    )
    total_features = 0
    file_id = None
    upload_stream = None

    try:
        existing_meta = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {"streets_geojson_gridfs_id": 1},
        )
        if existing_meta and existing_meta.get("streets_geojson_gridfs_id"):
            old_gridfs_id = existing_meta["streets_geojson_gridfs_id"]
            try:
                await fs.delete(old_gridfs_id)
                logger.info(
                    f"Task {task_id}: Deleted old GridFS file {old_gridfs_id} for {location_name}."
                )
            except Exception as del_err:
                logger.warning(
                    f"Task {task_id}: Failed to delete old GridFS file {old_gridfs_id}: {del_err}"
                )

        upload_stream = fs.open_upload_stream(
            gridfs_filename,
            metadata={
                "contentType": "application/json",
                "location": location_name,
                "generated_at": datetime.now(timezone.utc),
            },
        )

        await upload_stream.write(
            '{"type": "FeatureCollection", "features": [\n'.encode("utf-8")
        )

        streets_cursor = streets_collection.find(
            {"properties.location": location_name},
            {"geometry": 1, "properties": 1, "_id": 0},
        ).batch_size(1000)

        first_feature = True
        try:
            async for street_batch in batch_cursor(streets_cursor, 1000):
                for street in street_batch:
                    if "properties" not in street or "geometry" not in street:
                        continue

                    props = street["properties"]
                    if not props or "geometry" not in street:
                        continue

                    props["segment_id"] = props.get(
                        "segment_id", f"missing_{total_features}"
                    )
                    props["driven"] = props.get("driven", False)
                    props["highway"] = props.get("highway", "unknown")
                    props["segment_length"] = props.get("segment_length", 0.0)
                    props["undriveable"] = props.get("undriveable", False)

                    feature = {
                        "type": "Feature",
                        "geometry": street["geometry"],
                        "properties": props,
                    }

                    feature_json = bson.json_util.dumps(feature)
                    if not first_feature:
                        await upload_stream.write(b",\n")
                    await upload_stream.write(feature_json.encode("utf-8"))
                    first_feature = False
                    total_features += 1

                await asyncio.sleep(0.01)

            metadata_stats = (
                await find_one_with_retry(
                    coverage_metadata_collection,
                    {"location.display_name": location_name},
                    {
                        "total_length": 1,
                        "driven_length": 1,
                        "driveable_length": 1,
                        "coverage_percentage": 1,
                        "street_types": 1,
                        "total_segments": 1,
                    },
                )
                or {}
            )

            geojson_metadata = {
                "total_length": metadata_stats.get("total_length", 0),
                "driven_length": metadata_stats.get("driven_length", 0),
                "driveable_length": metadata_stats.get("driveable_length", 0),
                "coverage_percentage": metadata_stats.get(
                    "coverage_percentage", 0
                ),
                "street_types": metadata_stats.get("street_types", []),
                "total_features": total_features,
                "total_segments_metadata": metadata_stats.get("total_segments", 0),
                "geojson_generated_at": datetime.now(timezone.utc).isoformat(),
            }
            metadata_json = bson.json_util.dumps(geojson_metadata)

            await upload_stream.write(
                f'\n], "metadata": {metadata_json}\n}}'.encode("utf-8")
            )

            await upload_stream.close()
            file_id = upload_stream._id

            if file_id:
                logger.info(
                    "Task %s: Finished streaming %d features to GridFS for %s (File ID: %s).",
                    task_id,
                    total_features,
                    location_name,
                    file_id,
                )
                logger.info(
                    "Task %s: Attempting to update metadata for '%s' with GridFS ID: %s",
                    task_id, location_name, file_id
                )
                update_result = await update_one_with_retry(
                    coverage_metadata_collection,
                    {"location.display_name": location_name},
                    {
                        "$set": {
                            "streets_geojson_gridfs_id": file_id,
                            "status": "completed",
                            "last_updated": datetime.now(timezone.utc),
                            "last_error": None,
                            "total_segments": total_features,
                        },
                        "$unset": {"streets_data": ""},
                    },
                )
                logger.info(
                    "Task %s: Metadata update result for '%s': Matched=%d, Modified=%d",
                    task_id, location_name, update_result.matched_count, update_result.modified_count
                )
                if update_result.matched_count > 0 and update_result.modified_count > 0:
                    logger.info(
                        "Task %s: Successfully updated metadata for '%s' with GridFS ID %s.",
                        task_id,
                        location_name,
                        file_id,
                    )
                    await progress_collection.update_one(
                        {"_id": task_id},
                        {
                            "$set": {
                                "stage": "complete",
                                "progress": 100,
                                "message": f"Coverage analysis complete with {total_features:,} street segments | Ready to view",
                            }
                        },
                    )
                else:
                    if update_result.matched_count == 0:
                        logger.warning(
                            "Task %s: Failed to find metadata document for location '%s' during GridFS ID update.",
                            task_id, location_name
                        )
                    else:
                        logger.warning(
                            "Task %s: Found metadata document for location '%s' but did not modify it (maybe ID was already set?).",
                            task_id, location_name
                        )
                    await progress_collection.update_one(
                        {"_id": task_id},
                        {
                            "$set": {
                                "stage": "error",
                                "message": "Failed to update metadata with GeoJSON ID.",
                                "error": "Metadata update verification failed",
                            }
                        },
                    )
            else:
                error_msg = "Failed to obtain GridFS file_id after successful stream close."
                logger.error("Task %s: %s for %s", task_id, error_msg, location_name)
                await progress_collection.update_one(
                    {"_id": task_id},
                    {
                        "$set": {
                            "stage": "error",
                            "message": error_msg,
                            "error": "GridFS file ID missing post-close",
                        }
                    },
                )
                await coverage_metadata_collection.update_one(
                    {"location.display_name": location_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": error_msg,
                        },
                        "$unset": {"streets_geojson_gridfs_id": ""},
                    },
                )

        except Exception as write_error:
            logger.error(
                "Task %s: Error during GeoJSON stream writing/closing for %s: %s",
                task_id, location_name, write_error, exc_info=True
            )
            if upload_stream and not upload_stream.closed:
                try:
                    await upload_stream.abort()
                    logger.info("Task %s: Aborted GridFS upload stream for %s due to write error.", task_id, location_name)
                except Exception as abort_err:
                    logger.error("Task %s: Error aborting GridFS stream for %s: %s", task_id, location_name, abort_err)
            raise write_error

    except Exception as e:
        error_msg = f"Error during GeoJSON generation/storage: {e}"
        logger.error("Task %s: %s", task_id, error_msg, exc_info=True)
        if upload_stream and not upload_stream.closed:
            try:
                await upload_stream.abort()
                logger.info("Task %s: Aborted GridFS upload stream in outer error handler.", task_id)
            except Exception as abort_err:
                logger.error("Task %s: Error aborting GridFS stream in outer handler: %s", task_id, abort_err)
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
                },
                "$unset": {"streets_geojson_gridfs_id": ""},
            },
        )

    finally:
        if "streets_cursor" in locals() and hasattr(streets_cursor, "close"):
            await streets_cursor.close()
