import logging
from datetime import datetime, timezone
import json
import pyproj
from shapely.geometry import shape, box, LineString
from shapely.ops import transform
import rtree
from collections import defaultdict
import asyncio
from typing import Optional, Dict, Any, List, Tuple, Set
from dotenv import load_dotenv

# Import database collections and functions from db.py
from db import (
    streets_collection,
    trips_collection,
    coverage_metadata_collection,
    progress_collection,
    ensure_street_coverage_indexes,
)

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Coordinate reference systems and transformers
wgs84 = pyproj.CRS("EPSG:4326")


class CoverageCalculator:
    def __init__(self, location: Dict[str, Any], task_id: str):
        self.location = location
        self.task_id = task_id
        self.streets_index = rtree.index.Index()
        self.streets_lookup = {}
        self.utm_proj = None
        self.project_to_utm = None
        self.project_to_wgs84 = None
        self.match_buffer = 15.0  # meters
        self.min_match_length = 5.0  # meters
        self.batch_size = 1000  # Increased batch size for better performance
        self.initialize_projections()
        self.boundary_box = None
        self.total_length = 0.0
        self.covered_segments = set()
        self.segment_coverage = defaultdict(int)
        self.total_trips = 0
        self.processed_trips = 0

    async def update_progress(
        self, stage: str, progress: float, message: str = "", error: str = ""
    ):
        """Update progress in MongoDB with more detailed information"""
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
                "covered_segments": (
                    len(self.covered_segments)
                    if hasattr(self, "covered_segments")
                    else 0
                ),
            }
            if error:
                update_data["error"] = error
            await progress_collection.update_one(
                {"_id": self.task_id},
                {"$set": update_data},
                upsert=True,
            )
        except Exception as e:
            logger.error("Error updating progress: %s", e)

    def initialize_projections(self):
        """Initialize UTM projection based on location center"""
        center_lat, center_lon = self._get_location_center()
        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"

        self.utm_proj = pyproj.CRS(
            f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84"
        )
        self.project_to_utm = pyproj.Transformer.from_crs(
            wgs84, self.utm_proj, always_xy=True
        ).transform
        self.project_to_wgs84 = pyproj.Transformer.from_crs(
            self.utm_proj, wgs84, always_xy=True
        ).transform

    def _get_location_center(self) -> Tuple[float, float]:
        """Extract center point from location's bounding box or use default"""
        if "boundingbox" in self.location:
            bbox = self.location["boundingbox"]
            return (
                (float(bbox[0]) + float(bbox[1])) / 2,
                (float(bbox[2]) + float(bbox[3])) / 2,
            )
        return 0.0, 0.0

    def build_spatial_index(self, streets: List[Dict[str, Any]]):
        """Build R-tree spatial index for streets and calculate total length"""
        logger.info("Building spatial index for streets...")
        for idx, street in enumerate(streets):
            try:
                geom = shape(street["geometry"])
                bounds = geom.bounds
                self.streets_index.insert(idx, bounds)
                self.streets_lookup[idx] = street

                street_utm = transform(self.project_to_utm, geom)
                self.total_length += street_utm.length
            except Exception as e:
                logger.error("Error indexing street: %s", e)

    async def process_trip_batch(self, trips: List[Dict[str, Any]]) -> None:
        """Process a batch of trips efficiently"""
        tasks = [
            self.process_single_trip(trip)
            for trip in trips
            if self.is_trip_in_boundary(trip)
        ]

        if tasks:
            results = await asyncio.gather(*tasks)
            for segments in results:
                self.covered_segments.update(segments)
                for segment_id in segments:
                    self.segment_coverage[segment_id] += 1

        self.processed_trips += len(trips)
        progress = (
            self.processed_trips / self.total_trips * 100
            if self.total_trips > 0
            else 0
        )
        await self.update_progress(
            "processing_trips",
            progress,
            f"Processed {self.processed_trips} of {self.total_trips} trips",
        )

    def is_trip_in_boundary(self, trip: Dict[str, Any]) -> bool:
        """Quick check if trip intersects boundary box"""
        try:
            gps_data = trip.get("gps")
            if not gps_data:
                return False

            coords = (
                json.loads(gps_data)["coordinates"]
                if isinstance(gps_data, str)
                else gps_data["coordinates"]
            )
            return self.boundary_box.intersects(LineString(coords))
        except (KeyError, json.JSONDecodeError):
            return False
        except Exception as e:
            logger.error("Error checking trip boundary: %s", e)
            return False

    async def process_single_trip(self, trip: Dict[str, Any]) -> Set[str]:
        """Process a single trip and return covered segment IDs"""
        try:
            gps_data = trip.get("gps")
            if not gps_data or "coordinates" not in (
                coords := (
                    json.loads(gps_data)
                    if isinstance(gps_data, str)
                    else gps_data
                )
            ):
                return set()

            trip_line = LineString(coords["coordinates"])
            trip_line_utm = transform(self.project_to_utm, trip_line)
            trip_buffer = trip_line_utm.buffer(self.match_buffer)

            trip_buffer_wgs84 = transform(self.project_to_wgs84, trip_buffer)
            covered = set()

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
                    covered.add(street["properties"]["segment_id"])

            return covered
        except Exception as e:
            logger.error("Error processing trip: %s", e, exc_info=True)
            return set()

    async def compute_coverage(self) -> Optional[Dict[str, Any]]:
        """Compute street coverage for the location using improved spatial matching."""
        try:
            await self.update_progress(
                "initializing", 0, "Starting coverage calculation..."
            )

            await ensure_street_coverage_indexes()
            await self.update_progress(
                "loading_streets", 10, "Loading street data..."
            )

            # Query all street segments for the location
            streets = await streets_collection.find(
                {"properties.location": self.location.get("display_name")}
            ).to_list(length=None)

            if not streets:
                logger.warning("No streets found for location")
                await self.update_progress(
                    "error", 0, "No streets found for location"
                )
                return None

            # Build spatial index and calculate boundary
            await self.update_progress(
                "indexing", 20, "Building spatial index..."
            )
            self.build_spatial_index(streets)
            self.boundary_box = self.calculate_boundary_box(streets)

            # Process trips in larger batches
            await self.update_progress(
                "counting_trips", 30, "Counting trips..."
            )

            # Use MongoDB aggregation to get trips within the boundary box
            bbox = self.boundary_box.bounds
            pipeline = [
                {
                    "$match": {
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
                }
            ]

            # Count total trips first
            self.total_trips = await trips_collection.count_documents(
                pipeline[0]["$match"]
            )
            await self.update_progress(
                "processing_trips",
                40,
                f"Processing {self.total_trips} trips...",
            )

            batch = []
            async for trip in trips_collection.aggregate(pipeline):
                batch.append(trip)
                if len(batch) >= self.batch_size:
                    await self.process_trip_batch(batch)
                    batch = []
                    # Update progress after each batch
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

            # Calculate covered length and prepare features
            await self.update_progress(
                "finalizing", 95, "Calculating final coverage..."
            )
            covered_length = 0.0
            features = []

            for street in streets:
                segment_id = street["properties"]["segment_id"]
                is_covered = segment_id in self.covered_segments

                if is_covered:
                    geom = shape(street["geometry"])
                    street_utm = transform(self.project_to_utm, geom)
                    covered_length += street_utm.length

                feature = {
                    "type": "Feature",
                    "geometry": street["geometry"],
                    "properties": {
                        **street["properties"],
                        "driven": is_covered,
                        "coverage_count": self.segment_coverage[segment_id],
                        "length": street_utm.length if is_covered else 0,
                        "segment_id": segment_id,
                    },
                }
                features.append(feature)

            # Calculate coverage percentage
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

    @staticmethod
    def calculate_boundary_box(streets: List[Dict[str, Any]]) -> box:
        """Calculate the boundary box containing all streets"""
        bounds = None
        for street in streets:
            geom = shape(street["geometry"])
            if bounds is None:
                bounds = list(geom.bounds)
            else:
                bounds[0] = min(bounds[0], geom.bounds[0])
                bounds[1] = min(bounds[1], geom.bounds[1])
                bounds[2] = max(bounds[2], geom.bounds[2])
                bounds[3] = max(bounds[3], geom.bounds[3])
        return box(*bounds) if bounds else box(0, 0, 0, 0)


async def compute_coverage_for_location(
    location: Dict[str, Any],
    task_id: str,
) -> Optional[Dict[str, Any]]:
    """
    Compute street coverage for a given validated location.
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
            if not loc:
                continue
            if isinstance(loc, str):
                logger.warning(
                    "Skipping coverage doc %s - invalid location format",
                    doc["_id"],
                )
                continue

            task_id = f"bulk_update_{str(doc['_id'])}"
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
