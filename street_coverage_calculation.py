from motor.motor_asyncio import AsyncIOMotorClient
import logging
from datetime import datetime, timezone
import json
import pyproj
from shapely.geometry import shape, box, LineString, Point
from shapely.ops import transform
import rtree
import os
from collections import defaultdict
import asyncio
from typing import Optional, Dict, Any, List, Tuple, Set
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Database setup using Motor (asynchronous)

MONGO_URI = os.getenv("MONGO_URI")
client = AsyncIOMotorClient(MONGO_URI, tz_aware=True)
db = client["every_street"]
streets_collection = db["streets"]
matched_trips_collection = db["matched_trips"]
coverage_metadata_collection = db["coverage_metadata"]

# Coordinate reference systems and transformers
wgs84 = pyproj.CRS("EPSG:4326")


class CoverageCalculator:
    def __init__(self, location: Dict[str, Any]):
        self.location = location
        self.streets_index = rtree.index.Index()
        self.streets_lookup = {}
        self.utm_proj = None
        self.project_to_utm = None
        self.project_to_wgs84 = None
        self.match_buffer = 15  # meters
        self.min_match_length = 5  # meters
        self.batch_size = 100  # Process trips in batches
        self.initialize_projections()

    def initialize_projections(self):
        """Initialize UTM projection based on location center"""
        if "boundingbox" in self.location:
            bbox = self.location["boundingbox"]
            center_lat = (float(bbox[0]) + float(bbox[1])) / 2
            center_lon = (float(bbox[2]) + float(bbox[3])) / 2
        else:
            # Default to a central point if no bounding box
            center_lat = 0
            center_lon = 0

        # Calculate UTM zone
        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"

        # Create UTM projection
        self.utm_proj = pyproj.CRS(
            f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84"
        )

        # Create transformers
        self.project_to_utm = pyproj.Transformer.from_crs(
            wgs84, self.utm_proj, always_xy=True
        ).transform
        self.project_to_wgs84 = pyproj.Transformer.from_crs(
            self.utm_proj, wgs84, always_xy=True
        ).transform

    def build_spatial_index(self, streets: List[Dict[str, Any]]):
        """Build R-tree spatial index for streets"""
        logger.info("Building spatial index for streets...")
        for idx, street in enumerate(streets):
            try:
                geom = shape(street["geometry"])
                bounds = geom.bounds
                self.streets_index.insert(idx, bounds)
                self.streets_lookup[idx] = street
            except Exception as e:
                logger.error(f"Error indexing street: {e}")

    async def process_matched_trips_batch(
        self, trips: List[Dict[str, Any]], boundary_box: box
    ) -> Set[str]:
        """Process a batch of matched trips concurrently"""
        covered_segments = set()

        # Create tasks for each trip in the batch
        tasks = []
        for trip in trips:
            if self.is_trip_in_boundary(trip, boundary_box):
                tasks.append(self.process_matched_trip(trip))

        # Execute all tasks concurrently
        if tasks:
            results = await asyncio.gather(*tasks)
            for segments in results:
                covered_segments.update(segments)

        return covered_segments

    def is_trip_in_boundary(self, trip: Dict[str, Any], boundary_box: box) -> bool:
        """Quick check if trip intersects boundary box"""
        try:
            matched_gps = trip.get("matchedGps")
            if isinstance(matched_gps, str):
                matched_gps = json.loads(matched_gps)

            if not matched_gps or "coordinates" not in matched_gps:
                return False

            coords = matched_gps["coordinates"]
            # Check if any point is within the boundary box
            return any(boundary_box.contains(Point(coord)) for coord in coords)
        except Exception:
            return False

    async def process_matched_trip(self, trip: Dict[str, Any]) -> Set[str]:
        """Process a single matched trip and return covered segment IDs"""
        try:
            matched_gps = trip.get("matchedGps")
            if isinstance(matched_gps, str):
                matched_gps = json.loads(matched_gps)

            if not matched_gps or "coordinates" not in matched_gps:
                return set()

            # Convert to UTM for accurate distance calculations
            coords = matched_gps["coordinates"]
            trip_line = LineString(coords)
            trip_line_utm = transform(self.project_to_utm, trip_line)

            # Buffer the trip line for matching
            trip_buffer = trip_line_utm.buffer(self.match_buffer)

            # Convert buffer back to WGS84 for spatial query
            trip_buffer_wgs84 = transform(self.project_to_wgs84, trip_buffer)

            covered_segments = set()

            # Query potentially intersecting streets using R-tree
            for idx in self.streets_index.intersection(trip_buffer_wgs84.bounds):
                street = self.streets_lookup[idx]
                street_geom = shape(street["geometry"])
                street_utm = transform(self.project_to_utm, street_geom)

                # Check for significant intersection
                intersection = trip_buffer.intersection(street_utm)
                if not intersection.is_empty:
                    intersection_length = intersection.length
                    if intersection_length >= self.min_match_length:
                        covered_segments.add(
                            street["properties"]["segment_id"])

            return covered_segments

        except Exception as e:
            logger.error(f"Error processing matched trip: {e}", exc_info=True)
            return set()

    async def compute_coverage(self) -> Optional[Dict[str, Any]]:
        """
        Compute street coverage for the location using improved spatial matching.
        """
        try:
            # Query all street segments for the location
            streets = await streets_collection.find(
                {"properties.location": self.location.get("display_name")}
            ).to_list(length=None)

            if not streets:
                logger.warning("No streets found for location")
                return None

            # Build spatial index and calculate boundary
            self.build_spatial_index(streets)
            boundary_box = self.calculate_boundary_box(streets)

            # Initialize coverage tracking
            total_length = 0
            covered_length = 0
            # Track coverage count per segment
            segment_coverage = defaultdict(int)

            # Calculate total length in UTM coordinates for accuracy
            for street in streets:
                geom = shape(street["geometry"])
                street_utm = transform(self.project_to_utm, geom)
                total_length += street_utm.length

            # Process matched trips in batches
            logger.info("Processing matched trips...")
            batch = []
            covered_segments_set = set()

            async for trip in matched_trips_collection.find(
                {"matchedGps": {"$exists": True}}
            ):
                batch.append(trip)
                if len(batch) >= self.batch_size:
                    new_segments = await self.process_matched_trips_batch(
                        batch, boundary_box
                    )
                    covered_segments_set.update(new_segments)
                    batch = []

            # Process remaining trips
            if batch:
                new_segments = await self.process_matched_trips_batch(
                    batch, boundary_box
                )
                covered_segments_set.update(new_segments)

            # Update coverage counts
            for segment_id in covered_segments_set:
                segment_coverage[segment_id] += 1

            # Calculate covered length and prepare features
            features = []
            for street in streets:
                segment_id = street["properties"]["segment_id"]
                geom = shape(street["geometry"])
                street_utm = transform(self.project_to_utm, geom)
                is_covered = segment_coverage[segment_id] > 0

                if is_covered:
                    covered_length += street_utm.length

                feature = {
                    "type": "Feature",
                    "geometry": street["geometry"],
                    "properties": {
                        **street["properties"],
                        "driven": is_covered,
                        "coverage_count": segment_coverage[segment_id],
                        "length": street_utm.length,
                        "segment_id": segment_id,
                    },
                }
                features.append(feature)

            # Calculate coverage percentage
            coverage_percentage = (
                (covered_length / total_length * 100) if total_length > 0 else 0
            )

            return {
                "total_length": total_length,
                "driven_length": covered_length,
                "coverage_percentage": coverage_percentage,
                "streets_data": {
                    "type": "FeatureCollection",
                    "features": features,
                    "metadata": {
                        "total_length_miles": total_length * 0.000621371,
                        "driven_length_miles": covered_length * 0.000621371,
                        "coverage_percentage": coverage_percentage,
                    },
                },
            }

        except Exception as e:
            logger.error(f"Error computing coverage: {e}", exc_info=True)
            return None

    def calculate_boundary_box(self, streets: List[Dict[str, Any]]) -> box:
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
) -> Optional[Dict[str, Any]]:
    """
    Compute street coverage for a given validated location.
    """
    calculator = CoverageCalculator(location)
    return await calculator.compute_coverage()


async def update_coverage_for_all_locations() -> None:
    """
    Update street coverage for all locations.
    """
    try:
        logger.info("Starting coverage update for all locations...")
        cursor = coverage_metadata_collection.find(
            {}, {"location": 1, "_id": 1})

        async for doc in cursor:
            loc = doc.get("location")
            if not loc:
                continue
            if isinstance(loc, str):
                logger.warning(
                    f"Skipping coverage doc {doc['_id']} - invalid location format"
                )
                continue

            result = await compute_coverage_for_location(loc)
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
                    f"Updated coverage for {display_name}: {result['coverage_percentage']:.2f}%"
                )
        logger.info("Finished coverage update for all locations.")
    except Exception as e:
        logger.error(
            f"Error updating coverage for all locations: {e}", exc_info=True)
