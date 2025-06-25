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
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from typing import Any

import numpy as np
import pyproj
import rtree
from dotenv import load_dotenv
from shapely.errors import GEOSException
from shapely.geometry import LineString, mapping, shape
from shapely.ops import transform, unary_union

from db import (
    batch_cursor,
    count_documents_with_retry,
    progress_collection,
    streets_collection,
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
                    logger.debug(
                        "Invalid coordinate pair in LineString: %s", coord_pair
                    )
                    return (
                        False,
                        [],
                    )  # Strict: entire LineString invalid if one point is bad
