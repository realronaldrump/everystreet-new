"""Street coverage calculation module.

Calculates street segment coverage based on trip data using efficient spatial
indexing, multiprocessing, bulk database operations, and incremental statistics.
Stores large GeoJSON results in GridFS.
"""

import asyncio
import logging
import multiprocessing
import os
from collections import defaultdict
from concurrent.futures import CancelledError, Future, ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from datetime import datetime, timezone
from typing import Any

import bson.json_util
import numpy as np
import pyproj
import rtree
from bson import ObjectId
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorGridFSBucket
from pymongo.errors import BulkWriteError, OperationFailure
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPoint, box, mapping, shape
from shapely.ops import transform, unary_union

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
from osm_utils import generate_geojson_osm

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
    trip_coords_list: list[list[Any]],
    candidate_utm_geoms: dict[str, Any],
    candidate_utm_bboxes: dict[str, tuple[float, float, float, float]],
    utm_proj_string: str,
    wgs84_proj_string: str,
    match_buffer: float,
    min_match_length: float,
) -> dict[int, set[str]]:
    """Processes a batch of trips against candidate street UTM geometries."""
    start_time = datetime.now(timezone.utc)
    worker_pid = os.getpid()
    logger.debug(
        "Worker %d: Starting processing for %d trips against %d segments.",
        worker_pid,
        len(trip_coords_list),
        len(candidate_utm_geoms),
    )

    results: dict[int, set[str]] = defaultdict(set)
    if not trip_coords_list or not candidate_utm_geoms:
        logger.warning(
            "Worker %d: Empty trip list or candidate UTM geometries received.",
            worker_pid,
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
            logger.error(
                "Worker %d: Failed to initialize projections: %s",
                worker_pid,
                e,
            )
            return {}
        except Exception as proj_e:
            logger.error(
                "Worker %d: Unexpected error during projection setup: %s",
                worker_pid,
                proj_e,
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

                    intersection = trip_buffer_utm.intersection(
                        street_utm_geom,
                    )

                    # Dynamic overlap requirement: for very short segments, require a
                    # reasonable fraction of the segment length rather than a fixed
                    # absolute threshold. This addresses tiny intersection-center
                    # segments that would otherwise never reach a fixed minimum.
                    try:
                        segment_length_m = street_utm_geom.length
                    except Exception:
                        segment_length_m = 0.0

                    # Require at least 60% of a very short segment to be overlapped,
                    # but never more than the configured absolute minimum, and clamp
                    # to a small absolute floor to avoid spurious micro-intersections.
                    dynamic_required_overlap = min(
                        max(
                            1.0, 0.6 * segment_length_m
                        ),  # fraction-based for short segments
                        max(0.0, float(min_match_length)),  # absolute cap from settings
                    )

                    if (
                        not intersection.is_empty
                        and intersection.length >= dynamic_required_overlap
                    ):
                        results[trip_index].add(seg_id)
                    else:
                        # Distance fallback for short segments: if the segment is
                        # shorter than the configured minimum and sits within the
                        # buffer distance of the trip line, consider it matched.
                        if segment_length_m > 0.0 and segment_length_m < float(
                            min_match_length
                        ):
                            try:
                                if (
                                    trip_line_utm.distance(street_utm_geom)
                                    <= match_buffer
                                ):
                                    results[trip_index].add(seg_id)
                            except Exception:
                                # If distance computation fails, ignore and continue
                                pass

            except (
                GEOSException,
                ValueError,
                TypeError,
            ) as trip_proc_err:
                logger.warning(
                    "Worker %d: Error processing trip at index %d: %s",
                    worker_pid,
                    trip_index,
                    trip_proc_err,
                )
            except Exception as trip_e:
                logger.error(
                    "Worker %d: Unexpected error processing trip at index %d: %s",
                    worker_pid,
                    trip_index,
                    trip_e,
                )

    except Exception as outer_e:
        logger.error(
            "Worker %d: Unhandled exception in process_trip_worker: %s",
            worker_pid,
            outer_e,
            exc_info=True,
        )
        return {}

    end_time = datetime.now(timezone.utc)
    duration = (end_time - start_time).total_seconds()
    logger.debug(
        "Worker %d: Finished processing. Found matches for %d trips. Duration: %.2fs",
        worker_pid,
        len(results),
        duration,
    )

    return dict(results)


class CoverageCalculator:
    """Handles the calculation of street coverage for a specific location."""

    def __init__(
        self,
        location: dict[str, Any],
        task_id: str,
    ) -> None:
        self.location = location
        self.location_name = location.get("display_name", "Unknown Location")
        self.task_id = task_id

        self.streets_index = rtree.index.Index()
        self.streets_lookup: dict[int, dict[str, Any]] = {}
        self.street_utm_geoms_cache: dict[str, Any] = {}
        self.street_utm_bboxes_cache: dict[
            str,
            tuple[float, float, float, float],
        ] = {}
        self.street_wgs84_geoms_cache: dict[str, dict] = {}

        self.utm_proj: pyproj.CRS | None = None
        self.project_to_utm = None

        raw_match_buffer = location.get("match_buffer_meters")
        self.match_buffer: float = float(
            raw_match_buffer
            if raw_match_buffer is not None
            else DEFAULT_MATCH_BUFFER_METERS
        )

        raw_min_match = location.get("min_match_length_meters")
        self.min_match_length: float = float(
            raw_min_match
            if raw_min_match is not None
            else DEFAULT_MIN_MATCH_LENGTH_METERS
        )

        self.street_index_batch_size: int = MAX_STREETS_PER_INDEX_BATCH
        self.trip_batch_size: int = MAX_TRIPS_PER_BATCH
        self.trip_worker_sub_batch: int = TRIP_WORKER_SUB_BATCH
        self.process_pool: ProcessPoolExecutor | None = None
        self.max_workers = int(
            os.getenv(
                "MAX_COVERAGE_WORKERS",
                str(MAX_WORKERS_DEFAULT),
            ),
        )
        logger.info(
            "CoverageCalculator configured with max_workers=%d",
            self.max_workers,
        )

        self.total_length_calculated: float = 0.0
        self.total_driveable_length: float = 0.0
        self.initial_driven_length: float = 0.0
        self.initial_covered_segments: set[str] = set()
        self.newly_covered_segments: set[str] = set()
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
            raise ValueError(
                f"UTM Projection initialization failed: {e}",
            ) from e

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

            for _, info in self.streets_lookup.items():
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
        """Initializes a worker pool.

        Celery prefork workers are marked as *daemonic* in Python's multiprocessing
        implementation.  A daemonic process is prohibited from creating child
        processes, which causes a ``ValueError: daemonic processes are not allowed
        to have children`` whenever we try to spin up a ``ProcessPoolExecutor``
        inside a Celery task.  To avoid flooding the logs with this error we
        detect the condition up-front and fall back to sequential (single-thread)
        execution.  This preserves correctness while keeping the door open for
        true multiprocessing when the code is executed outside a Celery worker
        (for example during CLI runs or unit tests).
        """

        # If we're running inside a Celery worker (daemon=True) we cannot spawn
        # extra processes – bail out early.
        if multiprocessing.current_process().daemon:
            logger.info(
                "Task %s: Current process is daemonic (likely a Celery worker). "
                "Disabling ProcessPoolExecutor to prevent 'daemonic processes are not allowed to have children'.",
                self.task_id,
            )
            self.max_workers = 0
            self.process_pool = None
            return

        # Regular non-daemon execution path – attempt to create a process pool.
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
                    "Task %s: Failed to create process pool (%s). Running sequentially.",
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
        boundary_geojson_data: dict | None = None,
    ) -> bool:
        """Loads streets, builds R-tree index, precomputes UTM geometries/bboxes,
        and calculates initial stats.
        Optionally clips streets to a provided boundary_geojson_data.
        """
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

        boundary_shape: shape | None = None
        if boundary_geojson_data:
            try:
                # Process the boundary_geojson_data to create a shapely geometry
                # This logic should be similar to how it's handled in preprocess_streets
                if isinstance(
                    boundary_geojson_data, dict
                ) and boundary_geojson_data.get("type") in [
                    "Polygon",
                    "MultiPolygon",
                ]:
                    boundary_shape = shape(boundary_geojson_data)
                elif (
                    isinstance(boundary_geojson_data, dict)
                    and boundary_geojson_data.get("type") == "Feature"
                ):
                    geom = boundary_geojson_data.get("geometry")
                    if geom and geom.get("type") in [
                        "Polygon",
                        "MultiPolygon",
                    ]:
                        boundary_shape = shape(geom)
                elif (
                    isinstance(boundary_geojson_data, dict)
                    and boundary_geojson_data.get("type") == "FeatureCollection"
                ):
                    geoms = []
                    for feature in boundary_geojson_data.get("features", []):
                        geom = feature.get("geometry")
                        if geom and geom.get("type") in [
                            "Polygon",
                            "MultiPolygon",
                        ]:
                            geoms.append(shape(geom))
                    if geoms:
                        valid_polys = [
                            g for g in geoms if g.is_valid or g.buffer(0).is_valid
                        ]
                        fixed_polys = [
                            g if g.is_valid else g.buffer(0) for g in valid_polys
                        ]
                        final_polys = [
                            p for p in fixed_polys if p.is_valid and not p.is_empty
                        ]
                        if final_polys:
                            boundary_shape = unary_union(final_polys)

                if boundary_shape and not boundary_shape.is_valid:
                    boundary_shape = boundary_shape.buffer(0)

                if boundary_shape and boundary_shape.is_valid:
                    logger.info(
                        "Task %s: Using provided boundary for clipping streets during indexing.",
                        self.task_id,
                    )
                else:
                    logger.warning(
                        "Task %s: Provided boundary_geojson_data was invalid or could not be processed. No clipping will occur.",
                        self.task_id,
                    )
                    boundary_shape = None  # Ensure it's None if invalid or unprocessed

            except Exception as e:
                logger.error(
                    "Task %s: Error processing provided boundary_geojson_data: %s. No clipping will occur.",
                    self.task_id,
                    e,
                )
                boundary_shape = None

        if self.streets_index:
            try:
                self.streets_index.close()
            except Exception as e:
                logger.warning(
                    "Task %s: Error closing previous R-tree index: %s",
                    self.task_id,
                    e,
                )
            self.streets_index = rtree.index.Index()

        if not self.project_to_utm:
            logger.error(
                "Task %s: UTM projection not initialized before indexing.",
                self.task_id,
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
                        "UTM projection became unavailable during indexing.",
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

                        # Optional clipping logic
                        if boundary_shape:
                            if not geom_wgs84.intersects(boundary_shape):
                                continue  # Street segment is outside the boundary
                            original_length_before_clip = geom_wgs84.length
                            geom_wgs84 = geom_wgs84.intersection(boundary_shape)
                            if (
                                not geom_wgs84.is_valid
                                or geom_wgs84.is_empty
                                or geom_wgs84.geom_type
                                not in ("LineString", "MultiLineString")
                            ):
                                continue  # Skip if clipping results in invalid, empty, or non-linear geometry

                            if geom_wgs84.geom_type == "MultiLineString":
                                largest_line = None
                                max_len = 0
                                for line_geom in geom_wgs84.geoms:
                                    if line_geom.length > max_len:
                                        max_len = line_geom.length
                                        largest_line = line_geom
                                if largest_line and largest_line.length > 1e-6:
                                    geom_wgs84 = largest_line
                                else:
                                    continue  # No suitable line found
                            elif geom_wgs84.length < 1e-6:
                                continue  # Too short after clipping

                            # Update the geometry_data in the street document if it was clipped
                            # This ensures that street_wgs84_geoms_cache stores the clipped version
                            if (
                                geom_wgs84.length < original_length_before_clip - 1e-6
                            ):  # Check if it was actually clipped
                                self.street_wgs84_geoms_cache[segment_id] = mapping(
                                    geom_wgs84
                                )
                            else:
                                self.street_wgs84_geoms_cache[segment_id] = (
                                    geometry_data  # Store original if not clipped significantly
                                )

                        else:  # No boundary_shape, store original geometry
                            self.street_wgs84_geoms_cache[segment_id] = geometry_data

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
                            "Task %s: Error processing street geom (Seg ID: %s): %s. Skipping segment.",
                            self.task_id,
                            segment_id or "N/A",
                            e,
                        )
                    except Exception as e:
                        logger.error(
                            "Task %s: Unexpected error indexing street (Seg ID: %s): %s",
                            self.task_id,
                            segment_id or "N/A",
                            e,
                            exc_info=False,
                        )

                current_progress_pct = 5 + (processed_count / total_streets_count * 45)
                if (current_progress_pct - last_progress_update_pct >= 5) or (
                    processed_count == total_streets_count
                ):
                    await self.update_progress(
                        "indexing",
                        current_progress_pct,
                        (
                            f"Indexed {processed_count:,}/{total_streets_count:,} streets | "
                            f"{rtree_idx_counter:,} valid segments | "
                            f"{self.total_driveable_length:.2f}m driveable | "
                            f"{self.initial_driven_length:.2f}m initially driven"
                        ),
                    )
                    last_progress_update_pct = current_progress_pct
                    await asyncio.sleep(BATCH_PROCESS_DELAY)

            logger.info(
                "Task %s: Finished building index for %s. "
                "Total Length: %.2fm. Driveable Length: %.2fm. "
                "R-tree items: %d. Initial Driven (Driveable): %d segments (%.2fm).",
                self.task_id,
                self.location_name,
                self.total_length_calculated,
                self.total_driveable_length,
                rtree_idx_counter,
                len(self.initial_covered_segments),
                self.initial_driven_length,
            )

            if total_streets_count > 0 and rtree_idx_counter == 0:
                logger.warning(
                    "Task %s: No valid segments added to index for %s (%d streets found in DB).",
                    self.task_id,
                    self.location_name,
                    total_streets_count,
                )

            return True

        except Exception as e:
            logger.error(
                "Task %s: Critical error during index build for %s: %s",
                self.task_id,
                self.location_name,
                e,
                exc_info=True,
            )
            await self.update_progress(
                "error",
                5,
                f"Error building spatial index: {e}",
            )
            return False
        finally:
            if "streets_cursor" in locals() and hasattr(
                streets_cursor,
                "close",
            ):
                await streets_cursor.close()

    @staticmethod
    def _get_trip_bounding_box(
        coords: list[Any],
    ) -> tuple[float, float, float, float] | None:
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
                "Could not extract coordinates for trip bounding box calculation.",
            )
            return None

    @staticmethod
    def _is_valid_trip(
        gps_data: dict[str, Any] | None,
    ) -> tuple[bool, list[list[float]]]:
        """
        Validates if the GPS data (expected to be a GeoJSON Point or LineString dict)
        is suitable for coverage calculation.

        Args:
            gps_data: A GeoJSON dictionary (Point or LineString) or None.

        Returns:
            A tuple: (is_valid, list_of_coordinate_pairs).
            For Point, the list_of_coordinate_pairs will be [coords, coords].
            Returns (False, []) if invalid.
        """
        if not gps_data or not isinstance(gps_data, dict):
            return False, []

        trip_type = gps_data.get("type")
        coordinates = gps_data.get("coordinates")

        if not trip_type or not isinstance(coordinates, list):
            return False, []

        if trip_type == "LineString":
            if len(coordinates) < 2:
                logger.debug("Invalid LineString: less than 2 coordinates.")
                return False, []

            # Validate each coordinate pair in the LineString
            valid_coords_list = []
            for coord_pair in coordinates:
                if (
                    isinstance(coord_pair, list)
                    and len(coord_pair) == 2
                    and all(isinstance(c, (int, float)) for c in coord_pair)
                    and (-180 <= coord_pair[0] <= 180 and -90 <= coord_pair[1] <= 90)
                ):  # Lon, Lat check
                    valid_coords_list.append(coord_pair)
                else:
                    logger.debug(f"Invalid coordinate pair in LineString: {coord_pair}")
                    return (
                        False,
                        [],
                    )  # Strict: entire LineString invalid if one point is bad

            if (
                len(valid_coords_list) < 2
            ):  # Ensure after validation we still have a line
                logger.debug(
                    "LineString has less than 2 valid coordinates after validation."
                )
                return False, []
            return True, valid_coords_list

        elif trip_type == "Point":
            if not (
                isinstance(coordinates, list)
                and len(coordinates) == 2
                and all(isinstance(c, (int, float)) for c in coordinates)
                and (-180 <= coordinates[0] <= 180 and -90 <= coordinates[1] <= 90)
            ):  # Lon, Lat check
                logger.debug(f"Invalid Point coordinates: {coordinates}")
                return False, []
            # For coverage, simulate a very short line segment from a Point
            return True, [coordinates, coordinates]

        else:
            logger.debug(f"Unsupported GeoJSON type for trip: {trip_type}")
            return False, []

    async def process_trips(self, processed_trip_ids_set: set[str]) -> bool:
        """Processes trips to find newly covered street segments."""
        await self.update_progress(
            "processing_trips",
            50,
            f"Starting trip analysis for {self.location_name}",
        )

        base_trip_filter: dict[str, Any] = {
            "gps": {
                "$exists": True,
                "$ne": None,
                "$not": {"$size": 0},
            },
        }

        location_bbox_wgs84: box | None = None
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

        pending_futures_map: dict[Future, list[tuple[str, list[Any]]]] = {}
        processed_count_local = 0  # Count of trips iterated from DB cursor in this run
        completed_futures_count = 0  # Count of successfully completed worker tasks
        failed_futures_count = 0
        batch_num = 0
        last_progress_update_pct = 56
        last_progress_update_time = datetime.now(timezone.utc)
        # self.processed_trips_count is now the count of *unique* trips processed by workers

        try:
            async for trip_batch_docs in batch_cursor(
                trips_cursor,
                self.trip_batch_size,
            ):
                batch_num += 1
                valid_trips_for_processing: list[tuple[str, list[Any]]] = []

                logger.debug(
                    "Task %s: Processing main trip batch %d (%d docs)...",
                    self.task_id,
                    batch_num,
                    len(trip_batch_docs),
                )

                for trip_doc in trip_batch_docs:
                    trip_id = str(trip_doc["_id"])
                    if (
                        trip_id in processed_trip_ids_set
                    ):  # Check if this unique trip was already processed
                        continue

                    is_valid, coords = self._is_valid_trip(trip_doc.get("gps"))

                    if is_valid:
                        if location_bbox_wgs84:
                            trip_bbox_coords = self._get_trip_bounding_box(
                                coords,
                            )
                            if trip_bbox_coords:
                                trip_bbox = box(*trip_bbox_coords)
                                if location_bbox_wgs84.intersects(trip_bbox):
                                    valid_trips_for_processing.append(
                                        (
                                            trip_id,
                                            coords,
                                        ),
                                    )
                                else:
                                    # This trip is outside the location, mark as processed for this run
                                    # but don't send to worker for this location
                                    processed_trip_ids_set.add(trip_id)
                            else:
                                logger.warning(
                                    "Task %s: Could not calculate bounding box for valid trip %s. Processing anyway.",
                                    self.task_id,
                                    trip_id,
                                )
                                valid_trips_for_processing.append(
                                    (
                                        trip_id,
                                        coords,
                                    ),
                                )
                        else:
                            valid_trips_for_processing.append(
                                (trip_id, coords),
                            )
                    else:
                        # Invalid trip, mark as processed for this run
                        processed_trip_ids_set.add(trip_id)

                processed_count_local += len(trip_batch_docs)

                if not valid_trips_for_processing:
                    logger.debug(
                        "Task %s: No trips passed validation/filtering in batch %d requiring worker processing.",
                        self.task_id,
                        batch_num,
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
                            buffer_deg,
                        ).bounds
                        candidate_indices = list(
                            self.streets_index.intersection(
                                batch_query_bounds,
                            ),
                        )

                        for idx in candidate_indices:
                            if idx in self.streets_lookup:
                                street_info = self.streets_lookup[idx]
                                if not street_info.get(
                                    "undriveable",
                                    False,
                                ):
                                    batch_candidate_segment_ids.add(
                                        street_info["segment_id"],
                                    )
                    except (
                        GEOSException,
                        ValueError,
                        TypeError,
                    ) as e:
                        logger.warning(
                            "Task %s: Error finding candidates for batch %d: %s. Skipping worker processing for this batch.",
                            self.task_id,
                            batch_num,
                            e,
                        )
                        continue
                    except Exception as e:
                        logger.error(
                            "Task %s: Unexpected error finding candidates for batch %d: %s. Skipping worker processing.",
                            self.task_id,
                            batch_num,
                            e,
                        )
                        continue

                if not batch_candidate_segment_ids:
                    logger.debug(
                        "Task %s: No driveable candidate segments found intersecting batch %d. Trips in batch will be marked processed.",
                        self.task_id,
                        batch_num,
                    )
                    for tid, _ in valid_trips_for_processing:
                        if tid not in processed_trip_ids_set:
                            processed_trip_ids_set.add(tid)
                    continue

                batch_candidate_utm_geoms: dict[str, Any] = {}
                batch_candidate_utm_bboxes: dict[
                    str,
                    tuple[float, float, float, float],
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
                            "Task %s: Missing cached UTM geometry or bbox for candidate segment %s in batch %d.",
                            self.task_id,
                            seg_id,
                            batch_num,
                        )

                if not batch_candidate_utm_geoms:
                    logger.warning(
                        "Task %s: No valid UTM geoms found for candidates in batch %d. Trips in batch will be marked processed.",
                        self.task_id,
                        batch_num,
                    )
                    for tid, _ in valid_trips_for_processing:
                        if tid not in processed_trip_ids_set:
                            processed_trip_ids_set.add(tid)
                    continue

                logger.debug(
                    "Task %s: Submitting %d trips against %d candidates for batch %d...",
                    self.task_id,
                    len(valid_trips_for_processing),
                    len(batch_candidate_utm_geoms),
                    batch_num,
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
                            },
                        )
                        bbox_chunks.append(
                            {
                                seg_id: batch_candidate_utm_bboxes[seg_id]
                                for seg_id in chunk_seg_ids
                            },
                        )
                    logger.info(
                        "Task %s: Split %d candidates into %d chunks for batch %d.",
                        self.task_id,
                        len(batch_candidate_utm_geoms),
                        len(geom_chunks),
                        batch_num,
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

                    for (
                        geom_chunk,
                        bbox_chunk,
                    ) in zip(
                        geom_chunks,
                        bbox_chunks,
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
                                pending_futures_map[future] = (
                                    trip_sub_batch  # Store original trip_sub_batch with IDs
                                )
                            except Exception as submit_err:
                                logger.error(
                                    "Task %s: Error submitting sub-batch: %s",
                                    self.task_id,
                                    submit_err,
                                )
                                failed_futures_count += 1
                        else:  # Sequential processing
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
                                    trip_idx_in_sub_batch,  # This is the index within the sub_batch_coords
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
                                            valid_new_segments,
                                        )
                                # Mark these trips as processed by worker
                                for trip_id_processed, _ in trip_sub_batch:
                                    if trip_id_processed not in processed_trip_ids_set:
                                        processed_trip_ids_set.add(trip_id_processed)
                                        self.processed_trips_count += 1
                                completed_futures_count += (
                                    1  # Represents one unit of worker task
                                )
                            except Exception as seq_err:
                                logger.error(
                                    "Task %s: Error during sequential processing: %s",
                                    self.task_id,
                                    seq_err,
                                )
                                failed_futures_count += 1

                if (
                    pending_futures_map
                    and len(pending_futures_map) > self.max_workers * 1.5
                ):
                    logger.debug(
                        "Task %s: Processing %d pending futures...",
                        self.task_id,
                        len(pending_futures_map),
                    )
                    try:
                        for future in list(
                            pending_futures_map.keys()
                        ):  # Iterate over a copy for safe removal
                            if future.done():
                                original_trip_sub_batch = pending_futures_map.pop(
                                    future, []
                                )
                                sub_batch_trip_ids = [
                                    tid for tid, _ in original_trip_sub_batch
                                ]
                                try:
                                    result_map = future.result(timeout=0.1)
                                    for (  # Iterate over results from worker
                                        _,  # trip_idx_in_sub_batch (relative to worker input)
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
                                                valid_new_segments,
                                            )
                                    # Mark these trips as processed by worker
                                    for trip_id_processed in sub_batch_trip_ids:
                                        if (
                                            trip_id_processed
                                            not in processed_trip_ids_set
                                        ):
                                            processed_trip_ids_set.add(
                                                trip_id_processed
                                            )
                                            self.processed_trips_count += 1
                                    completed_futures_count += 1

                                except FutureTimeoutError:
                                    logger.debug(
                                        "Task %s: Future result not ready, will check again later.",
                                        self.task_id,
                                    )
                                    pending_futures_map[future] = (
                                        original_trip_sub_batch  # Add back if not ready
                                    )
                                except CancelledError:
                                    logger.warning(
                                        "Task %s: Future was cancelled. NOT marking trips as processed.",
                                        self.task_id,
                                    )
                                    failed_futures_count += 1
                                except Exception as e:
                                    logger.error(
                                        "Task %s: Future failed: %s. NOT marking trips as processed.",
                                        self.task_id,
                                        type(e).__name__,
                                    )
                                    failed_futures_count += 1
                    except Exception as check_err:
                        logger.error(
                            "Task %s: Error checking completed futures: %s",
                            self.task_id,
                            check_err,
                        )

                now = datetime.now(timezone.utc)
                should_update_progress = (
                    (batch_num % PROGRESS_UPDATE_INTERVAL_TRIPS == 0)
                    or (processed_count_local >= self.total_trips_to_process)
                    or ((now - last_progress_update_time).total_seconds() > 20)
                )

                if should_update_progress:
                    progress_pct = 50 + (
                        (
                            self.processed_trips_count  # Use the count of uniquely processed trips
                            / self.total_trips_to_process
                            * 40
                        )
                        if self.total_trips_to_process > 0
                        else 40
                    )
                    progress_pct = min(progress_pct, 90.0)

                    new_segments_found_count = len(
                        self.newly_covered_segments - self.initial_covered_segments,
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
                    "Task %s: Waiting for %d remaining trip futures...",
                    self.task_id,
                    len(pending_futures_map),
                )
                original_futures_list = list(pending_futures_map.keys())
                wrapped_futures = [
                    asyncio.wrap_future(f) for f in original_futures_list
                ]

                try:
                    await asyncio.wait(
                        wrapped_futures,
                        timeout=WORKER_RESULT_WAIT_TIMEOUT_S,
                        return_when=asyncio.ALL_COMPLETED,
                    )

                    for future in original_futures_list:
                        original_trip_sub_batch = pending_futures_map.pop(
                            future,
                            None,
                        )
                        if not original_trip_sub_batch:
                            continue

                        sub_batch_trip_ids = [tid for tid, _ in original_trip_sub_batch]

                        if future.done():
                            try:
                                if future.cancelled():
                                    logger.warning(
                                        "Task %s: Final future processing cancelled. NOT marking trips.",
                                        self.task_id,
                                    )
                                    failed_futures_count += 1
                                else:
                                    result_map = future.result(
                                        timeout=0,
                                    )
                                    for (
                                        _,  # trip_idx_in_sub_batch
                                        matched_ids,
                                    ) in result_map.items():
                                        if isinstance(matched_ids, set):
                                            valid_new_segments = {
                                                seg_id
                                                for seg_id in matched_ids
                                                if seg_id in self.street_utm_geoms_cache
                                            }
                                            self.newly_covered_segments.update(
                                                valid_new_segments,
                                            )
                                    # Mark these trips as processed by worker
                                    for trip_id_processed in sub_batch_trip_ids:
                                        if (
                                            trip_id_processed
                                            not in processed_trip_ids_set
                                        ):
                                            processed_trip_ids_set.add(
                                                trip_id_processed
                                            )
                                            self.processed_trips_count += 1
                                    completed_futures_count += 1
                            except Exception as e:
                                logger.error(
                                    "Task %s: Final future processing error on done future: %s. NOT marking trips.",
                                    self.task_id,
                                    type(e).__name__,
                                )
                                failed_futures_count += 1
                        else:
                            logger.warning(
                                "Task %s: Timeout waiting for final future result. Attempting to cancel. NOT marking trips.",
                                self.task_id,
                            )
                            failed_futures_count += 1
                            try:
                                future.cancel()
                            except Exception as cancel_err:
                                logger.warning(
                                    "Task %s: Error cancelling timed-out future: %s",
                                    self.task_id,
                                    cancel_err,
                                )

                except TimeoutError:
                    logger.error(
                        "Task %s: asyncio.wait itself timed out unexpectedly. Handling remaining futures.",
                        self.task_id,
                    )
                    for future in original_futures_list:
                        if future in pending_futures_map:
                            pending_futures_map.pop(future, None)
                            logger.warning(
                                "Task %s: Future pending after asyncio.wait timeout. Attempting cancel. NOT marking trips.",
                                self.task_id,
                            )
                            failed_futures_count += 1
                            try:
                                future.cancel()
                            except Exception as cancel_err:
                                logger.warning(
                                    "Task %s: Error cancelling future after asyncio.wait timeout: %s",
                                    self.task_id,
                                    cancel_err,
                                )

                except Exception as wait_err:
                    logger.error(
                        "Task %s: Error during final asyncio.wait processing: %s. Handling remaining futures.",
                        self.task_id,
                        wait_err,
                    )
                    for future in original_futures_list:
                        if future in pending_futures_map:
                            pending_futures_map.pop(future, None)
                            logger.error(
                                "Task %s: Marking future as failed due to wait error. NOT marking trips.",
                                self.task_id,
                            )
                            failed_futures_count += 1
                            try:
                                if not future.done():
                                    future.cancel()
                            except Exception:
                                pass

            if pending_futures_map:
                logger.error(
                    "Task %s: pending_futures_map not empty after final processing! Keys: %s",
                    self.task_id,
                    list(pending_futures_map.keys()),
                )
                pending_futures_map.clear()

            final_new_segments = len(
                self.newly_covered_segments - self.initial_covered_segments,
            )
            logger.info(
                "Task %s: Finished trip processing stage for %s. "
                "DB Trips Checked (this run): %d. Total Trips in Filter: %d. "
                "Unique Trips Processed by Workers: %d. "
                "Submitted to Workers (sub-batches): %d. "
                "Failed/Timeout Futures: %d. "
                "Newly covered segments found (driveable+undriveable): %d.",
                self.task_id,
                self.location_name,
                processed_count_local,  # How many docs were iterated from DB
                self.total_trips_to_process,  # How many matched the initial filter
                self.processed_trips_count,  # How many unique trips were successfully processed by workers
                self.submitted_trips_count,  # How many sub-batches were sent to workers
                failed_futures_count,
                final_new_segments,
            )
            await self.update_progress(
                "processing_trips",
                90,
                f"Trip processing complete. Found {final_new_segments} new segments.",
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
        self,
        processed_trip_ids_set: set[str],
    ) -> dict[str, Any] | None:
        """Updates street 'driven' status in DB, calculates final stats, and updates
        metadata.
        """
        segments_to_update_in_db = set()
        newly_driven_count = 0
        for seg_id in self.newly_covered_segments:
            if seg_id not in self.initial_covered_segments:
                street_info = None
                for _, info in self.streets_lookup.items():
                    if info["segment_id"] == seg_id:
                        street_info = info
                        break
                if street_info and not street_info.get("undriveable", False):
                    segments_to_update_in_db.add(seg_id)
                    newly_driven_count += 1
                elif not street_info:
                    logger.warning(
                        "Task %s: Segment %s found by trip but not in streets_lookup during finalize.",
                        self.task_id,
                        seg_id,
                    )

        await self.update_progress(
            "finalizing",
            90,
            f"Updating {newly_driven_count:,} newly driven, driveable segments in database.",
        )

        if segments_to_update_in_db:
            logger.info(
                "Task %s: Updating 'driven' status for %d segments...",
                self.task_id,
                len(segments_to_update_in_db),
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
                            },
                        },
                    )
                    logger.info(
                        "Task %s: DB Update Batch %d: Matched=%d, Modified=%d",
                        self.task_id,
                        current_batch_num,
                        update_result.matched_count,
                        update_result.modified_count,
                    )
                    if update_result.modified_count != len(segment_batch):
                        logger.warning(
                            "Task %s: DB Update Batch %d modified count (%d) doesn't match expected (%d).",
                            self.task_id,
                            current_batch_num,
                            update_result.modified_count,
                            len(segment_batch),
                        )

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
                await self.update_progress(
                    "error",
                    90,
                    f"Error updating DB: {e}",
                )
        else:
            logger.info(
                "Task %s: No new driveable segments to mark as driven for %s.",
                self.task_id,
                self.location_name,
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
                },
            )

            final_driven_segment_ids = self.initial_covered_segments.union(
                segments_to_update_in_db,
            )

            for _, street_info in self.streets_lookup.items():
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
                    },
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
                "Task %s: Final stats: %.2f%% coverage (%.2fm / %.2fm driveable). %d/%d segments covered (driveable/total).",
                self.task_id,
                final_coverage_percentage,
                final_driven_length,
                final_driveable_length,
                final_covered_segments_count,
                final_total_segments,
            )

        except Exception as e:
            logger.error(
                "Task %s: Error calculating final stats: %s",
                self.task_id,
                e,
                exc_info=True,
            )
            await self.update_progress(
                "error",
                95,
                f"Error calculating stats: {e}",
            )
            return None

        logger.info(
            "Task %s: Updating coverage metadata for %s...",
            self.task_id,
            self.location_name,
        )
        try:
            trip_ids_list = list(processed_trip_ids_set)
            processed_trips_info = {
                "last_processed_timestamp": datetime.now(timezone.utc),
                "count_in_last_run": self.processed_trips_count,
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
                update_doc["$set"]["processed_trips"]["trip_ids"] = trip_ids_list
            else:
                logger.warning(
                    "Task %s: Processed trip ID list length (%d) exceeds MAX_TRIP_IDS_TO_STORE (%d). "
                    "Not storing full list in metadata, which will affect future incremental calculations (they will run as full).",
                    self.task_id,
                    len(trip_ids_list),
                    MAX_TRIP_IDS_TO_STORE,
                )
                # Explicitly do not set trip_ids if too large to avoid partial/misleading state for incremental.
                # This means next incremental will fetch no prior IDs and run as full.

            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": self.location_name},
                update_doc,
                upsert=True,
            )
            logger.info(
                "Task %s: Coverage metadata updated successfully for %s.",
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
        boundary_geojson_data: dict | None = None,
    ) -> dict[str, Any] | None:
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
        final_stats = None

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

            index_success = await self.build_spatial_index_and_stats(
                boundary_geojson_data=boundary_geojson_data
            )
            if not index_success:
                logger.error(
                    "Task %s: Failed during spatial index build for %s.",
                    self.task_id,
                    self.location_name,
                )
                return None
            if self.total_driveable_length == 0 and self.total_length_calculated > 0:
                logger.warning(
                    "Task %s: No driveable streets found for %s. Reporting 0%% coverage.",
                    self.task_id,
                    self.location_name,
                )
            elif self.total_length_calculated == 0:
                logger.info(
                    "Task %s: No streets found or indexed for %s. Finalizing with empty stats.",
                    self.task_id,
                    self.location_name,
                )
                processed_trip_ids_set: set[str] = set()
                final_stats = await self.finalize_coverage(
                    processed_trip_ids_set,
                )
                asyncio.create_task(
                    generate_and_store_geojson(
                        self.location_name,
                        self.task_id,
                    ),
                )
                return final_stats

            processed_trip_ids_set = set()
            if run_incremental:
                logger.info(
                    "Task %s: Incremental run requested. Loading previous state.",
                    self.task_id,
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
                                ),
                            )
                            logger.info(
                                "Task %s: Loaded %d previously processed trip IDs for incremental run.",
                                self.task_id,
                                len(processed_trip_ids_set),
                            )
                        else:
                            logger.warning(
                                "Task %s: 'trip_ids' field has unexpected type %s. Running as full.",
                                self.task_id,
                                type(trip_ids_data).__name__,
                            )
                            run_incremental = False
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
                    "Task %s: Finalization failed for %s.",
                    self.task_id,
                    self.location_name,
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
                        },
                    },
                    upsert=False,
                )
                return None

            if calculation_error:
                final_stats["status"] = "error"
                final_stats["last_error"] = calculation_error
                logger.warning(
                    "Task %s: Calculation completed with error: %s",
                    self.task_id,
                    calculation_error,
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
                        },
                    },
                    upsert=False,
                )

            if not calculation_error and final_stats is not None:
                logger.info(
                    "Task %s: Triggering background GeoJSON generation.",
                    self.task_id,
                )
                asyncio.create_task(
                    generate_and_store_geojson(
                        self.location_name,
                        self.task_id,
                    ),
                )
            elif calculation_error:
                logger.warning(
                    "Task %s: Skipping GeoJSON generation due to prior error: %s.",
                    self.task_id,
                    calculation_error,
                )
            else:
                logger.error(
                    "Task %s: Skipping GeoJSON generation due to finalization failure.",
                    self.task_id,
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
                        },
                    },
                    upsert=True,
                )
            except Exception as db_err:
                logger.error(
                    "Task %s: Failed to update error status after unhandled exception: %s",
                    self.task_id,
                    db_err,
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
                        "Task %s: Error closing R-tree index: %s",
                        self.task_id,
                        rtree_close_err,
                    )
                self.streets_index = None
            logger.debug(
                "Task %s: Cleanup completed for %s.",
                self.task_id,
                self.location_name,
            )


