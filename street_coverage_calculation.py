import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import pyproj
import rtree
from shapely.geometry import box, LineString, shape
from shapely.ops import transform
from dotenv import load_dotenv

# Database functions/collections from db.py
from db import (
    streets_collection,
    trips_collection,
    coverage_metadata_collection,
    progress_collection,
    ensure_street_coverage_indexes,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Define CRS for WGS84 globally
WGS84 = pyproj.CRS("EPSG:4326")


class CoverageCalculator:
    def __init__(self, location: Dict[str, Any], task_id: str) -> None:
        """
        Initialize the calculator with a given location and task identifier.
        """
        self.location: Dict[str, Any] = location
        self.task_id: str = task_id
        self.streets_index = rtree.index.Index()
        self.streets_lookup: Dict[int, Dict[str, Any]] = {}
        self.utm_proj: Optional[pyproj.CRS] = None
        self.project_to_utm = None
        self.project_to_wgs84 = None
        self.match_buffer: float = 15.0  # meters
        self.min_match_length: float = 5.0  # meters
        self.batch_size: int = 1000
        self.boundary_box: Optional[box] = None
        self.total_length: float = 0.0
        self.covered_segments: Set[str] = set()
        self.segment_coverage: Dict[str, int] = defaultdict(int)
        self.total_trips: int = 0
        self.processed_trips: int = 0

        self.initialize_projections()

    def initialize_projections(self) -> None:
        """
        Initialize UTM projection based on the location’s center.
        """
        center_lat, center_lon = self._get_location_center()
        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"
        self.utm_proj = pyproj.CRS(
            f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84"
        )
        self.project_to_utm = pyproj.Transformer.from_crs(
            WGS84, self.utm_proj, always_xy=True
        ).transform
        self.project_to_wgs84 = pyproj.Transformer.from_crs(
            self.utm_proj, WGS84, always_xy=True
        ).transform

    def _get_location_center(self) -> Tuple[float, float]:
        """
        Extract center point from location's bounding box (if available) or return (0.0, 0.0).
        """
        if "boundingbox" in self.location:
            bbox = self.location["boundingbox"]
            return (
                (float(bbox[0]) + float(bbox[1])) / 2,
                (float(bbox[2]) + float(bbox[3])) / 2,
            )
        return 0.0, 0.0

    async def update_progress(
        self, stage: str, progress: float, message: str = "", error: str = ""
    ) -> None:
        """
        Update progress in MongoDB.
        """
        try:
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

    def build_spatial_index(self, streets: List[Dict[str, Any]]) -> None:
        """
        Build an R-tree spatial index for street segments and accumulate total street length.
        Also caches each street's UTM length.
        """
        logger.info("Building spatial index for %d streets...", len(streets))
        for idx, street in enumerate(streets):
            try:
                geom = shape(street["geometry"])
                bounds = geom.bounds
                self.streets_index.insert(idx, bounds)
                self.streets_lookup[idx] = street

                # Compute length in UTM (meters)
                street_utm = transform(self.project_to_utm, geom)
                # Save the computed length to the street properties for later reuse
                street["properties"]["segment_length"] = street_utm.length
                self.total_length += street_utm.length
            except Exception as e:
                logger.error(
                    "Error indexing street (ID %s): %s",
                    street.get("properties", {}).get("segment_id"),
                    e,
                )

    @staticmethod
    def calculate_boundary_box(streets: List[Dict[str, Any]]) -> box:
        """
        Calculate a bounding box that contains all given streets.
        """
        bounds = None
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
                logger.error(
                    "Error processing geometry for boundary box: %s", e
                )
        return box(*bounds) if bounds else box(0, 0, 0, 0)

    def is_trip_in_boundary(self, trip: Dict[str, Any]) -> bool:
        """
        Quickly determine if a trip’s GPS path intersects the boundary box.
        """
        try:
            gps_data = trip.get("gps")
            if not gps_data or "coordinates" not in (
                coords := (
                    json.loads(gps_data)
                    if isinstance(gps_data, str)
                    else gps_data
                )
            ):
                return False
            coords_list = coords["coordinates"]
            return self.boundary_box.intersects(LineString(coords_list))
        except (KeyError, json.JSONDecodeError) as e:
            logger.error("Error decoding trip GPS data: %s", e)
            return False
        except Exception as e:
            logger.error("Error checking trip boundary: %s", e)
            return False

    async def process_single_trip(self, trip: Dict[str, Any]) -> Set[str]:
        """
        Process a single trip, determining which street segments were covered.
        """
        covered: Set[str] = set()
        try:
            gps_data = trip.get("gps")
            if not gps_data:
                return covered

            data = (
                json.loads(gps_data)
                if isinstance(gps_data, str)
                else gps_data
            )
            if "coordinates" not in data:
                return covered

            coords = data["coordinates"]
            trip_line = LineString(coords)
            # Transform the trip geometry into UTM
            trip_line_utm = transform(self.project_to_utm, trip_line)
            trip_buffer = trip_line_utm.buffer(self.match_buffer)

            # Pre-transform the buffer back to WGS84 for spatial index query
            trip_buffer_wgs84 = transform(self.project_to_wgs84, trip_buffer)

            # Query spatial index using the buffer's bounding box
            for idx in self.streets_index.intersection(
                trip_buffer_wgs84.bounds
            ):
                street = self.streets_lookup[idx]
                street_geom = shape(street["geometry"])
                street_utm = transform(self.project_to_utm, street_geom)
                intersection = trip_buffer.intersection(street_utm)
                if (
                    not intersection.is_empty
                    and intersection.length >= self.min_match_length
                ):
                    segment_id = street["properties"].get("segment_id")
                    if segment_id:
                        covered.add(segment_id)
            return covered
        except Exception as e:
            logger.error(
                "Error processing trip (ID %s): %s",
                trip.get("_id", "unknown"),
                e,
                exc_info=True,
            )
            return covered

    async def process_trip_batch(self, trips: List[Dict[str, Any]]) -> None:
        """
        Process a batch of trips concurrently.
        """
        tasks = [
            self.process_single_trip(trip)
            for trip in trips
            if self.boundary_box and self.is_trip_in_boundary(trip)
        ]
        if tasks:
            results = await asyncio.gather(*tasks)
            for segments in results:
                for seg in segments:
                    self.covered_segments.add(seg)
                    self.segment_coverage[seg] += 1
        self.processed_trips += len(trips)
        progress_val = (
            (self.processed_trips / self.total_trips * 100)
            if self.total_trips > 0
            else 0
        )
        await self.update_progress(
            "processing_trips",
            progress_val,
            f"Processed {self.processed_trips} of {self.total_trips} trips",
        )

    async def compute_coverage(self) -> Optional[Dict[str, Any]]:
        """
        Compute the street coverage for the location.
        """
        try:
            await self.update_progress(
                "initializing", 0, "Starting coverage calculation..."
            )
            await ensure_street_coverage_indexes()

            await self.update_progress(
                "loading_streets", 10, "Loading street data..."
            )
            # Load all street segments for the location from the database
            streets: List[Dict[str, Any]] = await streets_collection.find(
                {"properties.location": self.location.get("display_name")}
            ).to_list(length=None)
            if not streets:
                msg = "No streets found for location"
                logger.warning(msg)
                await self.update_progress("error", 0, msg)
                return None

            await self.update_progress(
                "indexing", 20, "Building spatial index..."
            )
            self.build_spatial_index(streets)
            self.boundary_box = self.calculate_boundary_box(streets)

            await self.update_progress(
                "counting_trips", 30, "Counting trips..."
            )
            # Use bounding box query to filter trips
            bbox = self.boundary_box.bounds
            trip_filter = {
                "gps": {"$exists": True},
                "$or": [
                    {
                        "startGeoPoint": {
                            "$geoWithin": {
                                "$box": [
                                    [bbox[0], bbox[1]],
                                    [bbox[2], bbox[3]],
                                ]
                            }
                        }
                    },
                    {
                        "destinationGeoPoint": {
                            "$geoWithin": {
                                "$box": [
                                    [bbox[0], bbox[1]],
                                    [bbox[2], bbox[3]],
                                ]
                            }
                        }
                    },
                ],
            }
            self.total_trips = await trips_collection.count_documents(
                trip_filter
            )
            await self.update_progress(
                "processing_trips",
                40,
                f"Processing {self.total_trips} trips...",
            )

            batch: List[Dict[str, Any]] = []
            async for trip in trips_collection.aggregate(
                [{"$match": trip_filter}]
            ):
                batch.append(trip)
                if len(batch) >= self.batch_size:
                    await self.process_trip_batch(batch)
                    batch = []
                    progress = min(
                        90,
                        40 + (self.processed_trips / self.total_trips * 50),
                    )
                    await self.update_progress(
                        "processing_trips",
                        progress,
                        f"Processed {self.processed_trips} of {self.total_trips} trips",
                    )
            if batch:
                await self.process_trip_batch(batch)

            # Finalize: calculate covered length and build GeoJSON features
            await self.update_progress(
                "finalizing", 95, "Calculating final coverage..."
            )
            covered_length = 0.0
            features = []
            for street in streets:
                segment_id = street["properties"].get("segment_id")
                geom = shape(street["geometry"])
                # Compute the segment length (UTM units)
                street_utm = transform(self.project_to_utm, geom)
                seg_length = street_utm.length

                is_covered = segment_id in self.covered_segments
                if is_covered:
                    covered_length += seg_length

                feature = {
                    "type": "Feature",
                    "geometry": street["geometry"],
                    "properties": {
                        **street["properties"],
                        "driven": is_covered,
                        "coverage_count": self.segment_coverage.get(
                            segment_id, 0
                        ),
                        "segment_length": seg_length,
                        "segment_id": segment_id,
                    },
                }
                features.append(feature)

            coverage_percentage = (
                (covered_length / self.total_length * 100)
                if self.total_length > 0
                else 0
            )

            await self.update_progress(
                "complete", 100, "Coverage calculation complete"
            )
            return {
                "total_length": self.total_length,
                "driven_length": covered_length,
                "coverage_percentage": coverage_percentage,
                "streets_data": {
                    "type": "FeatureCollection",
                    "features": features,
                    "metadata": {
                        "total_length_miles": self.total_length * 0.000621371,
                        "driven_length_miles": covered_length * 0.000621371,
                        "coverage_percentage": coverage_percentage,
                    },
                },
            }
        except Exception as e:
            logger.error("Error computing coverage: %s", e, exc_info=True)
            await self.update_progress("error", 0, f"Error: {str(e)}")
            return None


async def compute_coverage_for_location(
    location: Dict[str, Any], task_id: str
) -> Optional[Dict[str, Any]]:
    """
    Compute street coverage for a given location.
    """
    calculator = CoverageCalculator(location, task_id)
    return await calculator.compute_coverage()


async def update_coverage_for_all_locations() -> None:
    """
    Update street coverage for all locations.
    """
    try:
        logger.info("Starting coverage update for all locations...")
        cursor = coverage_metadata_collection.find(
            {}, {"location": 1, "_id": 1}
        )
        async for doc in cursor:
            loc = doc.get("location")
            if not loc or isinstance(loc, str):
                logger.warning(
                    "Skipping doc %s - invalid location format",
                    doc.get("_id"),
                )
                continue
            task_id = f"bulk_update_{doc['_id']}"
            result = await compute_coverage_for_location(loc, task_id)
            if result:
                display_name = loc.get("display_name", "Unknown")
                await coverage_metadata_collection.update_one(
                    {"location.display_name": display_name},
                    {
                        "$set": {
                            "location": loc,
                            "total_length": result["total_length"],
                            "driven_length": result["driven_length"],
                            "coverage_percentage": result[
                                "coverage_percentage"
                            ],
                            "last_updated": datetime.now(timezone.utc),
                        }
                    },
                    upsert=True,
                )
                logger.info(
                    "Updated coverage for %s: %.2f%%",
                    display_name,
                    result["coverage_percentage"],
                )
        logger.info("Finished coverage update for all locations.")
    except Exception as e:
        logger.error(
            "Error updating coverage for all locations: %s", e, exc_info=True
        )
