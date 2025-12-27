"""Street coverage calculation module.

Calculates street segment coverage based on trip data using MongoDB native
geospatial queries ($geoIntersects) instead of in-memory R-trees.
Stores large GeoJSON results in GridFS.
"""

import asyncio
import contextlib
import logging
from collections import defaultdict
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import bson.json_util
from bson import ObjectId
from dotenv import load_dotenv
from shapely.geometry import mapping, shape

if TYPE_CHECKING:
    from motor.motor_asyncio import AsyncIOMotorGridFSBucket

from db import (
    batch_cursor,
    count_documents_with_retry,
    coverage_metadata_collection,
    db_manager,
    find_one_with_retry,
    progress_collection,
    streets_collection,
    trips_collection,
    update_many_with_retry,
    update_one_with_retry,
)
from models import validate_geojson_point_or_linestring

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

MAX_TRIPS_PER_BATCH = 500
BATCH_PROCESS_DELAY = 0.01

DEFAULT_MATCH_BUFFER_METERS = 15.0
DEFAULT_MIN_MATCH_LENGTH_METERS = 5.0


class CoverageCalculator:
    """Handles the calculation of street coverage for a specific location using DB-side geospatial operations."""

    def __init__(
        self,
        location: dict[str, Any],
        task_id: str,
    ) -> None:
        self.location = location
        self.location_name = location.get("display_name", "Unknown Location")
        self.task_id = task_id

        raw_match_buffer = location.get("match_buffer_meters")
        self.match_buffer: float = float(
            raw_match_buffer
            if raw_match_buffer is not None
            else DEFAULT_MATCH_BUFFER_METERS
        )

        self.trip_batch_size: int = MAX_TRIPS_PER_BATCH

        # Stats tracking
        self.total_driveable_length: float = 0.0
        self.initial_driven_length: float = 0.0
        self.initial_covered_segments_count: int = 0
        self.newly_covered_segments_count: int = 0
        self.total_trips_to_process: int = 0
        self.processed_trips_count: int = 0

        # Sets to track coverage during this run
        self.initial_covered_segments: set[str] = set()
        self.newly_covered_segments: set[str] = set()

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
            # Approximation for progress updates - real stats calculated at end via Aggregation
            coverage_pct = (
                (current_covered_length / self.total_driveable_length * 100)
                if self.total_driveable_length > 0
                else 0.0
            )

            enhanced_metrics = {
                "total_trips_to_process": self.total_trips_to_process,
                "processed_trips": self.processed_trips_count,
                "driveable_length_mi": round(
                    self.total_driveable_length * 0.000621371, 2
                ),
                "covered_length_mi": round(current_covered_length * 0.000621371, 2),
                "coverage_percentage": round(coverage_pct, 2),
                "initial_covered_segments": self.initial_covered_segments_count,
                "newly_covered_segments": len(self.newly_covered_segments),
            }

            update_data = {
                "stage": stage,
                "progress": round(progress, 2),
                "message": message,
                "updated_at": datetime.now(UTC),
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

    async def calculate_initial_stats(self) -> bool:
        """Calculates initial statistics using MongoDB aggregation."""
        logger.info(
            "Task %s: Calculating initial stats for %s...",
            self.task_id,
            self.location_name,
        )
        await self.update_progress(
            "indexing",
            10,
            f"Calculating initial stats for {self.location_name}",
        )

        try:
            pipeline = [
                {"$match": {"properties.location": self.location_name}},
                {
                    "$group": {
                        "_id": None,
                        "total_length": {"$sum": "$properties.segment_length"},
                        "driveable_length": {
                            "$sum": {
                                "$cond": [
                                    {"$eq": ["$properties.undriveable", True]},
                                    0,
                                    "$properties.segment_length",
                                ]
                            }
                        },
                        "driven_length": {
                            "$sum": {
                                "$cond": [
                                    {
                                        "$and": [
                                            {"$eq": ["$properties.driven", True]},
                                            {"$ne": ["$properties.undriveable", True]},
                                        ]
                                    },
                                    "$properties.segment_length",
                                    0,
                                ]
                            }
                        },
                        "total_segments": {"$sum": 1},
                        "covered_segments": {
                            "$sum": {
                                "$cond": [
                                    {"$eq": ["$properties.driven", True]},
                                    1,
                                    0,
                                ]
                            }
                        },
                        "driven_ids": {
                            "$push": {
                                "$cond": [
                                    {"$eq": ["$properties.driven", True]},
                                    "$properties.segment_id",
                                    "$$REMOVE",
                                ]
                            }
                        },
                    }
                },
            ]

            cursor = streets_collection.aggregate(pipeline)
            result = await cursor.to_list(length=1)

            if result:
                stats = result[0]
                self.total_driveable_length = stats.get("driveable_length", 0.0)
                self.initial_driven_length = stats.get("driven_length", 0.0)
                self.initial_covered_segments_count = stats.get("covered_segments", 0)
                self.initial_covered_segments = set(stats.get("driven_ids", []))
                total_segments = stats.get("total_segments", 0)

                logger.info(
                    "Task %s: Stats for %s: Driveable=%.2fmi, Driven=%.2fmi, Segments=%d",
                    self.task_id,
                    self.location_name,
                    self.total_driveable_length * 0.000621371,
                    self.initial_driven_length * 0.000621371,
                    total_segments,
                )
            else:
                logger.warning(
                    "Task %s: No streets found for %s during stats calculation.",
                    self.task_id,
                    self.location_name,
                )

            return True

        except Exception as e:
            logger.error(
                "Task %s: Error calculating stats: %s",
                self.task_id,
                e,
                exc_info=True,
            )
            await self.update_progress(
                "error",
                0,
                f"Stats calculation error: {e}",
            )
            return False

    @staticmethod
    def _is_valid_trip(
        gps_data: dict[str, Any] | None,
    ) -> tuple[bool, list[list[float]]]:
        """Validates if the GPS data is suitable for coverage calculation."""
        if not gps_data or not isinstance(gps_data, dict):
            return False, []

        is_valid, validated_geojson = validate_geojson_point_or_linestring(gps_data)

        if not is_valid or validated_geojson is None:
            return False, []

        geom_type = validated_geojson.get("type")
        coordinates = validated_geojson.get("coordinates")

        if geom_type == "Point":
            return True, [coordinates, coordinates]
        if geom_type == "LineString":
            return True, coordinates

        return False, []

    async def _find_intersecting_streets(self, trip_geometry: dict) -> list[str]:
        """Helper to find undriven streets intersecting a trip geometry using MongoDB."""
        try:
            # 1. Convert GeoJSON to Shapely
            trip_shape = shape(trip_geometry)

            # 2. Handle buffering (Degrees vs Meters)
            # Simple approximation: 1 degree ~ 111,000 meters
            # For high precision, use the UTM projection logic you had before.
            # For coverage "close enough" logic, a simple degree buffer works:
            buffer_degrees = self.match_buffer / 111139.0

            # Buffer the line to create a polygon "swath"
            query_polygon = trip_shape.buffer(buffer_degrees)

            # 3. Convert back to GeoJSON
            query_geometry = mapping(query_polygon)

            # 4. Query MongoDB
            cursor = streets_collection.find(
                {
                    "properties.location": self.location_name,
                    "properties.driven": False,
                    "geometry": {"$geoIntersects": {"$geometry": query_geometry}},
                },
                {"properties.segment_id": 1},
            )

            segments = await cursor.to_list(length=None)
            return [doc["properties"]["segment_id"] for doc in segments]
        except Exception as e:
            logger.error(f"Geospatial query failed for task {self.task_id}: {e}")
            return []

    async def process_trips(self, processed_trip_ids_set: set[str]) -> bool:
        """Processes trips to find newly covered street segments using MongoDB geospatial queries."""
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
            "invalid": {"$ne": True},
        }

        # Filter by location bounding box if available
        bbox = self.location.get("boundingbox")
        if bbox and len(bbox) == 4:
            try:
                min_lat, max_lat, min_lon, max_lon = map(float, bbox)
                if -90 <= min_lat <= 90 and -180 <= min_lon <= 180:
                    bbox_polygon = {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [min_lon, min_lat],
                                [max_lon, min_lat],
                                [max_lon, max_lat],
                                [min_lon, max_lat],
                                [min_lon, min_lat],
                            ]
                        ],
                    }
                    base_trip_filter["gps"] = {
                        "$geoIntersects": {"$geometry": bbox_polygon}
                    }
            except (ValueError, TypeError):
                logger.warning("Invalid bbox, processing all trips")

        # Exclude already processed trips
        processed_object_ids = [
            ObjectId(tid) for tid in processed_trip_ids_set if ObjectId.is_valid(tid)
        ]
        if processed_object_ids:
            base_trip_filter["_id"] = {"$nin": processed_object_ids}

        try:
            self.total_trips_to_process = await count_documents_with_retry(
                trips_collection,
                base_trip_filter,
            )
            logger.info(
                f"Task {self.task_id}: Found {self.total_trips_to_process} trips to process."
            )
        except Exception as e:
            logger.error(f"Task {self.task_id}: Error counting trips: {e}")
            return False

        if self.total_trips_to_process == 0:
            return True

        trips_cursor = trips_collection.find(
            base_trip_filter,
            {"gps": 1, "_id": 1},
        ).batch_size(self.trip_batch_size)

        self.newly_covered_segments = set()
        processed_count = 0

        async for trip_batch in batch_cursor(trips_cursor, self.trip_batch_size):
            tasks = []

            for trip_doc in trip_batch:
                trip_id = str(trip_doc["_id"])
                if trip_id in processed_trip_ids_set:
                    continue

                is_valid, coords = self._is_valid_trip(trip_doc.get("gps"))
                if not is_valid or not coords:
                    processed_trip_ids_set.add(trip_id)
                    processed_count += 1
                    continue

                # Create the task to query streets for this specific trip
                tasks.append(self._find_intersecting_streets(trip_doc.get("gps")))
                processed_trip_ids_set.add(trip_id)

            # Execute batch of geospatial queries concurrently
            if tasks:
                results = await asyncio.gather(*tasks, return_exceptions=True)

                for res in results:
                    if isinstance(res, list):
                        self.newly_covered_segments.update(res)
                    elif isinstance(res, Exception):
                        logger.error(f"Error querying intersections: {res}")

                processed_count += len(tasks)
                self.processed_trips_count = processed_count

                # Update Progress
                progress_pct = 50 + (processed_count / self.total_trips_to_process * 40)
                await self.update_progress(
                    "processing_trips",
                    progress_pct,
                    f"Processed {processed_count}/{self.total_trips_to_process} trips. Found {len(self.newly_covered_segments)} segments.",
                )

        return True

    async def finalize_coverage(
        self,
        processed_trip_ids_set: set[str],
    ) -> dict[str, Any] | None:
        """Updates street 'driven' status in DB, calculates final stats via Aggregation."""

        # 1. Identify segments that are truly new (not in initial set)
        segments_to_update_in_db = list(
            self.newly_covered_segments - self.initial_covered_segments
        )
        newly_driven_count = len(segments_to_update_in_db)

        await self.update_progress(
            "finalizing",
            90,
            f"Updating {newly_driven_count:,} newly driven segments in database.",
        )

        # 2. Bulk update MongoDB
        if segments_to_update_in_db:
            update_timestamp = datetime.now(UTC)
            try:
                max_update_batch = 10000
                for i in range(0, len(segments_to_update_in_db), max_update_batch):
                    segment_batch = segments_to_update_in_db[i : i + max_update_batch]

                    await update_many_with_retry(
                        streets_collection,
                        {"properties.segment_id": {"$in": segment_batch}},
                        {
                            "$set": {
                                "properties.driven": True,
                                "properties.last_coverage_update": update_timestamp,
                            },
                        },
                    )
                    await asyncio.sleep(BATCH_PROCESS_DELAY)
            except Exception as e:
                logger.error(f"Task {self.task_id}: Error updating DB: {e}")
                await self.update_progress("error", 90, f"Error updating DB: {e}")

        # 3. Calculate Final Stats via Aggregation (Source of Truth)
        await self.update_progress(
            "finalizing",
            95,
            f"Calculating final coverage statistics for {self.location_name}",
        )

        try:
            pipeline = [
                {"$match": {"properties.location": self.location_name}},
                {
                    "$group": {
                        "_id": None,
                        "total_length": {"$sum": "$properties.segment_length"},
                        "driveable_length": {
                            "$sum": {
                                "$cond": [
                                    {"$eq": ["$properties.undriveable", True]},
                                    0,
                                    "$properties.segment_length",
                                ]
                            }
                        },
                        "driven_length": {
                            "$sum": {
                                "$cond": [
                                    {"$eq": ["$properties.driven", True]},
                                    "$properties.segment_length",
                                    0,
                                ]
                            }
                        },
                        "total_segments": {"$sum": 1},
                        "covered_segments": {
                            "$sum": {
                                "$cond": [
                                    {"$eq": ["$properties.driven", True]},
                                    1,
                                    0,
                                ]
                            }
                        },
                        # Breakdown by street type
                        "street_types_data": {
                            "$push": {
                                "type": "$properties.highway",
                                "length": "$properties.segment_length",
                                "driven": "$properties.driven",
                                "undriveable": "$properties.undriveable",
                            }
                        },
                    }
                },
            ]

            result = await streets_collection.aggregate(pipeline).to_list(1)

            if not result:
                logger.error(
                    f"Task {self.task_id}: Final stats aggregation returned empty."
                )
                return None

            stats = result[0]

            # Process street types breakdown in Python
            type_map = defaultdict(
                lambda: {
                    "total": 0,
                    "covered": 0,
                    "length": 0.0,
                    "covered_length": 0.0,
                    "undriveable_length": 0.0,
                }
            )

            for item in stats.get("street_types_data", []):
                t = item.get("type", "unknown")
                length = item.get("length", 0.0)
                driven = item.get("driven", False)
                undriveable = item.get("undriveable", False)

                type_map[t]["total"] += 1
                type_map[t]["length"] += length
                if undriveable:
                    type_map[t]["undriveable_length"] += length
                elif driven:
                    type_map[t]["covered"] += 1
                    type_map[t]["covered_length"] += length

            final_street_types = []
            for t, data in type_map.items():
                driveable_len = data["length"] - data["undriveable_length"]
                pct = (
                    (data["covered_length"] / driveable_len * 100)
                    if driveable_len > 0
                    else 0
                )

                final_street_types.append(
                    {
                        "type": t,
                        "total_segments": data["total"],
                        "covered_segments": data["covered"],
                        "total_length_m": round(data["length"], 2),
                        "covered_length_m": round(data["covered_length"], 2),
                        "driveable_length_m": round(driveable_len, 2),
                        "undriveable_length_m": round(data["undriveable_length"], 2),
                        "coverage_percentage": round(pct, 2),
                    }
                )

            final_street_types.sort(key=lambda x: x["total_length_m"], reverse=True)

            coverage_stats = {
                "total_length_m": round(stats.get("total_length", 0), 2),
                "driven_length_m": round(stats.get("driven_length", 0), 2),
                "driveable_length_m": round(stats.get("driveable_length", 0), 2),
                "coverage_percentage": round(
                    (
                        (
                            stats.get("driven_length", 0)
                            / stats.get("driveable_length", 1)
                            * 100
                        )
                        if stats.get("driveable_length", 0) > 0
                        else 0
                    ),
                    2,
                ),
                "total_segments": stats.get("total_segments", 0),
                "covered_segments": stats.get("covered_segments", 0),
                "street_types": final_street_types,
            }

        except Exception as e:
            logger.error(f"Task {self.task_id}: Error calculating final stats: {e}")
            await self.update_progress("error", 95, f"Error calculating stats: {e}")
            return None

        # 4. Update Metadata
        logger.info(
            f"Task {self.task_id}: Updating coverage metadata for {self.location_name}..."
        )
        try:
            trip_ids_list = list(processed_trip_ids_set)
            processed_trips_info = {
                "last_processed_timestamp": datetime.now(UTC),
                "count_in_last_run": self.processed_trips_count,
            }

            update_doc = {
                "$set": {
                    **coverage_stats,
                    "last_updated": datetime.now(UTC),
                    "status": "completed_stats",
                    "last_error": None,
                    "processed_trips": processed_trips_info,
                    "needs_stats_update": False,
                    "last_stats_update": datetime.now(UTC),
                },
            }

            MAX_TRIP_IDS_TO_STORE = 50000
            if len(trip_ids_list) <= MAX_TRIP_IDS_TO_STORE:
                update_doc["$set"]["processed_trips"]["trip_ids"] = trip_ids_list
            else:
                logger.warning(
                    "Task %s: Trip ID list too large (%d). Skipping storage in metadata.",
                    self.task_id,
                    len(trip_ids_list),
                )

            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": self.location_name},
                update_doc,
                upsert=True,
            )

        except Exception as e:
            logger.error(f"Task {self.task_id}: Error updating metadata: {e}")
            await self.update_progress("error", 97, f"Failed to update metadata: {e}")

        final_result = {
            **coverage_stats,
            "run_details": {
                "newly_covered_segment_count": newly_driven_count,
                "total_processed_trips_in_run": self.processed_trips_count,
            },
        }

        await self.update_progress(
            "complete_stats",
            98,
            "Coverage statistics calculation complete.",
        )
        return final_result

    async def compute_coverage(
        self,
        run_incremental: bool = False,
    ) -> dict[str, Any] | None:
        """Main orchestration method for the coverage calculation process."""
        start_time = datetime.now(UTC)
        run_type = "incremental" if run_incremental else "full"
        logger.info(
            f"Task {self.task_id}: Starting {run_type} coverage for {self.location_name}"
        )

        try:
            await self.update_progress(
                "initializing", 0, f"Initializing {run_type} calculation..."
            )

            # Calculate initial stats
            stats_success = await self.calculate_initial_stats()
            if not stats_success:
                return None

            # Load previous state if incremental
            processed_trip_ids_set = set()
            if run_incremental:
                try:
                    metadata = await find_one_with_retry(
                        coverage_metadata_collection,
                        {"location.display_name": self.location_name},
                        {"processed_trips.trip_ids": 1},
                    )
                    if metadata and "processed_trips" in metadata:
                        ids = metadata["processed_trips"].get("trip_ids", [])
                        if isinstance(ids, list):
                            processed_trip_ids_set = set(map(str, ids))
                except Exception as e:
                    logger.warning(
                        f"Failed to load previous trip IDs: {e}. Running full."
                    )

            # Process Trips
            trips_success = await self.process_trips(processed_trip_ids_set)
            if not trips_success:
                logger.error(f"Task {self.task_id}: Trip processing failed.")
                return None

            # Finalize
            final_stats = await self.finalize_coverage(processed_trip_ids_set)

            if final_stats:
                # Trigger GeoJSON generation in background
                asyncio.create_task(
                    generate_and_store_geojson(self.location_name, self.task_id)
                )

            duration = (datetime.now(UTC) - start_time).total_seconds()
            logger.info(f"Task {self.task_id}: Finished in {duration:.2f}s")

            return final_stats

        except Exception as e:
            logger.exception(f"Task {self.task_id}: Unhandled error: {e}")
            await self.update_progress("error", 0, f"Unhandled error: {e}")
            return None


