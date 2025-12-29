"""Preprocess streets module.

Fetches OSM street data using OSMnx, segments street geometries, and updates
the database. Uses OSMnx for robust Overpass API handling and automatic
UTM projection.
"""

import asyncio
import contextlib
import gc
import logging
from datetime import UTC, datetime
from typing import Any

import osmnx as ox
from pymongo.errors import BulkWriteError
from shapely.geometry import LineString, box, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import substring as shapely_substring

from db import (
    coverage_metadata_collection,
    find_with_retry,
    progress_collection,
    streets_collection,
    update_many_with_retry,
    update_one_with_retry,
)
from geometry_service import GeometryService
from progress_tracker import ProgressTracker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Configure OSMnx settings
ox.settings.log_console = False
ox.settings.use_cache = True
ox.settings.timeout = 300

SEGMENT_LENGTH_METERS_DEFAULT = 500
BATCH_SIZE = 1000

# Highway types to exclude (non-drivable)
EXCLUDED_HIGHWAY_TYPES = {
    "footway",
    "path",
    "steps",
    "pedestrian",
    "bridleway",
    "cycleway",
    "corridor",
    "platform",
    "raceway",
    "proposed",
    "construction",
    "track",
    "service",
    "alley",
    "driveway",
    "parking_aisle",
}

# Access types that indicate private/restricted roads
EXCLUDED_ACCESS_TYPES = {
    "private",
    "no",
    "customers",
    "delivery",
    "agricultural",
    "forestry",
    "destination",
    "permit",
}


def _is_drivable_street(tags: dict[str, Any]) -> bool:
    """Check if a street is drivable based on its OSM tags."""
    highway = tags.get("highway", "")
    if highway in EXCLUDED_HIGHWAY_TYPES:
        return False

    access = tags.get("access", "")
    if access in EXCLUDED_ACCESS_TYPES:
        return False

    service = tags.get("service", "")
    if service in {"parking_aisle", "driveway"}:
        return False

    if tags.get("motor_vehicle") == "no":
        return False
    if tags.get("motorcar") == "no":
        return False
    if tags.get("vehicle") == "no":
        return False
    return tags.get("area") != "yes"


def segment_street(
    line: LineString,
    segment_length_meters: float = SEGMENT_LENGTH_METERS_DEFAULT,
) -> list[LineString]:
    """Split a linestring into segments of approximately segment_length_meters."""
    segments = []
    total_length = line.length
    if total_length <= segment_length_meters + 1e-6:
        return [line]

    start_distance = 0.0
    while start_distance < total_length - 1e-6:
        end_distance = min(start_distance + segment_length_meters, total_length)
        try:
            seg = shapely_substring(
                line, start_distance, end_distance, normalized=False
            )
            if seg is not None and seg.length > 1e-6:
                segments.append(seg)
        except Exception as e:
            logger.warning("Failed to create segment: %s", e)
        start_distance = end_distance

    return segments if segments else [line]


def _process_street_feature(
    geometry: BaseGeometry,
    tags: dict[str, Any],
    osm_id: int,
    location_name: str,
    boundary_polygon: BaseGeometry | None,
    segment_length_meters: float,
) -> list[dict[str, Any]]:
    """Process a single street feature into segmented database documents."""
    features = []

    if geometry.is_empty or not geometry.is_valid:
        return features

    # Handle MultiLineString by extracting individual lines
    if geometry.geom_type == "MultiLineString":
        lines = list(geometry.geoms)
    elif geometry.geom_type == "LineString":
        lines = [geometry]
    else:
        return features

    highway_type = tags.get("highway", "unknown")

    for line in lines:
        if line.length < 1e-6:
            continue

        # Clip to boundary if provided
        if boundary_polygon:
            if not line.intersects(boundary_polygon):
                continue
            clipped = line.intersection(boundary_polygon)
            if clipped.is_empty:
                continue
            if clipped.geom_type == "MultiLineString":
                sub_lines = list(clipped.geoms)
            elif clipped.geom_type == "LineString":
                sub_lines = [clipped]
            else:
                continue
        else:
            sub_lines = [line]

        for sub_line in sub_lines:
            if sub_line.length < 1e-6:
                continue

            # Segment the line
            segments = segment_street(sub_line, segment_length_meters)

            for i, segment in enumerate(segments):
                if segment.length < 1e-6:
                    continue

                geometry = GeometryService.geometry_from_shapely(segment)
                if geometry is None:
                    continue
                feature = GeometryService.feature_from_geometry(
                    geometry,
                    properties={
                        "osm_id": osm_id,
                        "segment_id": f"{osm_id}-{i}",
                        "street_name": tags.get("name", "Unnamed Street"),
                        "highway": highway_type,
                        "location": location_name,
                        "segment_length": segment.length,
                        "driven": False,
                        "undriveable": False,
                        "manual_override": False,
                        "manually_marked_driven": False,
                        "manually_marked_undriven": False,
                        "manually_marked_undriveable": False,
                        "manually_marked_driveable": False,
                        "last_coverage_update": None,
                        "last_manual_update": None,
                        "matched_trips": [],
                        "tags": tags,
                        "segment_length_meters": segment_length_meters,
                    },
                )
                features.append(feature)

    return features


