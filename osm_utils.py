"""OpenStreetMap (OSM) Utilities Module.

Provides functions for interacting with the Overpass API to fetch and process
OSM data, specifically for generating GeoJSON representations of boundaries and
streets.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
import geopandas as gpd
from shapely.geometry import LineString, Polygon

from db import (
    find_one_with_retry,
    insert_one_with_retry,
    osm_data_collection,
    update_one_with_retry,
)

logger = logging.getLogger(__name__)

OVERPASS_URL = "http://overpass-api.de/api/interpreter"

EXCLUDED_HIGHWAY_TYPES_REGEX = (
    "footway|path|steps|pedestrian|bridleway|cycleway|corridor|"
    "platform|raceway|proposed|construction|track"
)


async def process_elements(elements: list[dict], streets_only: bool) -> list[dict]:
    """Process OSM elements and convert them to GeoJSON features.

    Args:
        elements: List of OSM elements
        streets_only: If True, only include street elements (already pre-filtered)

    Returns:
        List of GeoJSON features
    """
    features = []
    for e in elements:
        if e["type"] == "way":
            geometry = e.get("geometry", [])
            if not geometry:
                logger.debug(
                    "Skipping way %s: No geometry data",
                    e.get("id"),
                )
                continue

            coords = [(n["lon"], n["lat"]) for n in geometry]
            if len(coords) >= 2:
                properties = e.get("tags", {})
                try:
                    if streets_only:
                        line = LineString(coords)
                        features.append(
                            {
                                "type": "Feature",
                                "geometry": line.__geo_interface__,
                                "properties": properties,
                            }
                        )
                    else:
                        if coords[0] == coords[-1]:
                            poly = Polygon(coords)
                            features.append(
                                {
                                    "type": "Feature",
                                    "geometry": poly.__geo_interface__,
                                    "properties": properties,
                                }
                            )
                        else:
                            line = LineString(coords)
                            features.append(
                                {
                                    "type": "Feature",
                                    "geometry": line.__geo_interface__,
                                    "properties": properties,
                                }
                            )
                except Exception as shape_error:
                    logger.warning(
                        "Error creating shape for way %s: %s",
                        e.get("id"),
                        shape_error,
                    )
                    continue
            else:
                logger.debug(
                    "Skipping way %s: Needs at least 2 coordinates, found %d",
                    e.get("id"),
                    len(coords),
                )

    return features


async def generate_geojson_osm(
    location: dict[str, Any],
    streets_only: bool = False,
) -> tuple[dict | None, str | None]:
    """Generate GeoJSON data from OpenStreetMap for a location.

    Filters out non-vehicular ways if streets_only is True.

    Args:
        location: Dictionary with location data (must contain osm_id, osm_type)
        streets_only: If True, only include streets, otherwise fetch boundary

    Returns:
        Tuple of (GeoJSON data, error message)
    """
    try:
        if not (
            isinstance(location, dict)
            and "osm_id" in location
            and "osm_type" in location
        ):
            return (
                None,
                "Invalid location data format",
            )

        osm_type_label = "streets" if streets_only else "boundary"
        area_id = int(location["osm_id"])

        if location["osm_type"] == "relation":
            area_id += 3600000000

        if streets_only:
            query = f"""
            [out:json][timeout:60];
            area({area_id})->.searchArea;
            (
              // Fetch ways with highway tag, EXCLUDING specified non-vehicular types
              way["highway"]["highway"!~"{EXCLUDED_HIGHWAY_TYPES_REGEX}"](area.searchArea);
            );
            (._;>;); // Recurse down to nodes
            out geom; // Output geometry
            """
            logger.info("Using Overpass query that excludes non-vehicular ways.")
        else:
            query = f"""
            [out:json][timeout:60];
            (
              {location["osm_type"]}({location["osm_id"]});
            );
            (._;>;); // Recurse down to nodes
            out geom; // Output geometry
            """

        logger.info(
            "Querying Overpass for %s: %s",
            osm_type_label,
            location.get("display_name", "Unknown"),
        )

        async with aiohttp.ClientSession() as session:
            async with session.get(
                OVERPASS_URL,
                params={"data": query},
                timeout=90,
            ) as response:
                response.raise_for_status()
                data = await response.json()

        features = await process_elements(data.get("elements", []), streets_only)

        if not features:
            logger.warning(
                "No features found for %s: %s (potentially due to filters or empty area)",
                osm_type_label,
                location.get("display_name", "Unknown"),
            )
            return {
                "type": "FeatureCollection",
                "features": [],
            }, None

        gdf = gpd.GeoDataFrame.from_features(features)
        if "geometry" not in gdf.columns and features:
            gdf = gdf.set_geometry(
                gpd.GeoSeries.from_features(features, crs="EPSG:4326")["geometry"]
            )
        elif "geometry" in gdf.columns:
            gdf = gdf.set_geometry("geometry")

        if gdf.crs is None:
            gdf.crs = "EPSG:4326"

        geojson_data = json.loads(gdf.to_json())

        try:
            bson_size_estimate = len(json.dumps(geojson_data).encode("utf-8"))
            if bson_size_estimate <= 16793598:
                existing_data = await find_one_with_retry(
                    osm_data_collection,
                    {
                        "location": location,
                        "type": osm_type_label,
                    },
                )

                if existing_data:
                    await update_one_with_retry(
                        osm_data_collection,
                        {"_id": existing_data["_id"]},
                        {
                            "$set": {
                                "geojson": geojson_data,
                                "updated_at": datetime.now(timezone.utc),
                            }
                        },
                    )
                    logger.info(
                        "Updated cached OSM data for %s, type: %s",
                        location.get(
                            "display_name",
                            "Unknown",
                        ),
                        osm_type_label,
                    )
                else:
                    await insert_one_with_retry(
                        osm_data_collection,
                        {
                            "location": location,
                            "type": osm_type_label,
                            "geojson": geojson_data,
                            "created_at": datetime.now(timezone.utc),
                            "updated_at": datetime.now(timezone.utc),
                        },
                    )
                    logger.info(
                        "Stored OSM data to cache for %s, type: %s",
                        location.get(
                            "display_name",
                            "Unknown",
                        ),
                        osm_type_label,
                    )
            else:
                logger.warning(
                    "OSM data for %s (%s) is too large (%d bytes) to cache in MongoDB.",
                    location.get("display_name", "Unknown"),
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

    except aiohttp.ClientResponseError as http_err:
        error_detail = f"Overpass API error: {http_err.status} - {http_err.message}"
        logger.error(error_detail, exc_info=True)
        try:
            error_body = await http_err.response.text()
            logger.error(
                "Overpass error body: %s",
                error_body[:500],
            )
        except Exception:
            pass
        return None, error_detail
    except aiohttp.ClientError as client_err:
        error_detail = f"Error communicating with Overpass API: {str(client_err)}"
        logger.error(error_detail, exc_info=True)
        return None, error_detail
    except Exception as e:
        error_detail = f"Unexpected error generating GeoJSON: {str(e)}"
        logger.exception(error_detail)
        return None, error_detail
