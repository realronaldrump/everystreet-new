"""Search API for places, addresses, and streets.

Provides endpoints for geocoding searches and street lookups with
support for Nominatim (OSM) and Mapbox geocoding services.
"""

import logging
from typing import Any

import aiohttp
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query

from config import MAPBOX_ACCESS_TOKEN
from db import (
    aggregate_with_retry,
    coverage_metadata_collection,
    find_one_with_retry,
    streets_collection,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/search", tags=["search"])

# Nominatim (OpenStreetMap) geocoding endpoint
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_HEADERS = {
    "User-Agent": "EveryStreet/1.0",
}


@router.get("/geocode")
async def geocode_search(
    query: str = Query(..., description="Search query (place, address, or street)"),
    limit: int = Query(5, ge=1, le=20, description="Maximum number of results"),
    use_mapbox: bool = Query(
        None,
        description="Force Mapbox geocoding (True) or Nominatim (False). Default prefers Mapbox if configured.",
    ),
    proximity_lon: float = Query(None, description="Longitude to bias results toward"),
    proximity_lat: float = Query(None, description="Latitude to bias results toward"),
):
    """Search for places, addresses, or streets using geocoding services.

    Args:
        query: Search query string
        limit: Maximum number of results to return
        use_mapbox: Use Mapbox Geocoding API instead of Nominatim
        proximity_lon: Longitude to bias results toward (optional)
        proximity_lat: Latitude to bias results toward (optional)

    Returns:
        List of geocoding results with coordinates and metadata

    """
    if not query or len(query.strip()) < 2:
        raise HTTPException(
            status_code=400, detail="Query must be at least 2 characters"
        )

    logger.debug("Geocoding search for: %s (use_mapbox=%s)", query, use_mapbox)

    try:
        # Prepare proximity parameter if provided
        proximity = None
        if proximity_lon is not None and proximity_lat is not None:
            proximity = (proximity_lon, proximity_lat)

        # Prefer Mapbox if token is configured unless explicitly disabled
        prefer_mapbox = MAPBOX_ACCESS_TOKEN and (
            use_mapbox is None or use_mapbox is True
        )
        if prefer_mapbox:
            results = await _search_mapbox(query, limit, proximity=proximity)
        else:
            results = await _search_nominatim(query, limit, proximity=proximity)

        logger.info("Found %d results for query: %s", len(results), query)
        return {"results": results, "query": query}

    except aiohttp.ClientError as e:
        logger.error("Geocoding API error: %s", e, exc_info=True)
        raise HTTPException(
            status_code=503, detail="Geocoding service temporarily unavailable"
        ) from e
    except Exception as e:
        logger.error("Error processing geocoding search: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/streets")
async def search_streets(
    query: str = Query(..., description="Street name to search for"),
    location_id: str = Query(
        None, description="Optional coverage area ID to search within"
    ),
    limit: int = Query(10, ge=1, le=50, description="Maximum number of results"),
):
    """Search for streets by name, optionally within a coverage area.

    Args:
        query: Street name query
        location_id: Optional coverage area to search within
        limit: Maximum number of results

    Returns:
        GeoJSON FeatureCollection of matching streets

    """
    if not query or len(query.strip()) < 2:
        raise HTTPException(
            status_code=400, detail="Query must be at least 2 characters"
        )

    query_lower = query.strip().lower()
    logger.debug("Street search for: %s (location_id=%s)", query_lower, location_id)

    try:
        features: list[dict] = []

        # If location_id provided, search within that coverage area ONLY
        if location_id:
            features = await _search_streets_in_coverage(
                query_lower, location_id, limit
            )
        else:
            # No location: search ALL coverage areas for streets first
            features = await _search_streets_all_locations(query_lower, limit)

        logger.info("Found %d street results for: %s", len(features), query)

        return {
            "type": "FeatureCollection",
            "features": features[:limit],
            "query": query,
        }

    except Exception as e:
        # Never fail the endpoint due to upstream errors – return empty results
        logger.error("Street search unexpected error: %s", e, exc_info=True)
        return {"type": "FeatureCollection", "features": [], "query": query}


@router.get("/streets/{location_id}/{street_name}")
async def get_street_geometry(location_id: str, street_name: str):
    """Get full geometry for a specific street in a coverage area.

    Args:
        location_id: Coverage area ID
        street_name: Name of the street

    Returns:
        GeoJSON FeatureCollection with matching street geometries

    """
    logger.debug(
        "Getting street geometry for: %s in location %s",
        street_name,
        location_id,
    )

    try:
        features = await _search_streets_in_coverage(
            street_name.lower(), location_id, limit=100
        )

        if not features:
            raise HTTPException(
                status_code=404,
                detail=f"Street '{street_name}' not found in coverage area",
            )

        return {"type": "FeatureCollection", "features": features}

    except Exception as e:
        logger.error("Error getting street geometry: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


# --- Helper Functions ---


async def _search_nominatim(
    query: str,
    limit: int = 5,
    addressdetails: bool = True,
    proximity: tuple[float, float] | None = None,
) -> list[dict[str, Any]]:
    """Search using Nominatim (OpenStreetMap) geocoding API.

    Args:
        query: Search query
        limit: Maximum results
        addressdetails: Include address details in results
        proximity: Optional (longitude, latitude) tuple to bias results toward

    Returns:
        List of geocoding results

    """
    params = {
        "q": query,
        "format": "json",
        "limit": limit,
        "addressdetails": 1 if addressdetails else 0,
        "countrycodes": "us",  # Limit to United States
    }

    # Add viewbox to bias toward US/Texas region
    if proximity:
        # Create a viewbox around the proximity point (approximately 200km radius)
        lon, lat = proximity
        params["viewbox"] = f"{lon - 2},{lat + 2},{lon + 2},{lat - 2}"
        params["bounded"] = 1
    else:
        # Default viewbox covering United States
        params["viewbox"] = (
            "-125,49,-66,24"  # US bounding box (west, north, east, south)
        )

    async with aiohttp.ClientSession() as session, session.get(
        NOMINATIM_URL, params=params, headers=NOMINATIM_HEADERS, timeout=10
    ) as response:
        response.raise_for_status()
        results = await response.json()

        # Normalize the results
        normalized = []
        for result in results:
            normalized.append(
                {
                    "place_name": result.get("display_name", ""),
                    "center": [float(result["lon"]), float(result["lat"])],
                    "place_type": [result.get("type", "unknown")],
                    "text": result.get("name", ""),
                    "osm_id": result.get("osm_id"),
                    "osm_type": result.get("osm_type"),
                    "type": result.get("type"),
                    "lat": result.get("lat"),
                    "lon": result.get("lon"),
                    "display_name": result.get("display_name"),
                    "address": result.get("address", {}),
                    "importance": result.get("importance", 0),
                    "bbox": result.get("boundingbox"),
                }
            )

        return normalized


async def _search_mapbox(
    query: str, limit: int = 5, proximity: tuple[float, float] | None = None
) -> list[dict[str, Any]]:
    """Search using Mapbox Geocoding API.

    Args:
        query: Search query
        limit: Maximum results
        proximity: Optional (longitude, latitude) tuple to bias results toward

    Returns:
        List of geocoding results

    """
    if not MAPBOX_ACCESS_TOKEN:
        logger.warning("Mapbox token not configured, falling back to Nominatim")
        return await _search_nominatim(query, limit, proximity=proximity)

    url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json"
    params = {
        "access_token": MAPBOX_ACCESS_TOKEN,
        "limit": limit,
        "country": "US",  # Limit to United States
    }

    # Add proximity parameter to bias toward user's location (e.g., Texas)
    if proximity:
        params["proximity"] = f"{proximity[0]},{proximity[1]}"
    else:
        # Default to Texas center if no proximity provided
        params["proximity"] = "-99.9018,31.9686"  # Texas center coordinates

    async with aiohttp.ClientSession() as session, session.get(url, params=params, timeout=10) as response:
        response.raise_for_status()
        data = await response.json()

        # Return features directly (already in good format)
        results = []
        for feature in data.get("features", []):
            results.append(
                {
                    "place_name": feature.get("place_name", ""),
                    "center": feature.get("center", []),
                    "place_type": feature.get("place_type", []),
                    "text": feature.get("text", ""),
                    "bbox": feature.get("bbox"),
                    "context": feature.get("context", []),
                }
            )

        return results


async def _search_streets_all_locations(
    query: str, limit: int = 10
) -> list[dict[str, Any]]:
    """Search for streets across all coverage areas, grouping segments by street name.

    Args:
        query: Street name query (lowercase)
        limit: Maximum results (applies to unique street names, not segments)

    Returns:
        List of GeoJSON features with combined geometries per street name

    """
    # Use aggregation to group segments by street_name and location
    pipeline = [
        {
            "$match": {
                "properties.street_name": {"$regex": query, "$options": "i"},
            }
        },
        {
            "$group": {
                "_id": {
                    "street_name": "$properties.street_name",
                    "location": "$properties.location",
                },
                "geometries": {"$push": "$geometry"},
                "highway": {"$first": "$properties.highway"},
                "total_length": {"$sum": "$properties.segment_length"},
                "segment_count": {"$sum": 1},
                "driven_count": {"$sum": {"$cond": ["$properties.driven", 1, 0]}},
            }
        },
        {"$limit": limit},
        {
            "$project": {
                "street_name": "$_id.street_name",
                "location": "$_id.location",
                "geometries": 1,
                "highway": 1,
                "total_length": 1,
                "segment_count": 1,
                "driven_count": 1,
            }
        },
    ]

    grouped_streets = await aggregate_with_retry(
        streets_collection, pipeline, batch_size=limit
    )

    # Convert to GeoJSON features with MultiLineString geometries
    features = []
    for street in grouped_streets:
        # Combine all LineString geometries into a MultiLineString
        coordinates = []
        for geom in street.get("geometries", []):
            if geom.get("type") == "LineString":
                coordinates.append(geom.get("coordinates", []))

        if coordinates:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "MultiLineString",
                        "coordinates": coordinates,
                    },
                    "properties": {
                        "street_name": street.get("street_name"),
                        "location": street.get("location"),
                        "highway": street.get("highway"),
                        "segment_count": street.get("segment_count", 0),
                        "total_length": street.get("total_length", 0),
                        "driven_count": street.get("driven_count", 0),
                    },
                }
            )

    logger.debug(
        "Found %d unique streets (from segments) matching '%s' across all locations",
        len(features),
        query,
    )

    return features