async def _fetch_streets_with_osmnx(
    polygon: BaseGeometry,
    tracker: ProgressTracker,
    location_name: str,
) -> list[dict[str, Any]]:
    """Fetch street data using OSMnx and return filtered features."""
    await tracker.update(
        "preprocessing",
        20,
        f"Fetching OSM street data for {location_name}...",
    )

    try:
        # Fetch street geometries using OSMnx
        # Use graph_from_polygon which is well-suited for street networks
        gdf = await asyncio.to_thread(
            ox.features_from_polygon,
            polygon,
            tags={"highway": True},
        )

        if gdf.empty:
            logger.warning("No street features found for %s", location_name)
            return []

        await tracker.update(
            "preprocessing",
            35,
            f"Retrieved {len(gdf)} raw features, filtering...",
        )

        # Filter to drivable streets
        filtered_features = []
        for idx, row in gdf.iterrows():
            tags = row.to_dict()
            # Remove geometry from tags dict
            tags.pop("geometry", None)

            if not _is_drivable_street(tags):
                continue

            # Extract OSM ID from index (OSMnx uses (type, id) tuple index)
            osm_id = idx[1] if isinstance(idx, tuple) else idx

            filtered_features.append(
                {
                    "osm_id": osm_id,
                    "geometry": row.geometry,
                    "tags": tags,
                }
            )

        logger.info(
            "Filtered to %d drivable streets for %s",
            len(filtered_features),
            location_name,
        )

        return filtered_features

    except Exception as e:
        logger.error("OSMnx fetch failed for %s: %s", location_name, e)
        raise


