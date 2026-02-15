"""
Street segment API endpoints.

Provides viewport-based street retrieval for efficient map rendering.
No more loading entire GeoJSON files - streams segments as needed.
"""

import logging
from datetime import datetime
from typing import Annotated, Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict

from core.coverage import (
    mark_segment_undriveable,
    mark_segment_undriven,
    update_coverage_for_segments,
)
from db.models import CoverageArea, CoverageState, Street
from street_coverage.constants import MAX_VIEWPORT_FEATURES
from street_coverage.services.missions import CoverageMissionService

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
    mission_id: str | None = None


class StreetRenderProjection(BaseModel):
    """Projected Street fields needed for map rendering."""

    segment_id: str
    geometry: dict[str, Any]
    street_name: str | None = None
    highway_type: str = "unclassified"
    length_miles: float = 0.0

    model_config = ConfigDict(extra="ignore")


class CoverageStateRenderProjection(BaseModel):
    """Projected CoverageState fields needed for map rendering."""

    segment_id: str
    status: str = "undriven"
    last_driven_at: datetime | None = None
    first_driven_at: datetime | None = None

    model_config = ConfigDict(extra="ignore")


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
    status_filter: Annotated[
        str | None,
        Query(alias="status", description="Optional status filter"),
    ] = None,
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

    if status_filter and status_filter not in ("undriven", "driven", "undriveable"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid status filter",
        )

    if status_filter in (None, "undriven"):
        # Undriven is the default state; CoverageState rows may be omitted entirely.
        # To keep this endpoint fast, only load non-default statuses and default
        # missing statuses to undriven.
        streets = await Street.find(
            {
                "area_id": area_id,
                "area_version": area.area_version,
            },
        ).project(StreetRenderProjection).to_list()

        if not streets:
            return {"type": "FeatureCollection", "features": []}

        street_ids = {s.segment_id for s in streets}
        states = await CoverageState.find(
            {
                "area_id": area_id,
                "status": {"$in": ["driven", "undriveable"]},
            },
        ).project(CoverageStateRenderProjection).to_list()
        state_map = {s.segment_id: s for s in states if s.segment_id in street_ids}

        features = []
        for street in streets:
            state = state_map.get(street.segment_id)
            segment_status = state.status if state else "undriven"
            if status_filter == "undriven" and segment_status != "undriven":
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
                        "last_driven_at": state.last_driven_at if state else None,
                        "first_driven_at": state.first_driven_at if state else None,
                    },
                },
            )

        return {
            "type": "FeatureCollection",
            "features": features,
        }

    # status_filter in {"driven", "undriveable"}: fetch matching CoverageState rows
    # first, then hydrate with the current Street geometries.
    states = await CoverageState.find(
        {"area_id": area_id, "status": status_filter},
    ).project(CoverageStateRenderProjection).to_list()
    if not states:
        return {"type": "FeatureCollection", "features": []}

    state_map = {s.segment_id: s for s in states}
    segment_ids = list(state_map)
    streets = await Street.find(
        {
            "area_id": area_id,
            "area_version": area.area_version,
            "segment_id": {"$in": segment_ids},
        },
    ).project(StreetRenderProjection).to_list()

    features = [
        {
            "type": "Feature",
            "geometry": street.geometry,
            "properties": {
                "segment_id": street.segment_id,
                "street_name": street.street_name,
                "highway_type": street.highway_type,
                "length_miles": street.length_miles,
                "status": status_filter,
                "last_driven_at": state_map[street.segment_id].last_driven_at,
                "first_driven_at": state_map[street.segment_id].first_driven_at,
            },
        }
        for street in streets
    ]

    return {"type": "FeatureCollection", "features": features}


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
        ok = await mark_segment_undriveable(area_id, segment_id)
    elif request.status == "undriven":
        ok = await mark_segment_undriven(area_id, segment_id)
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status: {request.status}. Must be 'undriveable' or 'undriven'.",
        )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update segment status",
        )

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

    mission_oid: PydanticObjectId | None = None
    if request.mission_id:
        try:
            mission_oid = PydanticObjectId(str(request.mission_id))
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid mission_id",
            ) from exc
        try:
            await CoverageMissionService.validate_progress_context(
                mission_id=mission_oid,
                area_id=area_id,
            )
        except LookupError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(exc),
            ) from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc

    result = await update_coverage_for_segments(
        area_id=area_id,
        segment_ids=request.segment_ids,
    )

    mission_delta: dict[str, Any] | None = None
    if mission_oid:
        try:
            mission_delta = await CoverageMissionService.apply_segment_progress(
                mission_id=mission_oid,
                area_id=area_id,
                segment_ids=result.newly_driven_segment_ids,
                note="Segments marked driven from turn-by-turn session.",
            )
        except LookupError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(exc),
            ) from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc

    return {
        "success": True,
        "updated": result.updated,
        "newly_driven": len(result.newly_driven_segment_ids),
        "newly_driven_segment_ids": result.newly_driven_segment_ids,
        "newly_driven_length_miles": result.newly_driven_length_miles,
        "mission_delta": mission_delta,
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
