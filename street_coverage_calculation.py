import logging
from datetime import datetime, timezone
import json
import numpy as np
import pyproj
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import shape, box
import os

from dotenv import load_dotenv
from typing import Optional, Dict, Any

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Database setup using Motor (asynchronous)
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URI = os.getenv("MONGO_URI")
client = AsyncIOMotorClient(MONGO_URI, tz_aware=True)
db = client["every_street"]
streets_collection = db["streets"]
matched_trips_collection = db["matched_trips"]
coverage_metadata_collection = db["coverage_metadata"]

# Coordinate reference systems and transformers
wgs84 = pyproj.CRS("EPSG:4326")
# Define a default UTM projection (adjust the EPSG code as needed)
default_utm = pyproj.CRS("EPSG:32610")
project_to_utm = pyproj.Transformer.from_crs(
    wgs84, default_utm, always_xy=True
).transform
project_to_wgs84 = pyproj.Transformer.from_crs(
    default_utm, wgs84, always_xy=True
).transform


async def compute_coverage_for_location(
    location: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """
    Compute street coverage for a given validated location using a raster‐based method.

    The function attempts to determine the boundary polygon for the area based on the location’s
    bounding box (or provided GeoJSON boundary) or, if missing, by querying road segments using
    the location’s display name. It then:
      - Queries road segments (from streets_collection) that intersect the boundary.
      - Rasterizes those segments and also rasterizes map‐matched trips (from matched_trips_collection)
        whose “matchedGps” field intersects the boundary.
      - Computes the total length (in meters) of road pixels, the driven length (meters)
        where map‐matched trips overlap road segments, and the coverage percentage.
      - Returns a dictionary with keys: total_length, driven_length, coverage_percentage, and
        raster_dimensions (nrows and ncols), or None on failure.
    """
    try:
        # STEP 1: Determine the boundary polygon for the area.
        if "boundingbox" in location:
            # Nominatim typically returns boundingbox as [south, north, west, east]
            bbox = location["boundingbox"]
            try:
                south = float(bbox[0])
                north = float(bbox[1])
                west = float(bbox[2])
                east = float(bbox[3])
            except Exception as e:
                logger.error("Error parsing bounding box: " + str(e))
                return None
            boundary_polygon = {
                "type": "Polygon",
                "coordinates": [
                    [
                        [west, south],
                        [east, south],
                        [east, north],
                        [west, north],
                        [west, south],
                    ]
                ],
            }
        elif "geojson" in location:
            boundary_polygon = location["geojson"]
        else:
            logger.warning(
                "No bounding box or geojson provided in location data; falling back to string matching using display_name."
            )
            road_segments = await streets_collection.find(
                {"properties.location": location.get("display_name")}, {"_id": 0}
            ).to_list(length=None)
            if not road_segments:
                return None
            bounds = None
            for seg in road_segments:
                try:
                    geom = shape(seg["geometry"])
                except Exception as e:
                    logger.warning(f"Skipping a segment due to geometry error: {e}")
                    continue
                if bounds is None:
                    bounds = list(geom.bounds)  # [minx, miny, maxx, maxy]
                else:
                    bounds[0] = min(bounds[0], geom.bounds[0])
                    bounds[1] = min(bounds[1], geom.bounds[1])
                    bounds[2] = max(bounds[2], geom.bounds[2])
                    bounds[3] = max(bounds[3], geom.bounds[3])
            if bounds is None:
                return None
            boundary_polygon = {
                "type": "Polygon",
                "coordinates": [
                    [
                        [bounds[0], bounds[1]],
                        [bounds[2], bounds[1]],
                        [bounds[2], bounds[3]],
                        [bounds[0], bounds[3]],
                        [bounds[0], bounds[1]],
                    ]
                ],
            }

        # STEP 2: Query road segments by spatial intersection.
        road_segments = await streets_collection.find(
            {"geometry": {"$geoIntersects": {"$geometry": boundary_polygon}}},
            {"_id": 0},
        ).to_list(length=None)
        if not road_segments:
            logger.warning("No road segments found for the given area.")
            return None

        # Compute the union bounding box of these road segments.
        bounds = None
        for seg in road_segments:
            try:
                geom = shape(seg["geometry"])
            except Exception as e:
                logger.warning("Skipping segment due to geometry error: " + str(e))
                continue
            if bounds is None:
                bounds = list(geom.bounds)
            else:
                bounds[0] = min(bounds[0], geom.bounds[0])
                bounds[1] = min(bounds[1], geom.bounds[1])
                bounds[2] = max(bounds[2], geom.bounds[2])
                bounds[3] = max(bounds[3], geom.bounds[3])
        if bounds is None:
            return None

        # STEP 3: Set up raster parameters.
        from shapely.geometry import box
        from affine import Affine

        bounds_box = box(*bounds)
        centroid = bounds_box.centroid

        # Determine UTM zone (assumes northern hemisphere)
        utm_zone = int((centroid.x + 180) / 6) + 1
        epsg_code = 32600 + utm_zone
        proj_to_utm = pyproj.Transformer.from_crs(
            "EPSG:4326", f"EPSG:{epsg_code}", always_xy=True
        ).transform

        minx_utm, miny_utm = proj_to_utm(bounds[0], bounds[1])
        maxx_utm, maxy_utm = proj_to_utm(bounds[2], bounds[3])
        width_m = maxx_utm - minx_utm
        height_m = maxy_utm - miny_utm

        resolution_m = 5  # 5-meter cells
        ncols = int(np.ceil(width_m / resolution_m))
        nrows = int(np.ceil(height_m / resolution_m))
        transform_affine = Affine.translation(minx_utm, maxy_utm) * Affine.scale(
            resolution_m, -resolution_m
        )

        # STEP 4: Rasterize the road segments.
        import rasterio
        from rasterio.features import rasterize
        import shapely.ops

        road_shapes = []
        for seg in road_segments:
            try:
                geom = shape(seg["geometry"])
            except Exception as e:
                logger.warning("Skipping segment during rasterization: " + str(e))
                continue
            projected_geom = shapely.ops.transform(proj_to_utm, geom)
            road_shapes.append((projected_geom, 1))
        road_raster = rasterize(
            shapes=road_shapes,
            out_shape=(nrows, ncols),
            transform=transform_affine,
            fill=0,
            all_touched=True,
            dtype="uint8",
        )
        total_road_pixels = int(np.sum(road_raster == 1))
        logger.info(f"Total road pixels: {total_road_pixels}")

        # STEP 5: Rasterize the driven (map‐matched) trips.
        matched_trips = await matched_trips_collection.find(
            {"matchedGps": {"$geoIntersects": {"$geometry": boundary_polygon}}}
        ).to_list(length=None)
        if matched_trips:
            driven_shapes = []
            for trip in matched_trips:
                try:
                    gps = trip.get("matchedGps")
                    if isinstance(gps, str):
                        gps = json.loads(gps)
                    geom = shape(gps)
                    projected_geom = shapely.ops.transform(proj_to_utm, geom)
                    driven_shapes.append((projected_geom, 1))
                except Exception as e:
                    logger.warning(
                        "Skipping a trip during driven rasterization: " + str(e)
                    )
            driven_raster = rasterize(
                shapes=driven_shapes,
                out_shape=(nrows, ncols),
                transform=transform_affine,
                fill=0,
                all_touched=True,
                dtype="uint8",
            )
        else:
            driven_raster = np.zeros((nrows, ncols), dtype="uint8")
        driven_road_pixels = int(np.sum((road_raster == 1) & (driven_raster == 1)))
        coverage_percentage = (
            (driven_road_pixels / total_road_pixels * 100)
            if total_road_pixels > 0
            else 0.0
        )
        logger.info(
            f"Driven road pixels: {driven_road_pixels}, Coverage: {coverage_percentage:.2f}%"
        )

        # STEP 6: Compute approximate lengths (each pixel represents resolution_m meters).
        total_length = int(total_road_pixels * resolution_m)
        driven_length = int(driven_road_pixels * resolution_m)

        return {
            "total_length": total_length,
            "driven_length": driven_length,
            "coverage_percentage": coverage_percentage,
            "raster_dimensions": {"nrows": int(nrows), "ncols": int(ncols)},
        }
    except Exception as e:
        logger.error(f"Error computing coverage for location: {e}", exc_info=True)
        return None


async def update_coverage_for_all_locations() -> None:
    """
    Periodically updates street coverage for all locations using the new raster‐based method.
    Iterates through each document in the coverage_metadata_collection, computes the coverage,
    and updates the document with the new data.
    """
    try:
        logger.info(
            "Starting periodic street coverage update for all locations (raster-based)..."
        )
        cursor = coverage_metadata_collection.find({}, {"location": 1, "_id": 1})
        async for doc in cursor:
            loc = doc.get("location")
            if not loc:
                continue
            if isinstance(loc, str):
                logger.warning(
                    f"Skipping coverage doc {doc['_id']} because location is a string: {loc}"
                )
                continue

            result = await compute_coverage_for_location(loc)
            if result:
                display_name = loc.get("display_name", "Unknown")
                await coverage_metadata_collection.update_one(
                    {"location.display_name": display_name},
                    {
                        "$set": {
                            "location": loc,  # use the full location dictionary
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
        logger.info("Finished periodic street coverage update (raster-based).")
    except Exception as e:
        logger.error(f"Error updating coverage for all locations: {e}", exc_info=True)
