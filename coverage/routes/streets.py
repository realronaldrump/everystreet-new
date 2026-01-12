"""
Street segment API endpoints.

Provides viewport-based street retrieval for efficient map rendering.
No more loading entire GeoJSON files - streams segments as needed.
"""

import logging
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from coverage.models import CoverageArea, CoverageState, Street
from coverage.constants import MAX_VIEWPORT_FEATURES
from coverage.worker import mark_segment_undriveable, mark_segment_undriven

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["coverage-streets"])


# =============================================================================
# Request/Response Models
# =============================================================================


class StreetFeature(BaseModel):
    """GeoJSON-style street feature for map rendering."""

    type: str = "Feature"
    properties: dict[str, Any]
    geometry: dict[str, Any]


class StreetsResponse(BaseModel):
    """Response containing street features for a viewport."""

    success: bool = True
    features: list[StreetFeature]
    total_in_viewport: int
    truncated: bool = False


class MarkSegmentRequest(BaseModel):
    """Request to mark a segment's status."""

    status: str  # "undriveable" or "undriven"


# =============================================================================
# Endpoints
# =============================================================================


@router.get("/areas/{area_id}/streets", response_model=StreetsResponse)
async def get_streets_in_viewport(
    area_id: str,
    min_lon: float = Query(..., description="Viewport minimum longitude"),
    min_lat: float = Query(..., description="Viewport minimum latitude"),
    max_lon: float = Query(..., description="Viewport maximum longitude"),
    max_lat: float = Query(..., description="Viewport maximum latitude"),
):
    """
    Get street segments within a map viewport.

    Returns GeoJSON-style features with coverage status for each segment.
    Limited to MAX_VIEWPORT_FEATURES (5000) to prevent browser overload.

    Usage:
    - Call this when the map viewport changes
    - Features include 'status' property: 'undriven', 'driven', 'undriveable'
    - Render segments with appropriate colors based on status
    """
    try:
        oid = PydanticObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID format",
        )

    # Verify area exists and is ready
    area = await CoverageArea.get(oid)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    if area.status != "ready":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Area is not ready (status: {area.status})",
        )

    # Build geospatial query for viewport
    viewport_polygon = {
        "type": "Polygon",
        "coordinates": [
            [
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ]
        ],
    }

    # Query streets in viewport
    streets_query = {
        "area_id": oid,
        "area_version": area.area_version,
        "geometry": {
            "$geoIntersects": {
                "$geometry": viewport_polygon,
            }
        },
    }

    # Get streets with limit
    streets = (
        await Street.find(streets_query).limit(MAX_VIEWPORT_FEATURES + 1).to_list()
    )

    truncated = len(streets) > MAX_VIEWPORT_FEATURES
    if truncated:
        streets = streets[:MAX_VIEWPORT_FEATURES]

    # Get coverage states for these segments
    segment_ids = [s.segment_id for s in streets]
    states = await CoverageState.find(
        {"area_id": oid, "segment_id": {"$in": segment_ids}}
    ).to_list()

    # Build status lookup
    status_map = {s.segment_id: s.status for s in states}

    # Build GeoJSON features
    features = []
    for street in streets:
        segment_status = status_map.get(street.segment_id, "undriven")

        features.append(
            StreetFeature(
                properties={
                    "segment_id": street.segment_id,
                    "street_name": street.street_name,
                    "highway_type": street.highway_type,
                    "length_miles": street.length_miles,
                    "status": segment_status,
                },
                geometry=street.geometry,
            )
        )

    return StreetsResponse(
        features=features,
        total_in_viewport=len(features),
        truncated=truncated,
    )


@router.get("/areas/{area_id}/streets/geojson")
async def get_streets_geojson(
    area_id: str,
    min_lon: float = Query(...),
    min_lat: float = Query(...),
    max_lon: float = Query(...),
    max_lat: float = Query(...),
):
    """
    Get streets as a GeoJSON FeatureCollection.

    Alternative format for libraries that expect standard GeoJSON.
    """
    result = await get_streets_in_viewport(
        area_id=area_id,
        min_lon=min_lon,
        min_lat=min_lat,
        max_lon=max_lon,
        max_lat=max_lat,
    )

    return {
        "type": "FeatureCollection",
        "features": [f.model_dump() for f in result.features],
    }


@router.patch("/areas/{area_id}/streets/{segment_id}")
async def update_segment_status(
    area_id: str,
    segment_id: str,
    request: MarkSegmentRequest,
):
    """
    Manually update a segment's status.

    Use this to:
    - Mark a segment as 'undriveable' (private road, highway, etc.)
    - Reset a segment to 'undriven' (undo driving detection)
    """
    try:
        oid = PydanticObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID format",
        )

    # Verify segment exists
    street = await Street.find_one({"area_id": oid, "segment_id": segment_id})
    if not street:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Segment not found",
        )

    if request.status == "undriveable":
        await mark_segment_undriveable(oid, segment_id)
    elif request.status == "undriven":
        await mark_segment_undriven(oid, segment_id)
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status: {request.status}. Must be 'undriveable' or 'undriven'.",
        )

    # Recalculate stats
    from coverage.stats import update_area_stats

    await update_area_stats(oid)

    return {
        "success": True,
        "message": f"Segment marked as {request.status}",
    }


@router.get("/areas/{area_id}/streets/summary")
async def get_streets_summary(area_id: str):
    """
    Get a summary of street coverage without loading all segments.

    Returns counts and totals for display in UI.
    """
    try:
        oid = PydanticObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID format",
        )

    area = await CoverageArea.get(oid)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    # Get status counts
    from coverage.stats import get_segment_status_counts

    counts = await get_segment_status_counts(oid, area.area_version)

    return {
        "success": True,
        "area_id": area_id,
        "display_name": area.display_name,
        "status": area.status,
        "total_segments": area.total_segments,
        "segment_counts": counts,
        "total_length_miles": area.total_length_miles,
        "driven_length_miles": area.driven_length_miles,
        "coverage_percentage": area.coverage_percentage,
    }