async def compute_coverage_for_location(
    location: dict[str, Any],
    task_id: str,
    fetch_boundary_for_clipping: bool = True,
) -> dict[str, Any] | None:
    """Entry point for a full coverage calculation."""
    location_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Task %s: Received request for FULL coverage calculation for %s",
        task_id,
        location_name,
    )
    calculator = None
    boundary_data_for_calc = None
    try:
        await ensure_street_coverage_indexes()

        if fetch_boundary_for_clipping:
            logger.info(
                "Task %s: Attempting to fetch boundary GeoJSON for %s to aid clipping in calculator.",
                task_id,
                location_name,
            )
            # We need the raw GeoJSON polygon data from the location object if it was pre-fetched,
            # or fetch it if not. The location dict passed to compute_coverage_for_location
            # should ideally already contain the 'geojson' field from validate_location_osm.
            if "geojson" in location and location["geojson"]:
                boundary_data_for_calc = location["geojson"]
                logger.info(
                    "Task %s: Using pre-existing GeoJSON boundary from location object for %s.",
                    task_id,
                    location_name,
                )
            else:
                # Fallback to fetch if not present, though preprocess_streets should have added it.
                # This might be redundant if preprocess_streets always runs and adds it.
                boundary_geojson, err = await generate_geojson_osm(
                    location, streets_only=False
                )
                if err:
                    logger.warning(
                        "Task %s: Could not fetch boundary GeoJSON for %s for calculator clipping: %s. Proceeding without it.",
                        task_id,
                        location_name,
                        err,
                    )
                elif boundary_geojson:
                    boundary_data_for_calc = (
                        boundary_geojson  # This will be the full FeatureCollection
                    )
                    logger.info(
                        "Task %s: Fetched boundary GeoJSON for %s for calculator clipping.",
                        task_id,
                        location_name,
                    )

        calculator = CoverageCalculator(location, task_id)

        result = await asyncio.wait_for(
            calculator.compute_coverage(
                run_incremental=False,
                boundary_geojson_data=boundary_data_for_calc,
            ),
            timeout=PROCESS_TIMEOUT_OVERALL,
        )

        if result is None:
            logger.error(
                "Task %s: Full coverage calculation returned None for %s",
                task_id,
                location_name,
            )
        elif result.get("status") == "error":
            logger.error(
                "Task %s: Full coverage calculation completed with error for %s: %s",
                task_id,
                location_name,
                result.get("last_error"),
            )
        else:
            logger.info(
                "Task %s: Full coverage calculation stats phase complete for %s. GeoJSON generation may be ongoing.",
                task_id,
                location_name,
            )

        return result

    except TimeoutError:
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
                },
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
                },
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
                },
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
                },
            },
            upsert=True,
        )
        return None


