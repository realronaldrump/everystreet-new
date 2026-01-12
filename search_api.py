"""
Search API for places, addresses, and streets.

Provides endpoints for geocoding searches and street lookups with support for Nominatim
(OSM) and Mapbox geocoding services via centralized ExternalGeoService.
"""

import logging
from typing import Annotated, Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query

from config import get_mapbox_token
from coverage.models import CoverageArea, CoverageState, Street
from db.models import CoverageMetadata
from external_geo_service import ExternalGeoService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/search", tags=["search"])

# Shared geo service instance (uses cached token)
_geo_service = ExternalGeoService(get_mapbox_token())


@router.get("/geocode")
async def geocode_search(
    query: Annotated[
        str,
        Query(description="Search query (place, address, or street)"),
    ],
    limit: Annotated[
        int,
        Query(ge=1, le=20, description="Maximum number of results"),
    ] = 5,
    use_mapbox: Annotated[
        bool | None,
        Query(
            description="Force Mapbox geocoding (True) or Nominatim (False). Default prefers Mapbox if configured.",
        ),
    ] = None,
    proximity_lon: Annotated[
        float | None,
        Query(description="Longitude to bias results toward"),
    ] = None,
    proximity_lat: Annotated[
        float | None,
        Query(description="Latitude to bias results toward"),
    ] = None,
):
    """
    Search for places, addresses, or streets using geocoding services.

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
            status_code=400,
            detail="Query must be at least 2 characters",
        )

    logger.debug("Geocoding search for: %s (use_mapbox=%s)", query, use_mapbox)

    try:
        proximity = None
        if proximity_lon is not None and proximity_lat is not None:
            proximity = (proximity_lon, proximity_lat)

        results = await _geo_service.forward_geocode(
            query,
            limit,
            proximity,
            prefer_mapbox=use_mapbox,
        )

        logger.info("Found %d results for query: %s", len(results), query)
        return {"results": results, "query": query}
    except Exception as e:
        logger.error("Error processing geocoding search: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/streets")
async def search_streets(
    query: Annotated[str, Query(description="Street name to search for")],
    location_id: Annotated[
        str | None,
        Query(description="Optional coverage area ID to search within"),
    ] = None,
    limit: Annotated[
        int,
        Query(ge=1, le=50, description="Maximum number of results"),
    ] = 10,
):
    """
    Search for streets by name, optionally within a coverage area.

    Args:
        query: Street name query
        location_id: Optional coverage area to search within
        limit: Maximum number of results

    Returns:
        GeoJSON FeatureCollection of matching streets
    """
    if not query or len(query.strip()) < 2:
        raise HTTPException(
            status_code=400,
            detail="Query must be at least 2 characters",
        )

    try:
        # Try new CoverageArea model first
        area_id = PydanticObjectId(location_id) if location_id else None
        new_area = await CoverageArea.get(area_id) if area_id else None
        use_new_schema = new_area is not None

        if use_new_schema:
            location_name = new_area.display_name

            # New schema: query Street by area_id and street_name
            # Then join with CoverageState for driven status
            driven_segment_ids = set()
            async for state in CoverageState.find(
                CoverageState.area_id == area_id,
                CoverageState.status == "driven",
            ):
                driven_segment_ids.add(state.segment_id)

            # Build results grouped by street name
            street_groups: dict[str, dict] = {}
            async for street in Street.find(
                Street.area_id == area_id,
                Street.area_version == new_area.area_version,
                Street.street_name != None,  # noqa: E711
            ):
                name = street.street_name
                if not name or query.lower() not in name.lower():
                    continue

                if name not in street_groups:
                    street_groups[name] = {
                        "geometries": [],
                        "highway": street.highway_type,
                        "total_length": 0.0,
                        "segment_count": 0,
                        "driven_count": 0,
                    }

                street_groups[name]["geometries"].append(street.geometry)
                street_groups[name]["total_length"] += (
                    street.length_miles * 5280
                )  # to feet
                street_groups[name]["segment_count"] += 1
                if street.segment_id in driven_segment_ids:
                    street_groups[name]["driven_count"] += 1

            features = []
            for street_name, data in list(street_groups.items())[:limit]:
                coordinates = []
                for geom in data["geometries"]:
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
                                "street_name": street_name,
                                "location": location_name,
                                "highway": data["highway"],
                                "segment_count": data["segment_count"],
                                "total_length": data["total_length"],
                                "driven_count": data["driven_count"],
                            },
                        },
                    )

            logger.debug(
                "Found %d unique streets matching '%s' in %s (new schema)",
                len(features),
                query,
                location_name,
            )
            return features
        else:
            # Fall back to old CoverageMetadata schema
            coverage_area = await CoverageMetadata.get(location_id)

            if not coverage_area or not coverage_area.location:
                logger.warning("Coverage area not found: %s", location_id)
                return []

            location_name = coverage_area.location.get("display_name")
            if not location_name:
                logger.warning(
                    "Coverage area %s missing display_name in location",
                    location_id,
                )
                return []

            pipeline = [
                {
                    "$match": {
                        "properties.location": location_name,
                        "properties.street_name": {"$regex": query, "$options": "i"},
                    },
                },
                {
                    "$group": {
                        "_id": "$properties.street_name",
                        "geometries": {"$push": "$geometry"},
                        "highway": {"$first": "$properties.highway"},
                        "total_length": {"$sum": "$properties.segment_length"},
                        "segment_count": {"$sum": 1},
                        "driven_count": {
                            "$sum": {"$cond": ["$properties.driven", 1, 0]}
                        },
                    },
                },
                {"$limit": limit},
            ]

            # Use Beanie Street.aggregate()
            grouped_streets = await Street.aggregate(pipeline).to_list()

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
                                "location": location_name,
                                "highway": street.get("highway"),
                                "segment_count": street.get("segment_count", 0),
                                "total_length": street.get("total_length", 0),
                                "driven_count": street.get("driven_count", 0),
                            },
                        },
                    )

            logger.debug(
                "Found %d unique streets (from segments) matching '%s' across all locations",
                len(features),
                query,
            )
            return features
    except Exception as e:
        logger.exception("Error in search_streets: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


async def _search_streets_in_coverage(
    query: str,
    location_id: str,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """
    Search for streets within a specific coverage area, grouping segments by street
    name.

    Args:
        query: Street name query (lowercase)
        location_id: Coverage area ID
        limit: Maximum results (applies to unique street names, not segments)

    Returns:
        List of GeoJSON features with combined geometries per street name
    """
    try:
        # Try new CoverageArea model first
        area_id = PydanticObjectId(location_id)
        new_area = await CoverageArea.get(area_id)
        use_new_schema = new_area is not None

        if use_new_schema:
            location_name = new_area.display_name

            # New schema: query Street by area_id and street_name
            # Then join with CoverageState for driven status
            driven_segment_ids = set()
            async for state in CoverageState.find(
                CoverageState.area_id == area_id,
                CoverageState.status == "driven",
            ):
                driven_segment_ids.add(state.segment_id)

            # Build results grouped by street name
            street_groups: dict[str, dict] = {}
            async for street in Street.find(
                Street.area_id == area_id,
                Street.street_name != None,  # noqa: E711
            ):
                name = street.street_name
                if not name or query.lower() not in name.lower():
                    continue

                if name not in street_groups:
                    street_groups[name] = {
                        "geometries": [],
                        "highway": street.highway_type,
                        "total_length": 0.0,
                        "segment_count": 0,
                        "driven_count": 0,
                    }

                street_groups[name]["geometries"].append(street.geometry)
                street_groups[name]["total_length"] += street.length_miles * 5280
                street_groups[name]["segment_count"] += 1
                if street.segment_id in driven_segment_ids:
                    street_groups[name]["driven_count"] += 1

            features = []
            for street_name, data in list(street_groups.items())[:limit]:
                coordinates = []
                for geom in data["geometries"]:
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
                                "street_name": street_name,
                                "location": location_name,
                                "highway": data["highway"],
                                "segment_count": data["segment_count"],
                                "total_length": data["total_length"],
                                "driven_count": data["driven_count"],
                            },
                        },
                    )

            return features
        else:
            # Fall back to old CoverageMetadata schema
            coverage_area = await CoverageMetadata.get(location_id)

            if not coverage_area or not coverage_area.location:
                logger.warning("Coverage area not found: %s", location_id)
                return []

            location_name = coverage_area.location.get("display_name")
            if not location_name:
                logger.warning(
                    "Coverage area %s missing display_name in location",
                    location_id,
                )
                return []

            pipeline = [
                {
                    "$match": {
                        "properties.location": location_name,
                        "properties.street_name": {"$regex": query, "$options": "i"},
                    },
                },
                {
                    "$group": {
                        "_id": "$properties.street_name",
                        "geometries": {"$push": "$geometry"},
                        "highway": {"$first": "$properties.highway"},
                        "total_length": {"$sum": "$properties.segment_length"},
                        "segment_count": {"$sum": 1},
                        "driven_count": {
                            "$sum": {"$cond": ["$properties.driven", 1, 0]}
                        },
                    },
                },
                {"$limit": limit},
            ]

            grouped_streets = await Street.aggregate(pipeline).to_list()

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
                                "location": location_name,
                                "highway": street.get("highway"),
                                "segment_count": street.get("segment_count", 0),
                                "total_length": street.get("total_length", 0),
                                "driven_count": street.get("driven_count", 0),
                            },
                        },
                    )

            return features
    except Exception:
        logger.exception("Error in _search_streets_in_coverage for %s", location_id)
        return []