async def _search_streets_in_coverage(
    query: str, location_id: str, limit: int = 10
) -> list[dict[str, Any]]:
    """Search for streets within a specific coverage area, grouping segments by street name.

    Args:
        query: Street name query (lowercase)
        location_id: Coverage area ID
        limit: Maximum results (applies to unique street names, not segments)

    Returns:
        List of GeoJSON features with combined geometries per street name

    """
    # First, verify the coverage area exists and get its display name
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        logger.warning("Invalid location_id format: %s", location_id)
        return []

    coverage_area = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {"location.display_name": 1},
    )

    if not coverage_area or not coverage_area.get("location"):
        logger.warning("Coverage area not found: %s", location_id)
        return []

    location_name = coverage_area["location"].get("display_name")
    if not location_name:
        logger.warning("Coverage area %s missing display_name in location", location_id)
        return []

    # Use aggregation to group segments by street_name
    pipeline = [
        {
            "$match": {
                "properties.location": location_name,
                "properties.street_name": {"$regex": query, "$options": "i"},
            }
        },
        {
            "$group": {
                "_id": "$properties.street_name",
                "geometries": {"$push": "$geometry"},
                "highway": {"$first": "$properties.highway"},
                "total_length": {"$sum": "$properties.segment_length"},
                "segment_count": {"$sum": 1},
                "driven_count": {"$sum": {"$cond": ["$properties.driven", 1, 0]}},
            }
        },
        {"$limit": limit},
        {
            "$project": {
                "street_name": "$_id",
                "geometries": 1,
                "highway": 1,
                "total_length": 1,
                "segment_count": 1,
                "driven_count": 1,
            }
        },
    ]

    grouped_streets = await aggregate_with_retry(
        streets_collection, pipeline, batch_size=limit
    )

    # Convert to GeoJSON features with MultiLineString geometries
    features = []
    for street in grouped_streets:
        # Combine all LineString geometries into a MultiLineString
        coordinates = []
        for geom in street.get("geometries", []):
            if geom.get("type") == "LineString":
                coordinates.append(geom.get("coordinates", []))

        if coordinates:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "MultiLineString",
                        "coordinates": coordinates,
                    },
                    "properties": {
                        "street_name": street.get("street_name"),
                        "location": location_name,
                        "highway": street.get("highway"),
                        "segment_count": street.get("segment_count", 0),
                        "total_length": street.get("total_length", 0),
                        "driven_count": street.get("driven_count", 0),
                    },
                }
            )

    logger.debug(
        "Found %d unique streets (from segments) matching '%s' in location %s",
        len(features),
        query,
        location_id,
    )

    return features