async def compute_incremental_coverage(
    location: dict[str, Any],
    task_id: str,
    fetch_boundary_for_clipping: bool = True,
) -> dict[str, Any] | None:
    """Entry point for an incremental coverage calculation."""
    location_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Task %s: Received request for INCREMENTAL coverage update for %s",
        task_id,
        location_name,
    )
    calculator = None
    boundary_data_for_calc = None
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
            return await compute_coverage_for_location(
                location,
                task_id,
                fetch_boundary_for_clipping=fetch_boundary_for_clipping,
            )

        if fetch_boundary_for_clipping:
            logger.info(
                "Task %s: Attempting to fetch boundary GeoJSON for %s for incremental calculator clipping.",
                task_id,
                location_name,
            )
            if "geojson" in location and location["geojson"]:
                boundary_data_for_calc = location["geojson"]
                logger.info(
                    "Task %s: Using pre-existing GeoJSON boundary from location object for incremental %s.",
                    task_id,
                    location_name,
                )
            else:
                boundary_geojson, err = await generate_geojson_osm(
                    location, streets_only=False
                )
                if err:
                    logger.warning(
                        "Task %s: Could not fetch boundary GeoJSON for incremental %s for calculator clipping: %s. Proceeding without it.",
                        task_id,
                        location_name,
                        err,
                    )
                elif boundary_geojson:
                    boundary_data_for_calc = boundary_geojson
                    logger.info(
                        "Task %s: Fetched boundary GeoJSON for incremental %s for calculator clipping.",
                        task_id,
                        location_name,
                    )

        calculator = CoverageCalculator(location, task_id)
        result = await asyncio.wait_for(
            calculator.compute_coverage(
                run_incremental=True,
                boundary_geojson_data=boundary_data_for_calc,
            ),
            timeout=PROCESS_TIMEOUT_INCREMENTAL,
        )

        if result is None:
            logger.error(
                "Task %s: Incremental coverage calculation returned None for %s",
                task_id,
                location_name,
            )
        elif result.get("status") == "error":
            logger.error(
                "Task %s: Incremental coverage calculation completed with error for %s: %s",
                task_id,
                location_name,
                result.get("last_error"),
            )
        else:
            logger.info(
                "Task %s: Incremental coverage stats phase complete for %s. GeoJSON generation may be ongoing.",
                task_id,
                location_name,
            )

        return result

    except TimeoutError:
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
                },
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
                },
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
                },
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
                },
            },
            upsert=False,
        )
        return None


