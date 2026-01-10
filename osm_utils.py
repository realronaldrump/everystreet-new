"""OpenStreetMap (OSM) utilities for boundary and streets GeoJSON."""

import asyncio
import json
import logging
import math
from datetime import UTC, datetime
from typing import Any

import geopandas as gpd
import osmnx as ox
from shapely.geometry import box, shape
from shapely.geometry.base import BaseGeometry

from db import (find_one_with_retry, insert_one_with_retry,
                osm_data_collection, update_one_with_retry)

logger = logging.getLogger(__name__)

ox.settings.log_console = False
ox.settings.use_cache = True
ox.settings.timeout = 300

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

EXCLUDED_SERVICE_TYPES = {
    "parking_aisle",
    "driveway",
}


def _to_value_set(value: Any) -> set[str]:
    """Normalize tag values to a set of strings."""
    if value is None:
        return set()
    if isinstance(value, float) and math.isnan(value):
        return set()
    if isinstance(value, list | tuple | set):
        values = set()
        for item in value:
            if item is None:
                continue
            if isinstance(item, float) and math.isnan(item):
                continue
            values.add(str(item))
        return values
    return {str(value)}


def _is_drivable_street(tags: dict[str, Any]) -> bool:
    """Check if a street feature should be included as drivable."""
    highway_values = _to_value_set(tags.get("highway"))
    if not highway_values:
        return False
    if highway_values & EXCLUDED_HIGHWAY_TYPES:
        return False
    if _to_value_set(tags.get("access")) & EXCLUDED_ACCESS_TYPES:
        return False
    if _to_value_set(tags.get("service")) & EXCLUDED_SERVICE_TYPES:
        return False
    if "yes" in _to_value_set(tags.get("area")):
        return False
    if "no" in _to_value_set(tags.get("motor_vehicle")):
        return False
    if "no" in _to_value_set(tags.get("motorcar")):
        return False
    return "no" not in _to_value_set(tags.get("vehicle"))


def _shape_from_geojson(geojson: dict[str, Any]) -> BaseGeometry | None:
    """Convert GeoJSON geometry/feature into a shapely geometry."""
    try:
        if geojson.get("type") == "Feature":
            geojson = geojson.get("geometry") or {}
        elif geojson.get("type") == "FeatureCollection":
            features = geojson.get("features") or []
            if features:
                geojson = features[0].get("geometry") or {}
        if not geojson:
            return None
        geom = shape(geojson)
        if not geom.is_valid:
            geom = geom.buffer(0)
        return geom if not geom.is_empty else None
    except Exception:
        return None


def _boundary_from_location(location: dict[str, Any]) -> BaseGeometry | None:
    """Build a boundary geometry from cached GeoJSON or bounding box data."""
    for key in ("geojson", "geometry"):
        geojson = location.get(key)
        if isinstance(geojson, dict):
            geom = _shape_from_geojson(geojson)
            if geom is not None:
                return geom

    bbox = location.get("boundingbox")
    if bbox and len(bbox) >= 4:
        try:
            min_lat, max_lat, min_lon, max_lon = map(float, bbox[:4])
            return box(min_lon, min_lat, max_lon, max_lat)
        except Exception:
            return None

    return None


async def _geocode_location_gdf(location: dict[str, Any]) -> gpd.GeoDataFrame | None:
    queries: list[Any] = []
    osm_id = location.get("osm_id")
    osm_type = location.get("osm_type")
    osm_prefix = {"relation": "R", "way": "W", "node": "N"}.get(osm_type)
    if osm_id and osm_prefix:
        queries.append({"osm_ids": f"{osm_prefix}{osm_id}"})
        queries.append({"osm_id": osm_id, "osm_type": osm_type})
    if location.get("display_name"):
        queries.append(location["display_name"])

    last_error: Exception | None = None
    for query in queries:
        try:
            gdf = await asyncio.to_thread(ox.geocode_to_gdf, query)
        except Exception as exc:
            last_error = exc
            logger.debug("OSMnx geocode failed for %s: %s", query, exc)
            continue
        if gdf is not None and not gdf.empty:
            return gdf
    if last_error is not None:
        logger.warning(
            "OSMnx geocode failed for %s: %s",
            location.get("display_name", "unknown location"),
            last_error,
        )
    return None


