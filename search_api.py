"""Search API for places, addresses, and streets.

Provides endpoints for geocoding searches and street lookups with
support for Nominatim (OSM) and Mapbox geocoding services via
centralized ExternalGeoService.
"""

import logging
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query

from config import get_mapbox_token
from db import db_manager
from db.models import CoverageMetadata, Street
from external_geo_service import ExternalGeoService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/search", tags=["search"])

# Shared geo service instance (uses cached token)
_geo_service = ExternalGeoService(get_mapbox_token())


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
        proximity = None
        if proximity_lon is not None and proximity_lat is not None:
            proximity = (proximity_lon, proximity_lat)

        results = await _geo_service.forward_geocode(
            query, limit, proximity, prefer_mapbox=use_mapbox
        )

        logger.info("Found %d results for query: %s", len(results), query)
        return {"results": results, "query": query}
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

    try:
        coverage_area = await CoverageMetadata.get(location_id)

        if not coverage_area or not coverage_area.location:
            logger.warning("Coverage area not found: %s", location_id)
            return []

        location_name = coverage_area.location.display_name
        if not location_name:
            logger.warning(
                "Coverage area %s missing display_name in location", location_id
            )
            return []

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
        ]

        streets_collection = db_manager.get_collection("streets")
        grouped_streets = await streets_collection.aggregate(pipeline).to_list(None)

        features = []
        for street in grouped_streets:
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
                            "street_name": street.get("_id"),
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
    except Exception as e:
        logger.error("Error in search_streets: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


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
    try:
        coverage_area = await CoverageMetadata.get(location_id)

        if not coverage_area or not coverage_area.location:
            logger.warning("Coverage area not found: %s", location_id)
            return []

        location_name = coverage_area.location.display_name
        if not location_name:
            logger.warning(
                "Coverage area %s missing display_name in location", location_id
            )
            return []

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
        ]

        streets_collection = db_manager.get_collection("streets")
        grouped_streets = await streets_collection.aggregate(pipeline).to_list(None)

        features = []
        for street in grouped_streets:
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
                            "street_name": street.get("_id"),
                            "location": street.get("location"),
                            "highway": street.get("highway"),
                            "segment_count": street.get("segment_count", 0),
                            "total_length": street.get("total_length", 0),
                            "driven_count": street.get("driven_count", 0),
                        },
                    }
                )

        return features
    except Exception:
        logger.exception("Error in _search_streets_in_coverage for %s", location_id)
        return []
