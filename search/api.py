"""
Search API for places, addresses, and streets.

Provides endpoints for geocoding searches and street lookups with self-
hosted Nominatim via a centralized GeocodingService.
"""

import logging
from typing import Annotated, Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query

from core.api import api_route
from search.services.search_service import SearchService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/geocode", response_model=dict[str, Any])
@api_route(logger)
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
    try:
        return await SearchService.geocode_search(
            query,
            limit,
            proximity_lon,
            proximity_lat,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Error processing geocoding search")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/streets", response_model=list[dict[str, Any]])
@api_route(logger)
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
    try:
        return await SearchService.search_streets(query, location_id, limit)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Error in search_streets")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