def _features_from_geometry(gdf: gpd.GeoDataFrame) -> dict[str, Any]:
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    return json.loads(gdf.to_json())


async def generate_geojson_osm(
    location: dict[str, Any],
    streets_only: bool = False,
) -> tuple[dict | None, str | None]:
    """Generate boundary or street GeoJSON using OSMnx."""
    try:
        if not isinstance(location, dict):
            return None, "Invalid location data format"

        osm_type_label = "streets" if streets_only else "boundary"
        location_name = location.get("display_name", "Unknown")

        boundary_geom = _boundary_from_location(location)
        if boundary_geom is None:
            boundary_gdf = await _geocode_location_gdf(location)
            if boundary_gdf is None or boundary_gdf.empty:
                return None, "Unable to resolve boundary geometry"
            boundary_geom = boundary_gdf.geometry.iloc[0]

        if streets_only:
            gdf = await asyncio.to_thread(
                ox.features_from_polygon,
                boundary_geom,
                {"highway": True},
            )
            if gdf.empty:
                logger.warning(
                    "No street features found for %s",
                    location_name,
                )
                return {"type": "FeatureCollection", "features": []}, None

            gdf = gdf[gdf.geometry.notnull()]
            gdf = gdf[
                gdf.geometry.type.isin(
                    [
                        "LineString",
                        "MultiLineString",
                    ]
                )
            ]
            gdf = gdf[
                gdf.apply(
                    lambda row: _is_drivable_street(
                        {k: v for k, v in row.items() if k != "geometry"}
                    ),
                    axis=1,
                )
            ]
        else:
            gdf = gpd.GeoDataFrame(
                [
                    {
                        "display_name": location_name,
                        "osm_id": location.get("osm_id"),
                        "osm_type": location.get("osm_type"),
                    }
                ],
                geometry=[boundary_geom],
                crs="EPSG:4326",
            )

        if gdf.empty:
            return {"type": "FeatureCollection", "features": []}, None

        geojson_data = _features_from_geometry(gdf)

        try:
            bson_size_estimate = len(json.dumps(geojson_data).encode("utf-8"))
            if bson_size_estimate <= 16793598:
                existing_data = await find_one_with_retry(
                    osm_data_collection,
                    {"location": location, "type": osm_type_label},
                )

                if existing_data:
                    await update_one_with_retry(
                        osm_data_collection,
                        {"_id": existing_data["_id"]},
                        {
                            "$set": {
                                "geojson": geojson_data,
                                "updated_at": datetime.now(UTC),
                            }
                        },
                    )
                    logger.info(
                        "Updated cached OSM data for %s, type: %s",
                        location_name,
                        osm_type_label,
                    )
                else:
                    await insert_one_with_retry(
                        osm_data_collection,
                        {
                            "location": location,
                            "type": osm_type_label,
                            "geojson": geojson_data,
                            "created_at": datetime.now(UTC),
                            "updated_at": datetime.now(UTC),
                        },
                    )
                    logger.info(
                        "Stored OSM data to cache for %s, type: %s",
                        location_name,
                        osm_type_label,
                    )
            else:
                logger.warning(
                    "OSM data for %s (%s) is too large (%d bytes) to cache in MongoDB.",
                    location_name,
                    osm_type_label,
                    bson_size_estimate,
                )
        except Exception as db_error:
            logger.error(
                "Error interacting with OSM data cache: %s",
                db_error,
                exc_info=True,
            )

        return geojson_data, None

    except Exception as e:
        logger.exception("Unexpected error generating GeoJSON: %s", e)
        return None, f"Unexpected error generating GeoJSON: {e!s}"
