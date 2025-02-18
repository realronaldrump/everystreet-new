import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
import itertools
import multiprocessing
from concurrent.futures import ProcessPoolExecutor

import pyproj
import rtree
from shapely.geometry import box, LineString, shape
from shapely.ops import transform
from dotenv import load_dotenv

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

WGS84 = pyproj.CRS("EPSG:4326")


class CoverageCalculator:
    def __init__(self, location: Dict[str, Any], task_id: str) -> None:
        self.location = location
        self.task_id = task_id
        self.streets_index = rtree.index.Index()
        self.streets_lookup: Dict[int, Dict[str, Any]] = {}
        self.utm_proj: Optional[pyproj.CRS] = None
        self.project_to_utm = None
        self.project_to_wgs84 = None

        self.match_buffer: float = 15.0
        self.min_match_length: float = 5.0
        self.batch_size: int = 1000
        self.street_chunk_size: int = 500  # For processing streets in chunks
        self.boundary_box = None

        self.total_length: float = 0.0
        self.covered_segments: Set[str] = set()
        self.segment_coverage = defaultdict(int)
        self.total_trips: int = 0
        self.processed_trips: int = 0

        # Initialize process pool with number of CPU cores
        self.process_pool = ProcessPoolExecutor(max_workers=multiprocessing.cpu_count())

        self.initialize_projections()

    def initialize_projections(self) -> None:
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

    def _get_location_center(self):
        if "boundingbox" in self.location:
            bbox = self.location["boundingbox"]
            return (float(bbox[0]) + float(bbox[1])) / 2, (
                float(bbox[2]) + float(bbox[3])
            ) / 2
        return 0.0, 0.0

    async def update_progress(
        self, stage: str, progress: float, message: str = "", error: str = ""
    ) -> None:
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

    async def initialize(self) -> None:
        """Asynchronous initialization method"""
        await asyncio.to_thread(self.initialize_projections)

    async def build_spatial_index(self, streets: List[Dict[str, Any]]):
        logger.info("Building spatial index for %d streets...", len(streets))

        # Process streets in chunks to avoid blocking
        for i in range(0, len(streets), self.street_chunk_size):
            chunk = streets[i : i + self.street_chunk_size]
            await asyncio.to_thread(self._process_street_chunk, chunk)

            # Allow other tasks to run
            await asyncio.sleep(0)

    def _process_street_chunk(self, streets: List[Dict[str, Any]]):
        """Process a chunk of streets synchronously"""
        for idx, street in enumerate(streets):
            try:
                geom = shape(street["geometry"])
                bounds = geom.bounds
                current_idx = len(self.streets_lookup)
                self.streets_index.insert(current_idx, bounds)
                self.streets_lookup[current_idx] = street

                street_utm = transform(self.project_to_utm, geom)
                street["properties"]["segment_length"] = street_utm.length
                self.total_length += street_utm.length
            except Exception as e:
                logger.error(
                    "Error indexing street (ID %s): %s",
                    street.get("properties", {}).get("segment_id"),
                    e,
                )

    async def calculate_boundary_box(self, streets: List[Dict[str, Any]]):
        bounds = None

        # Process streets in chunks
        for i in range(0, len(streets), self.street_chunk_size):
            chunk = streets[i : i + self.street_chunk_size]
            chunk_bounds = await asyncio.to_thread(self._process_boundary_chunk, chunk)

            if bounds is None:
                bounds = chunk_bounds
            else:
                bounds = (
                    min(bounds[0], chunk_bounds[0]),
                    min(bounds[1], chunk_bounds[1]),
                    max(bounds[2], chunk_bounds[2]),
                    max(bounds[3], chunk_bounds[3]),
                )

            # Allow other tasks to run
            await asyncio.sleep(0)

        return box(*bounds) if bounds else box(0, 0, 0, 0)

    def _process_boundary_chunk(self, streets: List[Dict[str, Any]]) -> tuple:
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
                logger.error("Error computing boundary for a street: %s", e)
        return bounds if bounds else (0, 0, 0, 0)

    def _is_valid_trip(self, gps_data: Any):
        try:
            data = json.loads(gps_data) if isinstance(gps_data, str) else gps_data
            coords = data.get("coordinates", [])
            if len(coords) < 2:
                return False, []
            return True, coords
        except Exception as e:
            logger.error("Error decoding GPS data: %s", e, exc_info=True)
            return False, []

    def is_trip_in_boundary(self, trip: Dict[str, Any]) -> bool:
        try:
            gps_data = trip.get("gps")
            if not gps_data:
                return False
            valid, coords = self._is_valid_trip(gps_data)
            if not valid:
                return False
            return self.boundary_box.intersects(LineString(coords))
        except Exception as e:
            logger.error("Error checking boundary for trip %s: %s", trip.get("_id"), e)
            return False

    def _process_trip_sync(self, coords):
        """
        Process a single trip's coordinates synchronously.
        This method uses Shapely operations which release the GIL internally.
        """
        covered = set()
        try:
            trip_line = LineString(coords)
            if len(trip_line.coords) < 2:
                return covered

            trip_line_utm = transform(self.project_to_utm, trip_line)
            trip_buffer = trip_line_utm.buffer(self.match_buffer)
            trip_buffer_wgs84 = transform(self.project_to_wgs84, trip_buffer)

            for idx in list(self.streets_index.intersection(trip_buffer_wgs84.bounds)):
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

    async def process_trip_batch(self, trips: List[Dict[str, Any]]):
        """
        Process a batch of trips using chunked processing.
        Each chunk is processed using asyncio.to_thread since Shapely operations release the GIL.
        """
        # Prepare trip coordinates for parallel processing
        trip_coords = []
        for trip in trips:
            if self.boundary_box and self.is_trip_in_boundary(trip):
                gps_data = trip.get("gps")
                if gps_data:
                    valid, coords = self._is_valid_trip(gps_data)
                    if valid:
                        trip_coords.append(coords)

        if trip_coords:
            # Process trips in chunks to avoid memory issues
            chunk_size = 100  # Process 100 trips at a time
            for i in range(0, len(trip_coords), chunk_size):
                chunk = trip_coords[i : i + chunk_size]
                try:
                    # Process the chunk synchronously since we can't pickle the rtree index
                    for coords in chunk:
                        covered = await asyncio.to_thread(
                            self._process_trip_sync, coords
                        )
                        for seg in covered:
                            self.covered_segments.add(seg)
                            self.segment_coverage[seg] += 1
                except Exception as e:
                    logger.error("Error processing trip chunk: %s", e, exc_info=True)

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
        await asyncio.sleep(0)

    async def compute_coverage(self) -> Optional[Dict[str, Any]]:
        try:
            await self.update_progress(
                "initializing", 0, "Starting coverage calculation..."
            )
            await ensure_street_coverage_indexes()

            # Initialize projections asynchronously
            await self.initialize()

            await self.update_progress("loading_streets", 10, "Loading street data...")
            streets = await streets_collection.find(
                {"properties.location": self.location.get("display_name")}
            ).to_list(length=None)
            if not streets:
                msg = "No streets found for location"
                logger.warning(msg)
                await self.update_progress("error", 0, msg)
                return None

            await self.update_progress("indexing", 20, "Building spatial index...")
            await self.build_spatial_index(streets)
            self.boundary_box = await self.calculate_boundary_box(streets)

            await self.update_progress("counting_trips", 30, "Counting trips...")
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

            self.total_trips = await trips_collection.count_documents(trip_filter)
            await self.update_progress(
                "processing_trips",
                40,
                f"Processing {self.total_trips} trips...",
            )

            batch = []
            cursor = trips_collection.aggregate([{"$match": trip_filter}])
            async for trip in cursor:
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

            # Clean up the process pool
            self.process_pool.shutdown()

            await self.update_progress(
                "finalizing", 95, "Calculating final coverage..."
            )
            covered_length = 0.0
            features = []
            for street in streets:
                seg_id = street["properties"].get("segment_id")
                geom = shape(street["geometry"])
                street_utm = transform(self.project_to_utm, geom)
                seg_length = street_utm.length

                is_covered = seg_id in self.covered_segments
                if is_covered:
                    covered_length += seg_length

                feature = {
                    "type": "Feature",
                    "geometry": street["geometry"],
                    "properties": {
                        **street["properties"],
                        "driven": is_covered,
                        "coverage_count": self.segment_coverage.get(seg_id, 0),
                        "segment_length": seg_length,
                        "segment_id": seg_id,
                    },
                }
                features.append(feature)

            coverage_percentage = (
                (covered_length / self.total_length * 100)
                if self.total_length > 0
                else 0
            )

            await self.update_progress("complete", 100, "Coverage calculation complete")
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
    calc = CoverageCalculator(location, task_id)
    return await calc.compute_coverage()


async def update_coverage_for_all_locations() -> None:
    """
    Iterate all coverage_metadata docs, run coverage calculation for each location.
    """
    try:
        logger.info("Starting coverage update for all locations...")
        cursor = coverage_metadata_collection.find({}, {"location": 1, "_id": 1})
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
                            "coverage_percentage": result["coverage_percentage"],
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
        logger.error("Error updating coverage for all locations: %s", e, exc_info=True)
