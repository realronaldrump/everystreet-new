"""
Street segment API endpoints.

Provides viewport-based street retrieval for efficient map rendering.
No more loading entire GeoJSON files - streams segments as needed.
"""

import logging
from typing import Annotated, Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from core.coverage import (
    mark_segment_undriveable,
    mark_segment_undriven,
    update_coverage_for_segments,
)
from db.models import CoverageArea, CoverageState, Street
from street_coverage.constants import MAX_VIEWPORT_FEATURES

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


class MarkDrivenSegmentsRequest(BaseModel):
    """Request to mark multiple segments as driven."""

    segment_ids: list[str]


# =============================================================================
# Endpoints
# =============================================================================


@router.get("/areas/{area_id}/streets", response_model=StreetsResponse)
async def get_streets_in_viewport(
    area_id: PydanticObjectId,
    min_lon: Annotated[float, Query(description="Viewport minimum longitude")],
    min_lat: Annotated[float, Query(description="Viewport minimum latitude")],
    max_lon: Annotated[float, Query(description="Viewport maximum longitude")],
    max_lat: Annotated[float, Query(description="Viewport maximum latitude")],
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
    # Verify area exists and is ready
    area = await CoverageArea.get(area_id)
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
            ],
        ],
    }

    # Query streets in viewport
    streets_query = {
        "area_id": area_id,
        "area_version": area.area_version,
        "geometry": {
            "$geoIntersects": {
                "$geometry": viewport_polygon,
            },
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
        {"area_id": area_id, "segment_id": {"$in": segment_ids}},
    ).to_list()

    # Build state lookup
    state_map = {s.segment_id: s for s in states}

    # Build GeoJSON features
    features = []
    for street in streets:
        state = state_map.get(street.segment_id)
        segment_status = state.status if state else "undriven"

        features.append(
            StreetFeature(
                properties={
                    "segment_id": street.segment_id,
                    "street_name": street.street_name,
                    "highway_type": street.highway_type,
                    "length_miles": street.length_miles,
                    "status": segment_status,
                    "last_driven_at": state.last_driven_at if state else None,
                    "first_driven_at": state.first_driven_at if state else None,
                },
                geometry=street.geometry,
            ),
        )

    return StreetsResponse(
        features=features,
        total_in_viewport=len(features),
        truncated=truncated,
    )


@router.get("/areas/{area_id}/streets/geojson")
async def get_streets_geojson(
    area_id: PydanticObjectId,
    min_lon: Annotated[float, Query()],
    min_lat: Annotated[float, Query()],
    max_lon: Annotated[float, Query()],
    max_lat: Annotated[float, Query()],
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


@router.get("/areas/{area_id}/streets/all")
async def get_all_streets(
    area_id: PydanticObjectId,
    status: Annotated[str | None, Query(description="Optional status filter")] = None,
):
    """
    Get all street segments for an area with coverage status.

    Intended for full-area workflows such as turn-by-turn coverage.
    """
    area = await CoverageArea.get(area_id)
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

    if status and status not in ("undriven", "driven", "undriveable"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid status filter",
        )

    # Load all streets for this area version
    streets = await Street.find(
        {
            "area_id": area_id,
            "area_version": area.area_version,
        },
    ).to_list()

    if not streets:
        return {"type": "FeatureCollection", "features": []}

    segment_ids = [s.segment_id for s in streets]
    states = await CoverageState.find(
        {"area_id": area_id, "segment_id": {"$in": segment_ids}},
    ).to_list()
    status_map = {s.segment_id: s.status for s in states}

    features = []
    for street in streets:
        segment_status = status_map.get(street.segment_id, "undriven")
        if status and segment_status != status:
            continue

        features.append(
            {
                "type": "Feature",
                "geometry": street.geometry,
                "properties": {
                    "segment_id": street.segment_id,
                    "street_name": street.street_name,
                    "highway_type": street.highway_type,
                    "length_miles": street.length_miles,
                    "status": segment_status,
                },
            },
        )

    return {
        "type": "FeatureCollection",
        "features": features,
    }


@router.patch("/areas/{area_id}/streets/{segment_id}")
async def update_segment_status(
    area_id: PydanticObjectId,
    segment_id: str,
    request: MarkSegmentRequest,
):
    """
    Manually update a segment's status.

    Use this to:
    - Mark a segment as 'undriveable' (private road, highway, etc.)
    - Reset a segment to 'undriven' (undo driving detection)
    """
    # Verify segment exists
    street = await Street.find_one({"area_id": area_id, "segment_id": segment_id})
    if not street:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Segment not found",
        )

    if request.status == "undriveable":
        await mark_segment_undriveable(area_id, segment_id)
    elif request.status == "undriven":
        await mark_segment_undriven(area_id, segment_id)
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status: {request.status}. Must be 'undriveable' or 'undriven'.",
        )

    # Recalculate stats
    from street_coverage.stats import update_area_stats

    await update_area_stats(area_id)

    return {
        "success": True,
        "message": f"Segment marked as {request.status}",
    }


@router.post("/areas/{area_id}/streets/mark-driven")
async def mark_segments_driven(
    area_id: PydanticObjectId,
    request: MarkDrivenSegmentsRequest,
):
    """Mark multiple segments as driven for an area."""
    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    updated = await update_coverage_for_segments(
        area_id=area_id,
        segment_ids=request.segment_ids,
    )

    from street_coverage.stats import update_area_stats

    await update_area_stats(area_id)

    return {
        "success": True,
        "updated": updated,
    }


@router.get("/areas/{area_id}/streets/summary")
async def get_streets_summary(area_id: PydanticObjectId):
    """
    Get a summary of street coverage without loading all segments.

    Returns counts and totals for display in UI.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    # Get status counts
    from street_coverage.stats import get_segment_status_counts

    counts = await get_segment_status_counts(area_id, area.area_version)

    return {
        "success": True,
        "area_id": str(area_id),
        "display_name": area.display_name,
        "status": area.status,
        "total_segments": area.total_segments,
        "segment_counts": counts,
        "total_length_miles": area.total_length_miles,
        "driven_length_miles": area.driven_length_miles,
        "coverage_percentage": area.coverage_percentage,
    }
