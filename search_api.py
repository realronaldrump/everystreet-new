"""
Search API for places, addresses, and streets.

Provides endpoints for geocoding searches and street lookups with self-
hosted Nominatim via a centralized GeocodingService.
"""

import logging
from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query

from street_coverage.models import CoverageArea, CoverageState, Street
from external_geo_service import GeocodingService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/search", tags=["search"])

# Shared geo service instance
_geo_service = GeocodingService()


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
    Search for places, addresses, or streets using self-hosted Nominatim.

    Args:
        query: Search query string
        limit: Maximum number of results to return
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

    logger.debug("Geocoding search for: %s", query)

    try:
        proximity = None
        if proximity_lon is not None and proximity_lat is not None:
            proximity = (proximity_lon, proximity_lat)

        results = await _geo_service.forward_geocode(
            query,
            limit,
            proximity,
        )

        logger.info("Found %d results for query: %s", len(results), query)
    except Exception as e:
        logger.exception("Error processing geocoding search")
        raise HTTPException(status_code=500, detail=str(e)) from e
    else:
        return {"results": results, "query": query}


@router.get("/streets")
async def search_streets(
    query: Annotated[str, Query(description="Street name to search for")],
    location_id: Annotated[
        PydanticObjectId | None,
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
        new_area = await CoverageArea.get(location_id) if location_id else None
        if not new_area:
            logger.warning("Coverage area not found: %s", location_id)
            return []

        location_name = new_area.display_name

        # Query Street by area_id and street_name, then join with CoverageState for driven status
        driven_segment_ids = set()
        async for state in CoverageState.find(
            CoverageState.area_id == location_id,
            CoverageState.status == "driven",
        ):
            driven_segment_ids.add(state.segment_id)

        # Build results grouped by street name
        street_groups: dict[str, dict] = {}
        async for street in Street.find(
            Street.area_id == location_id,
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
            street_groups[name]["total_length"] += street.length_miles * 5280  # to feet
            street_groups[name]["segment_count"] += 1
            if street.segment_id in driven_segment_ids:
                street_groups[name]["driven_count"] += 1

        features = []
        for street_name, data in list(street_groups.items())[:limit]:
            coordinates = [
                geom.get("coordinates", [])
                for geom in data["geometries"]
                if geom.get("type") == "LineString"
            ]

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
            "Found %d unique streets matching '%s' in %s",
            len(features),
            query,
            location_name,
        )
    except Exception as e:
        logger.exception("Error in search_streets")
        raise HTTPException(status_code=500, detail=str(e)) from e
    else:
        return features