async def preprocess_streets(
    validated_location: dict[str, Any],
    task_id: str | None = None,
) -> None:
    """Orchestrate the fetching and processing of street data using OSMnx."""
    location_name = validated_location["display_name"]

    # Handle segment length priority:
    # 1. location-specific feet override (converted)
    # 2. default (500ft which is ~152.4m)

    # Default is roughly 500 feet
    final_segment_length = 152.4

    if validated_location.get("segment_length_feet"):
        final_segment_length = float(validated_location["segment_length_feet"]) * 0.3048

    # Create progress tracker
    tracker = ProgressTracker(task_id, progress_collection, location=location_name)

    try:
        logger.info(
            "Starting street preprocessing for %s with segment_length=%.2fm",
            location_name,
            final_segment_length,
        )
        await tracker.update(
            "preprocessing",
            5,
            f"Initializing for {location_name}...",
        )

        # 1. Construct Boundary Shape
        boundary_shape: BaseGeometry | None = None
        if "geojson" in validated_location and validated_location["geojson"]:
            try:
                geojson_data = validated_location["geojson"]
                if isinstance(geojson_data, dict) and geojson_data.get("type") in [
                    "Polygon",
                    "MultiPolygon",
                ]:
                    boundary_shape = shape(geojson_data)
                    if not boundary_shape.is_valid:
                        boundary_shape = boundary_shape.buffer(0)
            except Exception as e:
                logger.error("Error creating boundary shape: %s", e)

        # Fallback to bounding box if no geojson
        if boundary_shape is None:
            bbox = validated_location.get("boundingbox")
            if bbox and len(bbox) >= 4:
                boundary_shape = box(
                    float(bbox[2]),
                    float(bbox[0]),
                    float(bbox[3]),
                    float(bbox[1]),
                )
            else:
                raise ValueError("No valid boundary for location")

        # 2. Update Metadata to "Processing"
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "location": validated_location,
                    "status": "processing",
                    "last_updated": datetime.now(UTC),
                    "last_error": None,
                },
                "$setOnInsert": {
                    "total_length": 0.0,
                    "driven_length": 0.0,
                    "coverage_percentage": 0.0,
                    "total_segments": 0,
                    "created_at": datetime.now(UTC),
                },
            },
            upsert=True,
        )

        # 3. Clear Existing Streets
        await streets_collection.delete_many({"properties.location": location_name})

        # 4. Fetch OSM Data with OSMnx
        street_features = await _fetch_streets_with_osmnx(
            boundary_shape,
            tracker,
            location_name,
        )

        if not street_features:
            logger.warning("No drivable streets found for %s", location_name)
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_name},
                {"$set": {"status": "completed", "total_segments": 0}},
            )
            return

        # 5. Project to UTM for accurate length calculations
        await tracker.update(
            "preprocessing",
            45,
            f"Processing {len(street_features)} streets...",
        )

        # Get CRS for the area (OSMnx provides UTM automatically)
        float(validated_location.get("lat", 0))
        float(validated_location.get("lon", 0))

        # Create a temporary GeoDataFrame for projection
        import geopandas as gpd

        temp_gdf = gpd.GeoDataFrame(
            street_features,
            geometry=[f["geometry"] for f in street_features],
            crs="EPSG:4326",
        )
        temp_gdf_projected = ox.projection.project_gdf(temp_gdf)

        # 6. Segment streets and prepare for database
        total_length = 0.0
        batch_to_insert = []
        total_segments = 0

        for i, (raw_feat, (_, projected_row)) in enumerate(
            zip(street_features, temp_gdf_projected.iterrows(), strict=False)
        ):
            if i % 100 == 0 and i > 0:
                progress = 45 + int((i / len(street_features)) * 40)
                await tracker.update(
                    "preprocessing",
                    progress,
                    f"Segmenting street {i}/{len(street_features)}...",
                )

            # Use projected geometry for segmentation (accurate lengths)
            projected_geom = projected_row.geometry
            original_geom = raw_feat["geometry"]

            segments = _process_street_feature(
                original_geom,  # Use WGS84 for storage
                raw_feat["tags"],
                raw_feat["osm_id"],
                location_name,
                boundary_shape,
                final_segment_length,
            )

            for seg in segments:
                # Calculate length from projected geometry
                seg["properties"]["segment_length"] = projected_geom.length / max(
                    1, len(segments)
                )
                total_length += seg["properties"]["segment_length"]
                batch_to_insert.append(seg)
                total_segments += 1

            # Insert in batches
            if len(batch_to_insert) >= BATCH_SIZE:
                try:
                    await streets_collection.insert_many(batch_to_insert, ordered=False)
                    logger.info("Inserted batch of %d segments", len(batch_to_insert))
                except BulkWriteError as bwe:
                    dup_count = sum(
                        1
                        for e in bwe.details.get("writeErrors", [])
                        if e.get("code") == 11000
                    )
                    if dup_count:
                        logger.warning("Skipped %d duplicates", dup_count)
                batch_to_insert = []
                gc.collect()

        # Insert remaining
        if batch_to_insert:
            with contextlib.suppress(BulkWriteError):
                await streets_collection.insert_many(batch_to_insert, ordered=False)

        # 7. Update coverage metadata
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "location": validated_location,
                    "total_length": total_length,
                    "total_segments": total_segments,
                    "last_updated": datetime.now(UTC),
                    "status": "completed",
                    "last_error": None,
                },
            },
            upsert=True,
        )

        logger.info(
            "Processed %d segments (%.1f mi) for %s",
            total_segments,
            total_length * 0.000621371,
            location_name,
        )

        await tracker.update(
            "preprocessing",
            95,
            f"Completed: {total_segments} segments for {location_name}",
        )

        # 8. Preserve manual overrides
        await _reapply_manual_overrides(location_name)

    except Exception as e:
        logger.error("Preprocessing failed for %s: %s", location_name, e, exc_info=True)
        await tracker.fail(
            str(e),
            f"Preprocessing failed: {e}",
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {"$set": {"status": "error", "last_error": str(e)}},
        )
        raise

    finally:
        gc.collect()


async def _reapply_manual_overrides(location_name: str) -> None:
    """Reapply manual street overrides after reprocessing."""
    try:
        override_docs = await find_with_retry(
            streets_collection,
            {
                "properties.location": location_name,
                "$or": [
                    {"properties.manual_override": True},
                    {"properties.manually_marked_driven": True},
                    {"properties.manually_marked_undriven": True},
                    {"properties.manually_marked_undriveable": True},
                    {"properties.manually_marked_driveable": True},
                    {"properties.undriveable": True},
                ],
            },
            {
                "geometry": 1,
                "properties.manual_override": 1,
                "properties.manually_marked_driven": 1,
                "properties.manually_marked_undriven": 1,
                "properties.manually_marked_undriveable": 1,
                "properties.manually_marked_driveable": 1,
                "properties.undriveable": 1,
            },
        )

        if not override_docs:
            return

        for doc in override_docs:
            geomspec = doc.get("geometry")
            if not geomspec:
                continue

            props = doc.get("properties", {})
            set_updates = {}

            if props.get("undriveable"):
                set_updates["properties.undriveable"] = True
            if props.get("manual_override"):
                set_updates["properties.manual_override"] = True
            if props.get("manually_marked_driven"):
                set_updates.update(
                    {
                        "properties.manually_marked_driven": True,
                        "properties.driven": True,
                        "properties.manual_override": True,
                    }
                )

            if set_updates:
                await update_many_with_retry(
                    streets_collection,
                    {
                        "properties.location": location_name,
                        "geometry": {"$geoIntersects": {"$geometry": geomspec}},
                    },
                    {"$set": set_updates},
                )

        logger.info("Re-applied manual overrides for %s", location_name)

    except Exception as e:
        logger.warning("Failed to reapply overrides: %s", e)
