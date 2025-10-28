"""Search API for places, addresses, and streets.

Provides endpoints for geocoding searches and street lookups with
support for Nominatim (OSM) and Mapbox geocoding services.
"""

import logging
from typing import Any

import aiohttp
from fastapi import APIRouter, HTTPException, Query

from config import MAPBOX_ACCESS_TOKEN
from db import (
    coverage_metadata_collection,
    find_one_with_retry,
    streets_collection,
)
from bson import ObjectId

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
        False, description="Use Mapbox geocoding instead of Nominatim"
    ),
):
    """Search for places, addresses, or streets using geocoding services.

    Args:
        query: Search query string
        limit: Maximum number of results to return
        use_mapbox: Use Mapbox Geocoding API instead of Nominatim

    Returns:
        List of geocoding results with coordinates and metadata

    """
    if not query or len(query.strip()) < 2:
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters")

    logger.info("Geocoding search for: %s (use_mapbox=%s)", query, use_mapbox)

    try:
        if use_mapbox and MAPBOX_ACCESS_TOKEN:
            results = await _search_mapbox(query, limit)
        else:
            results = await _search_nominatim(query, limit)

        logger.info("Found %d results for query: %s", len(results), query)
        return {"results": results, "query": query}

    except aiohttp.ClientError as e:
        logger.error("Geocoding API error: %s", str(e), exc_info=True)
        raise HTTPException(
            status_code=503, detail="Geocoding service temporarily unavailable"
        ) from e
    except Exception as e:
        logger.error("Error processing geocoding search: %s", str(e), exc_info=True)
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
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters")

    query_lower = query.strip().lower()
    logger.info(
        "Street search for: %s (location_id=%s)", query_lower, location_id
    )

    try:
        features: list[dict] = []

        # If location_id provided, search within that coverage area
        if location_id:
            features = await _search_streets_in_coverage(
                query_lower, location_id, limit
            )

        # If no results from coverage area search, try geocoding for street
        if not features:
            geocode_results = await _search_nominatim(
                query, limit, addressdetails=True
            )

            # Filter for street-like results and return simple points
            for result in geocode_results:
                place_type = result.get("type", "")
                if place_type in {"residential", "road", "highway", "street"}:
                    try:
                        features.append(
                            {
                                "type": "Feature",
                                "geometry": {
                                    "type": "Point",
                                    "coordinates": [
                                        float(result["lon"]),
                                        float(result["lat"]),
                                    ],
                                },
                                "properties": {
                                    "name": result.get("display_name", ""),
                                    "osm_id": result.get("osm_id"),
                                    "osm_type": result.get("osm_type"),
                                    "type": result.get("type"),
                                    "address": result.get("address", {}),
                                    "search_result": True,
                                },
                            }
                        )
                    except Exception:
                        continue

        logger.info("Found %d street results for: %s", len(features), query)

        return {
            "type": "FeatureCollection",
            "features": features[:limit],
            "query": query,
        }

    except Exception as e:
        logger.error("Error searching streets: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/streets/{location_id}/{street_name}")
async def get_street_geometry(location_id: str, street_name: str):
    """Get full geometry for a specific street in a coverage area.

    Args:
        location_id: Coverage area ID
        street_name: Name of the street

    Returns:
        GeoJSON FeatureCollection with matching street geometries

    """
    logger.info(
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

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error getting street geometry: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


# --- Helper Functions ---


async def _search_nominatim(
    query: str, limit: int = 5, addressdetails: bool = True
) -> list[dict[str, Any]]:
    """Search using Nominatim (OpenStreetMap) geocoding API.

    Args:
        query: Search query
        limit: Maximum results
        addressdetails: Include address details in results

    Returns:
        List of geocoding results

    """
    params = {
        "q": query,
        "format": "json",
        "limit": limit,
        "addressdetails": 1 if addressdetails else 0,
    }

    async with aiohttp.ClientSession() as session:
        async with session.get(
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


async def _search_mapbox(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Search using Mapbox Geocoding API.

    Args:
        query: Search query
        limit: Maximum results

    Returns:
        List of geocoding results

    """
    if not MAPBOX_ACCESS_TOKEN:
        logger.warning("Mapbox token not configured, falling back to Nominatim")
        return await _search_nominatim(query, limit)

    url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json"
    params = {"access_token": MAPBOX_ACCESS_TOKEN, "limit": limit}

    async with aiohttp.ClientSession() as session:
        async with session.get(url, params=params, timeout=10) as response:
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


async def _search_streets_in_coverage(
    query: str, location_id: str, limit: int = 10
) -> list[dict[str, Any]]:
    """Search for streets within a specific coverage area.

    Args:
        query: Street name query (lowercase)
        location_id: Coverage area ID
        limit: Maximum results

    Returns:
        List of GeoJSON features for matching streets

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
        logger.warning(
            "Coverage area %s missing display_name in location", location_id
        )
        return []

    # Query streets collection for matching street_name within this location
    # Use case-insensitive regex match, limit fields for efficiency
    cursor = streets_collection.find(
        {
            "properties.location": location_name,
            "properties.street_name": {"$regex": query, "$options": "i"},
        },
        {
            "_id": 0,
            "geometry": 1,
            "properties.segment_id": 1,
            "properties.street_name": 1,
            "properties.highway": 1,
            "properties.segment_length": 1,
            "properties.driven": 1,
            "properties.undriveable": 1,
        },
    ).limit(limit)

    features = await cursor.to_list(length=limit)

    logger.info(
        "Found %d streets matching '%s' in location %s",
        len(features),
        query,
        location_id,
    )

    return features