async def generate_and_store_geojson(
    location_name: str | None,
    task_id: str,
) -> None:
    """Generates a GeoJSON FeatureCollection of streets and stores it in GridFS.

    Includes driven status and summary statistics in the GeoJSON metadata.
    Deletes any pre-existing GridFS file for the same location first.
    """
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
                },
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
            },
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
    streets_cursor = None

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
                    "Task %s: Attempting to delete old GridFS file %s for %s.",
                    task_id,
                    old_gridfs_id,
                    location_name,
                )
                await fs.delete(old_gridfs_id)
                logger.info(
                    "Task %s: Deleted old GridFS file %s.",
                    task_id,
                    old_gridfs_id,
                )
            except Exception as del_err:
                logger.warning(
                    "Task %s: Failed to delete old GridFS file %s (might not exist): %s",
                    task_id,
                    old_gridfs_id,
                    del_err,
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

        await upload_stream.write(
            b'{"type": "FeatureCollection", "features": [\n',
        )

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
                "properties.street_name": 1,
                "properties.maxspeed": 1,
            },
        ).batch_size(1000)

        first_feature = True
        async for street_batch in batch_cursor(streets_cursor, 1000):
            features_to_write = []
            for street in street_batch:
                if "geometry" not in street or not street.get(
                    "properties",
                    {},
                ).get("segment_id"):
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
            f'\n], "metadata": {metadata_json}\n}}'.encode(),
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
                "Task %s: Updating metadata for '%s' with GridFS ID: %s",
                task_id,
                location_name,
                file_id,
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
                            "message": f"Coverage analysis complete. Map data generated ({total_features:,} streets).",
                            "status": "complete",
                            "updated_at": datetime.now(timezone.utc),
                        },
                    },
                    upsert=True,
                )
            else:
                error_msg = (
                    "GeoJSON stored in GridFS, but failed to update metadata link."
                )
                logger.error(
                    "Task %s: %s (Matched: %d, Modified: %d)",
                    task_id,
                    error_msg,
                    update_result.matched_count,
                    update_result.modified_count,
                )
                await progress_collection.update_one(
                    {"_id": task_id},
                    {
                        "$set": {
                            "stage": "error",
                            "message": error_msg,
                            "error": "Metadata Link Failure",
                            "status": "error",
                        },
                    },
                    upsert=True,
                )
                try:
                    await fs.delete(file_id)
                except Exception:
                    logger.warning(
                        "Task %s: Failed to delete orphaned GridFS file %s after metadata link failure.",
                        task_id,
                        file_id,
                    )
        else:
            error_msg = "GridFS stream closed successfully but file_id is missing."
            logger.error(
                "Task %s: %s for %s",
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
                        "error": "GridFS ID Missing",
                        "status": "error",
                    },
                },
                upsert=True,
            )

    except Exception as e:
        error_msg = f"Error during GeoJSON generation/storage: {e}"
        logger.error(
            "Task %s: %s",
            task_id,
            error_msg,
            exc_info=True,
        )
        if upload_stream and not upload_stream.closed:
            try:
                await upload_stream.abort()
                logger.info(
                    "Task %s: Aborted GridFS upload stream for %s due to error.",
                    task_id,
                    location_name,
                )
            except Exception as abort_err:
                logger.error(
                    "Task %s: Error aborting GridFS stream: %s",
                    task_id,
                    abort_err,
                )
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "message": error_msg[:500],
                    "error": str(e)[:200],
                    "status": "error",
                },
            },
            upsert=True,
        )
        await coverage_metadata_collection.update_one(
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"GeoJSON Generation Failed: {str(e)[:200]}",
                },
            },
            upsert=False,
        )

    finally:
        if streets_cursor and hasattr(streets_cursor, "close"):
            try:
                await streets_cursor.close()
            except Exception as cur_close_err:
                logger.warning(
                    "Task %s: Error closing streets cursor for GeoJSON: %s",
                    task_id,
                    cur_close_err,
                )
        logger.debug("Task %s: GeoJSON generation function finished.", task_id)
