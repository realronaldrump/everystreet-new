"""Coverage calculator module.

Calculates street segment coverage based on trip data using MongoDB native
geospatial queries ($geoIntersects) instead of in-memory R-trees.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from shapely.geometry import mapping, shape

from coverage.constants import (
    BATCH_PROCESS_DELAY,
    DEFAULT_MATCH_BUFFER_METERS,
    DEFAULT_MIN_MATCH_LENGTH_METERS,
    DEGREES_TO_METERS,
    FEET_TO_METERS,
    MAX_TRIP_IDS_TO_STORE,
    MAX_TRIPS_PER_BATCH,
    MAX_UPDATE_BATCH_SIZE,
    METERS_TO_MILES,
)
from db.models import CoverageMetadata, ProgressStatus, Street, Trip
from geometry_service import GeometryService

logger = logging.getLogger(__name__)


class CoverageCalculator:
    """Handles the calculation of street coverage for a specific location.

    Uses MongoDB-side geospatial operations for efficient coverage matching.
    """

    def __init__(
        self,
        location: dict[str, Any],
        task_id: str,
    ) -> None:
        """Initialize the coverage calculator.

        Args:
            location: Dictionary with location data (display_name, osm_id, etc.)
            task_id: Unique identifier for tracking this calculation task
        """
        self.location = location
        self.location_name = location.get("display_name", "Unknown Location")
        self.task_id = task_id

        # Buffer configuration
        self.match_buffer: float = self._get_match_buffer(location)
        self.min_match_length: float = self._get_min_match_length(location)
        self.trip_batch_size: int = MAX_TRIPS_PER_BATCH

        # Stats tracking
        self.total_driveable_length: float = 0.0
        self.initial_driven_length: float = 0.0
        self.initial_covered_segments_count: int = 0
        self.newly_covered_segments_count: int = 0
        self.total_trips_to_process: int = 0
        self.processed_trips_count: int = 0

        # Error tracking for rate-limited logging
        self._geospatial_error_count: int = 0
        self._geospatial_error_sample: str = ""

        # Sets to track coverage during this run
        self.initial_covered_segments: set[str] = set()
        self.newly_covered_segments: set[str] = set()

    @staticmethod
    def _get_match_buffer(location: dict[str, Any]) -> float:
        """Get match buffer distance in meters from location settings.

        Args:
            location: Location dictionary

        Returns:
            Match buffer distance in meters
        """
        if location.get("match_buffer_feet") is not None:
            return float(location["match_buffer_feet"]) * FEET_TO_METERS
        if location.get("match_buffer_meters") is not None:
            return float(location["match_buffer_meters"])
        return DEFAULT_MATCH_BUFFER_METERS

    @staticmethod
    def _get_min_match_length(location: dict[str, Any]) -> float:
        """Get minimum match length in meters from location settings.

        Args:
            location: Location dictionary

        Returns:
            Minimum match length in meters
        """
        if location.get("min_match_length_feet") is not None:
            return float(location["min_match_length_feet"]) * FEET_TO_METERS
        if location.get("min_match_length_meters") is not None:
            return float(location["min_match_length_meters"])
        return DEFAULT_MIN_MATCH_LENGTH_METERS

    async def update_progress(
        self,
        stage: str,
        progress: float,
        message: str = "",
        error: str = "",
    ) -> None:
        """Update the progress document in MongoDB.

        Args:
            stage: Current processing stage
            progress: Progress percentage (0-100)
            message: Optional status message
            error: Optional error message
        """
        try:
            current_covered_length = self.initial_driven_length
            coverage_pct = (
                (current_covered_length / self.total_driveable_length * 100)
                if self.total_driveable_length > 0
                else 0.0
            )

            enhanced_metrics = {
                "total_trips_to_process": self.total_trips_to_process,
                "processed_trips": self.processed_trips_count,
                "driveable_length_mi": round(
                    self.total_driveable_length * METERS_TO_MILES, 2
                ),
                "covered_length_mi": round(current_covered_length * METERS_TO_MILES, 2),
                "coverage_percentage": round(coverage_pct, 2),
                "initial_covered_segments": self.initial_covered_segments_count,
                "newly_covered_segments": len(self.newly_covered_segments),
            }

            update_data: dict[str, Any] = {
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

            # Upsert ProgressStatus
            # Beanie: find by ID and update or insert
            # Since _id is user provided task_id (string), we map it to id field
            status_doc = await ProgressStatus.get(self.task_id)
            if status_doc:
                await status_doc.set(update_data)
            else:
                status_doc = ProgressStatus(id=self.task_id, **update_data)
                # Ensure all fields are set
                await status_doc.insert()

        except Exception as e:
            logger.error(
                "Task %s: Error updating progress: %s",
                self.task_id,
                e,
            )

    async def calculate_initial_stats(self) -> bool:
        """Calculate initial statistics using MongoDB aggregation.

        Returns:
            True if successful, False otherwise
        """
        logger.info(
            "Task %s: Calculating initial stats for %s...",
            self.task_id,
            self.location_name,
        )
        await self.update_progress(
            "indexing",
            42,
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

            result = await Street.aggregate(pipeline).to_list(length=1)

            if result:
                stats = result[0]
                self.total_driveable_length = stats.get("driveable_length", 0.0)
                self.initial_driven_length = stats.get("driven_length", 0.0)
                self.initial_covered_segments_count = stats.get("covered_segments", 0)
                self.initial_covered_segments = set(stats.get("driven_ids", []))
                total_segments = stats.get("total_segments", 0)

                logger.info(
                    "Task %s: Stats for %s: Driveable=%.2fmi, Driven=%.2fmi, "
                    "Segments=%d",
                    self.task_id,
                    self.location_name,
                    self.total_driveable_length * METERS_TO_MILES,
                    self.initial_driven_length * METERS_TO_MILES,
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
        """Validate if the GPS data is suitable for coverage calculation.

        Args:
            gps_data: GPS data dictionary (GeoJSON)

        Returns:
            Tuple of (is_valid, coordinates)
        """
        if not gps_data or not isinstance(gps_data, dict):
            return False, []

        is_valid, validated_geojson = (
            GeometryService.validate_geojson_point_or_linestring(gps_data)
        )

        if not is_valid or validated_geojson is None:
            return False, []

        geom_type = validated_geojson.get("type")
        coordinates = validated_geojson.get("coordinates")

        if geom_type == "Point":
            return True, [coordinates, coordinates]
        if geom_type == "LineString":
            return True, coordinates

        return False, []

    @staticmethod
    def _line_length_m(coords: list[tuple[float, float]]) -> float:
        """Calculate length of a line in meters.

        Args:
            coords: List of coordinate tuples (lon, lat)

        Returns:
            Length in meters
        """
        length_m = 0.0
        for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:], strict=False):
            length_m += GeometryService.haversine_distance(
                lon1,
                lat1,
                lon2,
                lat2,
                unit="meters",
            )
        return length_m

    def _geometry_length_m(self, geom: Any) -> float:
        """Calculate geometry length in meters.

        Handles LineString, MultiLineString, and GeometryCollection types.

        Args:
            geom: Shapely geometry object

        Returns:
            Length in meters
        """
        if geom is None or geom.is_empty:
            return 0.0
        geom_type = geom.geom_type
        if geom_type == "LineString":
            return self._line_length_m(list(geom.coords))
        if geom_type == "MultiLineString":
            return sum(self._line_length_m(list(line.coords)) for line in geom.geoms)
        if geom_type == "GeometryCollection":
            total = 0.0
            for sub in geom.geoms:
                total += self._geometry_length_m(sub)
            return total
        return 0.0

    async def _find_intersecting_streets(self, trip_geometry: dict) -> list[str]:
        """Find undriven streets intersecting a trip geometry using MongoDB.

        Args:
            trip_geometry: GeoJSON geometry of the trip

        Returns:
            List of segment IDs that intersect the trip
        """
        try:
            # Convert GeoJSON to Shapely
            trip_shape = shape(trip_geometry)

            # Simple approximation: 1 degree ~ 111,139 meters
            buffer_degrees = self.match_buffer / DEGREES_TO_METERS

            # Buffer the line to create a polygon "swath"
            query_polygon = trip_shape.buffer(buffer_degrees)

            # Convert back to GeoJSON
            query_geometry = mapping(query_polygon)

            # Query MongoDB using Beanie
            # Using raw find to get specific fields including geometry
            docs = (
                await Street.find(
                    {
                        "properties.location": self.location_name,
                        "properties.driven": False,
                        "geometry": {"$geoIntersects": {"$geometry": query_geometry}},
                    }
                )
                .project(model=Street)
                .to_list()
            )  # Fetch all matches

            # Since we need only specific fields and Street model returns objects, we can optimize.
            # But Beanie Street(Document) includes all fields.

            if self.min_match_length <= 0:
                return [doc.properties["segment_id"] for doc in docs]

            matched_segments: list[str] = []
            for doc in docs:
                segment_geom = doc.geometry
                if not segment_geom:
                    continue
                try:
                    seg_shape = shape(segment_geom)
                    intersection = seg_shape.intersection(query_polygon)
                except Exception:
                    continue

                if self._geometry_length_m(intersection) >= self.min_match_length:
                    matched_segments.append(doc.properties["segment_id"])

            return matched_segments
        except Exception as e:
            # Rate-limit error logging to prevent spam
            self._geospatial_error_count += 1
            if self._geospatial_error_count == 1:
                self._geospatial_error_sample = str(e)
                logger.error(
                    "Task %s: Geospatial query failed: %s "
                    "(further errors will be summarized)",
                    self.task_id,
                    e,
                )
            elif self._geospatial_error_count % 50 == 0:
                logger.warning(
                    "Task %s: %d geospatial query errors so far",
                    self.task_id,
                    self._geospatial_error_count,
                )
            return []

    async def process_trips(self, processed_trip_ids_set: set[str]) -> bool:
        """Process trips to find newly covered street segments.

        Uses MongoDB geospatial queries to find intersections.

        Args:
            processed_trip_ids_set: Set of already processed trip IDs (modified in place)

        Returns:
            True if successful, False otherwise
        """
        await self.update_progress(
            "processing_trips",
            48,
            f"Starting trip analysis for {self.location_name}",
        )

        base_trip_filter = self._build_trip_filter(processed_trip_ids_set)

        try:
            self.total_trips_to_process = await Trip.find(base_trip_filter).count()
            logger.info(
                "Task %s: Found %d trips to process.",
                self.task_id,
                self.total_trips_to_process,
            )
        except Exception as e:
            logger.error("Task %s: Error counting trips: %s", self.task_id, e)
            return False

        if self.total_trips_to_process == 0:
            return True

        self.newly_covered_segments = set()
        processed_count = 0

        # Manual batching using Beanie iterator
        batch: list[Trip] = []
        async for trip_doc in Trip.find(base_trip_filter).project(
            model=Trip
        ):  # Project to Trip model (includes gps, id)
            batch.append(trip_doc)

            if len(batch) >= self.trip_batch_size:
                await self._process_batch(batch, processed_trip_ids_set)
                processed_count += len(batch)
                self.processed_trips_count = processed_count

                # Update progress
                progress_pct = 50 + (
                    processed_count / max(self.total_trips_to_process, 1) * 40
                )
                await self.update_progress(
                    "processing_trips",
                    progress_pct,
                    f"Processed {processed_count}/{self.total_trips_to_process} trips. "
                    f"Found {len(self.newly_covered_segments)} segments.",
                )
                batch = []

        # Process remaining
        if batch:
            await self._process_batch(batch, processed_trip_ids_set)
            processed_count += len(batch)
            self.processed_trips_count = processed_count

            # Final progress update for this stage
            progress_pct = 50 + (
                processed_count / max(self.total_trips_to_process, 1) * 40
            )
            await self.update_progress(
                "processing_trips",
                progress_pct,
                f"Processed {processed_count}/{self.total_trips_to_process} trips. "
                f"Found {len(self.newly_covered_segments)} segments.",
            )

        return True

    async def _process_batch(
        self, batch: list[Trip], processed_trip_ids_set: set[str]
    ) -> None:
        """Process a batch of trips."""
        tasks = []

        for trip_doc in batch:
            trip_id = str(trip_doc.id)  # Beanie uses .id for _id
            if trip_id in processed_trip_ids_set:
                continue

            is_valid, coords = self._is_valid_trip(trip_doc.gps)
            if not is_valid or not coords:
                processed_trip_ids_set.add(trip_id)
                continue

            # Create the task to query streets for this specific trip
            tasks.append(self._find_intersecting_streets(trip_doc.gps))
            processed_trip_ids_set.add(trip_id)

        # Execute batch of geospatial queries concurrently
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for res in results:
                if isinstance(res, list):
                    self.newly_covered_segments.update(res)
                elif isinstance(res, Exception):
                    logger.error("Error querying intersections: %s", res)

    def _build_trip_filter(self, processed_trip_ids_set: set[str]) -> dict[str, Any]:
        """Build MongoDB filter for trips query.

        Args:
            processed_trip_ids_set: Set of already processed trip IDs

        Returns:
            MongoDB filter dictionary
        """
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
        # Beanie's _id is strings usually if defined as Pydantic models with str id?
        # But if the set contains strings, we need to match appropriately.
        # Beanie Trip model: id field is implicit or explicit.
        # If it's explicit, it's typically str or ObjectId.
        # Here we assume IDs in DB are ObjectId OR strings that work with $nin.
        # Beanie handles ID serialization.

        # We need to construct a list of IDs to exclude.
        # If Beanie expects ObjectIds for _id, we should convert strings to ObjectIds.
        # If Beanie expects Strings, we use strings.
        # The Trip model might use PydanticObjectId or str.
        # Let's check Trip model in db/models.py again?
        # Line 34: class Trip(Document):
        # ...
        # It doesn't explicitly define id field, so it uses default PydanticObjectId (ObjectId).
        # So we should convert strings to ObjectIds for the query if we are filtering by _id.

        processed_object_ids = [
            ObjectId(tid) for tid in processed_trip_ids_set if ObjectId.is_valid(tid)
        ]
        if processed_object_ids:
            # We can rely on Beanie/Pydantic to serialize if we pass ObjectIds
            base_trip_filter["_id"] = {"$nin": processed_object_ids}

        return base_trip_filter

    async def finalize_coverage(
        self,
        processed_trip_ids_set: set[str],
    ) -> dict[str, Any] | None:
        """Update street 'driven' status and calculate final stats.

        Args:
            processed_trip_ids_set: Set of all processed trip IDs

        Returns:
            Final coverage statistics or None on error
        """
        # Identify segments that are truly new (not in initial set)
        segments_to_update_in_db = list(
            self.newly_covered_segments - self.initial_covered_segments
        )
        newly_driven_count = len(segments_to_update_in_db)

        await self.update_progress(
            "finalizing",
            90,
            f"Updating {newly_driven_count:,} newly driven segments in database.",
        )

        # Bulk update MongoDB
        if segments_to_update_in_db:
            await self._update_driven_segments(segments_to_update_in_db)

        # Calculate final stats via aggregation
        await self.update_progress(
            "finalizing",
            95,
            f"Calculating final coverage statistics for {self.location_name}",
        )

        coverage_stats = await self._calculate_final_stats()
        if coverage_stats is None:
            return None

        # Update metadata
        await self._update_coverage_metadata(
            coverage_stats, processed_trip_ids_set, newly_driven_count
        )

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

    async def _update_driven_segments(self, segment_ids: list[str]) -> None:
        """Update segments as driven in the database.

        Args:
            segment_ids: List of segment IDs to mark as driven
        """
        update_timestamp = datetime.now(UTC)
        try:
            for i in range(0, len(segment_ids), MAX_UPDATE_BATCH_SIZE):
                segment_batch = segment_ids[i : i + MAX_UPDATE_BATCH_SIZE]

                # Update using Beanie
                await Street.find(
                    {"properties.segment_id": {"$in": segment_batch}}
                ).update(
                    {
                        "$set": {
                            "properties.driven": True,
                            "properties.last_coverage_update": update_timestamp,
                        },
                    }
                )
                await asyncio.sleep(BATCH_PROCESS_DELAY)
        except Exception as e:
            logger.error("Task %s: Error updating DB: %s", self.task_id, e)
            await self.update_progress("error", 90, f"Error updating DB: {e}")

    async def _calculate_final_stats(self) -> dict[str, Any] | None:
        """Calculate final coverage statistics via MongoDB aggregation.

        Returns:
            Coverage statistics dictionary or None on error
        """
        try:
            pipeline = [
                {"$match": {"properties.location": self.location_name}},
                {
                    "$facet": {
                        "overall": [
                            {
                                "$group": {
                                    "_id": None,
                                    "total_length": {
                                        "$sum": "$properties.segment_length"
                                    },
                                    "driveable_length": {
                                        "$sum": {
                                            "$cond": [
                                                {
                                                    "$eq": [
                                                        "$properties.undriveable",
                                                        True,
                                                    ]
                                                },
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
                                                        {
                                                            "$eq": [
                                                                "$properties.driven",
                                                                True,
                                                            ]
                                                        },
                                                        {
                                                            "$ne": [
                                                                "$properties.undriveable",
                                                                True,
                                                            ]
                                                        },
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
                                                {
                                                    "$and": [
                                                        {
                                                            "$eq": [
                                                                "$properties.driven",
                                                                True,
                                                            ]
                                                        },
                                                        {
                                                            "$ne": [
                                                                "$properties.undriveable",
                                                                True,
                                                            ]
                                                        },
                                                    ]
                                                },
                                                1,
                                                0,
                                            ]
                                        }
                                    },
                                }
                            }
                        ],
                        "by_type": [
                            {
                                "$group": {
                                    "_id": "$properties.highway",
                                    "total_length": {
                                        "$sum": "$properties.segment_length"
                                    },
                                    "driveable_length": {
                                        "$sum": {
                                            "$cond": [
                                                {
                                                    "$eq": [
                                                        "$properties.undriveable",
                                                        True,
                                                    ]
                                                },
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
                                                        {
                                                            "$eq": [
                                                                "$properties.driven",
                                                                True,
                                                            ]
                                                        },
                                                        {
                                                            "$ne": [
                                                                "$properties.undriveable",
                                                                True,
                                                            ]
                                                        },
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
                                                {
                                                    "$and": [
                                                        {
                                                            "$eq": [
                                                                "$properties.driven",
                                                                True,
                                                            ]
                                                        },
                                                        {
                                                            "$ne": [
                                                                "$properties.undriveable",
                                                                True,
                                                            ]
                                                        },
                                                    ]
                                                },
                                                1,
                                                0,
                                            ]
                                        }
                                    },
                                    "undriveable_length": {
                                        "$sum": {
                                            "$cond": [
                                                {
                                                    "$eq": [
                                                        "$properties.undriveable",
                                                        True,
                                                    ]
                                                },
                                                "$properties.segment_length",
                                                0,
                                            ]
                                        }
                                    },
                                }
                            }
                        ],
                    }
                },
            ]

            result = await Street.aggregate(pipeline).to_list(1)

            if not result or not result[0].get("overall"):
                logger.error(
                    "Task %s: Final stats aggregation returned empty.", self.task_id
                )
                await self.update_progress(
                    "error",
                    95,
                    "No street data found for this location",
                    error="No streets found - please check that the location has "
                    "been preprocessed correctly",
                )
                return None

            stats = result[0]["overall"][0]

            final_street_types = self._build_street_types_stats(
                result[0].get("by_type", [])
            )

            driveable_length = stats.get("driveable_length", 0)
            driven_length = stats.get("driven_length", 0)

            return {
                "total_length_m": round(stats.get("total_length", 0), 2),
                "driven_length_m": round(driven_length, 2),
                "driveable_length_m": round(driveable_length, 2),
                "coverage_percentage": round(
                    (
                        (driven_length / driveable_length * 100)
                        if driveable_length > 0
                        else 0
                    ),
                    2,
                ),
                "total_segments": stats.get("total_segments", 0),
                "covered_segments": stats.get("covered_segments", 0),
                "street_types": final_street_types,
            }

        except Exception as e:
            logger.error("Task %s: Error calculating final stats: %s", self.task_id, e)
            await self.update_progress("error", 95, f"Error calculating stats: {e}")
            return None

    @staticmethod
    def _build_street_types_stats(by_type_data: list[dict]) -> list[dict]:
        """Build street type statistics from aggregation results.

        Args:
            by_type_data: List of per-type aggregation results

        Returns:
            List of street type statistics
        """
        final_street_types = []
        for item in by_type_data:
            driveable_len = item.get("driveable_length", 0.0)
            driven_len = item.get("driven_length", 0.0)
            pct = (driven_len / driveable_len * 100) if driveable_len > 0 else 0

            final_street_types.append(
                {
                    "type": item.get("_id", "unknown"),
                    "total_segments": item.get("total_segments", 0),
                    "covered_segments": item.get("covered_segments", 0),
                    "total_length_m": round(item.get("total_length", 0.0), 2),
                    "covered_length_m": round(driven_len, 2),
                    "driveable_length_m": round(driveable_len, 2),
                    "undriveable_length_m": round(
                        item.get("undriveable_length", 0.0), 2
                    ),
                    "coverage_percentage": round(pct, 2),
                }
            )

        final_street_types.sort(key=lambda x: x["total_length_m"], reverse=True)
        return final_street_types

    async def _update_coverage_metadata(
        self,
        coverage_stats: dict[str, Any],
        processed_trip_ids_set: set[str],
    ) -> None:
        """Update coverage metadata in the database.

        Args:
            coverage_stats: Calculated coverage statistics
            processed_trip_ids_set: Set of all processed trip IDs
            newly_driven_count: Count of newly covered segments
        """
        logger.info(
            "Task %s: Updating coverage metadata for %s...",
            self.task_id,
            self.location_name,
        )
        try:
            trip_ids_list = list(processed_trip_ids_set)
            processed_trips_info: dict[str, Any] = {
                "last_processed_timestamp": datetime.now(UTC),
                "count_in_last_run": self.processed_trips_count,
            }

            update_doc: dict[str, Any] = {
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

            if len(trip_ids_list) <= MAX_TRIP_IDS_TO_STORE:
                update_doc["$set"]["processed_trips"]["trip_ids"] = trip_ids_list
            else:
                logger.warning(
                    "Task %s: Trip ID list too large (%d). Skipping storage "
                    "in metadata.",
                    self.task_id,
                    len(trip_ids_list),
                )

            await CoverageMetadata.find_one(
                {"location.display_name": self.location_name}
            ).update(update_doc, upsert=True)

        except Exception as e:
            logger.error("Task %s: Error updating metadata: %s", self.task_id, e)
            await self.update_progress("error", 97, f"Failed to update metadata: {e}")

    async def compute_coverage(
        self,
        run_incremental: bool = False,
    ) -> dict[str, Any] | None:
        """Main orchestration method for the coverage calculation process.

        Args:
            run_incremental: If True, only process new trips since last run

        Returns:
            Coverage statistics dictionary or None on error
        """
        # Import here to avoid circular imports
        from coverage.geojson_generator import generate_and_store_geojson

        start_time = datetime.now(UTC)
        run_type = "incremental" if run_incremental else "full"
        logger.info(
            "Task %s: Starting %s coverage for %s",
            self.task_id,
            run_type,
            self.location_name,
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
                processed_trip_ids_set = await self._load_previous_trip_ids()

            # Process trips
            trips_success = await self.process_trips(processed_trip_ids_set)
            if not trips_success:
                logger.error("Task %s: Trip processing failed.", self.task_id)
                return None

            # Finalize
            final_stats = await self.finalize_coverage(processed_trip_ids_set)

            if final_stats:
                # Trigger GeoJSON generation in background
                asyncio.create_task(
                    generate_and_store_geojson(self.location_name, self.task_id)
                )

            duration = (datetime.now(UTC) - start_time).total_seconds()

            # Log summary of geospatial errors if any occurred
            if self._geospatial_error_count > 0:
                logger.warning(
                    "Task %s: Completed with %d geospatial query errors. "
                    "Sample error: %s",
                    self.task_id,
                    self._geospatial_error_count,
                    self._geospatial_error_sample,
                )

            logger.info("Task %s: Finished in %.2fs", self.task_id, duration)

            return final_stats

        except Exception as e:
            logger.exception("Task %s: Unhandled error: %s", self.task_id, e)
            await self.update_progress("error", 0, f"Unhandled error: {e}")
            return None

    async def _load_previous_trip_ids(self) -> set[str]:
        """Load previously processed trip IDs from metadata.

        Returns:
            Set of previously processed trip IDs
        """
        try:
            metadata = await CoverageMetadata.find_one(
                {"location.display_name": self.location_name}
            ).project(model=CoverageMetadata)  # Or just fetch and access field

            # Since processed_trips is a dict inside the model (field checked in previous view)
            # CoverageMetadata has field `location` (dict) and `display_name`?
            # Wait, `db/models.py` showed `CoverageMetadata` fields.
            # CoverageMetadata(Document):
            #   ...
            # But here query uses `{"location.display_name": self.location_name}`.
            # This implies `location` is a sub-document/dict containing `display_name`.
            # And `_load_previous_trip_ids` projects `processed_trips.trip_ids`.
            # I need to check if `processed_trips` is defined in `CoverageMetadata`.
            # Looking at `db/models.py` again (Step 117):
            #   ...
            # It accepts `extra="allow"`. So `processed_trips` might be an extra field or inside `location`.
            # The code `metadata["processed_trips"]` suggests it's a top-level field.

            # Since `extra="allow"`, we can access it via `getattr(metadata, "processed_trips", {})` or strict typing.

            # `find_one` will return a CoverageMetadata instance.
            metadata = await CoverageMetadata.find_one(
                {"location.display_name": self.location_name}
            )

            if metadata and hasattr(metadata, "processed_trips"):
                processed = metadata.processed_trips
                if isinstance(processed, dict):
                    ids = processed.get("trip_ids", [])
                    if isinstance(ids, list):
                        return set(map(str, ids))

        except Exception as e:
            logger.warning("Failed to load previous trip IDs: %s. Running full.", e)
        return set()


async def compute_coverage_for_location(
    location: dict[str, Any],
    task_id: str,
) -> dict[str, Any] | None:
    """Entry point for a full coverage calculation.

    Args:
        location: Location dictionary with display_name and other settings
        task_id: Unique task identifier

    Returns:
        Coverage statistics dictionary or None on error
    """
    calculator = CoverageCalculator(location, task_id)
    return await calculator.compute_coverage(run_incremental=False)


async def compute_incremental_coverage(
    location: dict[str, Any],
    task_id: str,
) -> dict[str, Any] | None:
    """Entry point for an incremental coverage calculation.

    Args:
        location: Location dictionary with display_name and other settings
        task_id: Unique task identifier

    Returns:
        Coverage statistics dictionary or None on error
    """
    calculator = CoverageCalculator(location, task_id)
    return await calculator.compute_coverage(run_incremental=True)