async def compute_coverage_for_location(
    location: dict[str, Any],
    task_id: str,
) -> dict[str, Any] | None:
    """Entry point for a full coverage calculation."""
    calculator = CoverageCalculator(location, task_id)
    return await calculator.compute_coverage(run_incremental=False)


async def compute_incremental_coverage(
    location: dict[str, Any],
    task_id: str,
) -> dict[str, Any] | None:
    """Entry point for an incremental coverage calculation."""
    calculator = CoverageCalculator(location, task_id)
    return await calculator.compute_coverage(run_incremental=True)


async def generate_and_store_geojson(
    location_name: str | None,
    task_id: str,
) -> None:
    """Generates a GeoJSON FeatureCollection of streets and stores it in GridFS."""
    if not location_name:
        return

    logger.info(f"Task {task_id}: Generating GeoJSON for {location_name}...")
    await progress_collection.update_one(
        {"_id": task_id},
        {"$set": {"stage": "generating_geojson", "message": "Creating map data..."}},
        upsert=True,
    )

    fs: AsyncIOMotorGridFSBucket = db_manager.gridfs_bucket
    safe_name = "".join(
        (c if c.isalnum() or c in ["_", "-"] else "_") for c in location_name
    )
    filename = f"{safe_name}_streets.geojson"

    try:
        # Cleanup old file
        existing_meta = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {"streets_geojson_gridfs_id": 1},
        )
        if existing_meta and existing_meta.get("streets_geojson_gridfs_id"):
            with contextlib.suppress(Exception):
                await fs.delete(existing_meta["streets_geojson_gridfs_id"])

        # Stream new file
        upload_stream = fs.open_upload_stream(
            filename,
            metadata={
                "contentType": "application/json",
                "location": location_name,
                "task_id": task_id,
                "generated_at": datetime.now(UTC),
            },
        )

        await upload_stream.write(b'{"type": "FeatureCollection", "features": [\n')

        cursor = streets_collection.find(
            {"properties.location": location_name},
            {"_id": 0, "geometry": 1, "properties": 1},
        )

        first = True
        async for batch in batch_cursor(cursor, 1000):
            chunk = []
            for street in batch:
                if "geometry" not in street:
                    continue

                feature = {
                    "type": "Feature",
                    "geometry": street["geometry"],
                    "properties": street.get("properties", {}),
                }
                json_str = bson.json_util.dumps(feature)
                prefix = b"" if first else b",\n"
                chunk.append(prefix + json_str.encode("utf-8"))
                first = False

            if chunk:
                await upload_stream.write(b"".join(chunk))

        # Close JSON
        await upload_stream.write(b"\n]}")
        await upload_stream.close()

        # Update Metadata with final "completed" status
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "streets_geojson_gridfs_id": upload_stream._id,
                    "last_geojson_update": datetime.now(UTC),
                    "status": "completed",
                    "last_updated": datetime.now(UTC),
                }
            },
        )

        await progress_collection.update_one(
            {"_id": task_id},
            {"$set": {"stage": "complete", "progress": 100, "status": "complete"}},
        )
        logger.info(f"Task {task_id}: GeoJSON generation complete.")

    except Exception as e:
        logger.error(f"Task {task_id}: GeoJSON generation failed: {e}")
        if upload_stream:
            await upload_stream.abort()

        # Update task status to error so frontend stops polling
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "status": "error",
                    "error": f"GeoJSON generation failed: {str(e)}",
                }
            },
        )

        # Also update coverage_metadata_collection so the table reflects the error
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"GeoJSON generation failed: {str(e)[:200]}",
                    "last_updated": datetime.now(UTC),
                }
            },
        )
