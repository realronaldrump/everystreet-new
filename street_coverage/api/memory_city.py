"""
Memory City API endpoint.

Returns the data needed to render an area's driven streets as a 3D
luminous sculpture: only segments that have been driven, each with the
temporal metadata the frontend encodes as height/color/glow.

This endpoint is read-only and intentionally flat — the frontend does
the visual work.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict

from db.models import CoverageArea, CoverageState, Street
from street_coverage.segment_ids import segment_id_regex_for_area_version
from street_coverage.stats import update_area_stats

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["coverage-memory-city"])


# =============================================================================
# Response models
# =============================================================================


class MemoryCitySegment(BaseModel):
    """One driven segment, flattened for direct deck.gl consumption."""

    segment_id: str
    street_name: str | None = None
    highway_type: str = "unclassified"
    length_miles: float = 0.0
    path: list[list[float]]
    first_driven_at: datetime | None = None
    last_driven_at: datetime | None = None


class MemoryCityArea(BaseModel):
    """Lightweight area summary for the sculpture header."""

    id: str
    display_name: str
    bounding_box: list[float] | None = None
    driven_segments: int = 0
    driven_length_miles: float = 0.0
    coverage_percentage: float = 0.0


class MemoryCityResponse(BaseModel):
    """Payload for the Memory City view."""

    success: bool = True
    area: MemoryCityArea
    segments: list[MemoryCitySegment]
    first_driven_min: datetime | None = None
    first_driven_max: datetime | None = None

    model_config = ConfigDict(arbitrary_types_allowed=True)


# =============================================================================
# Helpers
# =============================================================================


def _extract_linestring(geometry: dict[str, Any] | None) -> list[list[float]]:
    """Return a flat [[lon, lat], ...] path from a GeoJSON geometry."""
    if not isinstance(geometry, dict):
        return []

    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")

    if geom_type == "LineString" and isinstance(coords, list):
        return [
            [float(pt[0]), float(pt[1])]
            for pt in coords
            if isinstance(pt, (list, tuple)) and len(pt) >= 2
        ]

    if geom_type == "MultiLineString" and isinstance(coords, list):
        # Flatten: the renderer treats each segment as a single line, so
        # join parts end-to-end for a continuous visual thread.
        flat: list[list[float]] = []
        for part in coords:
            if not isinstance(part, list):
                continue
            for pt in part:
                if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                    flat.append([float(pt[0]), float(pt[1])])
        return flat

    return []


# =============================================================================
# Endpoint
# =============================================================================


@router.get(
    "/areas/{area_id}/memory-city",
    response_model=MemoryCityResponse,
)
async def get_memory_city(area_id: PydanticObjectId) -> MemoryCityResponse:
    """
    Return all driven segments for an area with the temporal metadata
    needed to render the Memory City sculpture.

    Streets that have never been driven are intentionally omitted — the
    view shows only "the city you've built."
    """
    area = await CoverageArea.get(area_id)
    if area is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    if area.status != "ready":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Area is not ready (status: {area.status})",
        )

    # Fetch only driven coverage states for this area.
    driven_states = await CoverageState.find(
        {
            "area_id": area_id,
            "status": "driven",
            "segment_id": segment_id_regex_for_area_version(
                area_id,
                area.area_version,
            ),
        },
    ).to_list()

    if not driven_states:
        if area.driven_segments or area.driven_length_miles or area.coverage_percentage:
            refreshed_area = await update_area_stats(area_id)
            if refreshed_area is not None:
                area = refreshed_area
        return MemoryCityResponse(
            area=MemoryCityArea(
                id=str(area.id),
                display_name=area.display_name,
                bounding_box=area.bounding_box or None,
                driven_segments=area.driven_segments,
                driven_length_miles=round(area.driven_length_miles, 3),
                coverage_percentage=area.coverage_percentage,
            ),
            segments=[],
            first_driven_min=None,
            first_driven_max=None,
        )

    state_by_segment = {s.segment_id: s for s in driven_states}
    segment_ids = list(state_by_segment)

    # Hydrate with street geometry for the current area version.
    streets = await Street.find(
        {
            "area_id": area_id,
            "area_version": area.area_version,
            "segment_id": {"$in": segment_ids},
        },
    ).to_list()

    segments: list[MemoryCitySegment] = []
    first_driven_values: list[datetime] = []

    for street in streets:
        state = state_by_segment.get(street.segment_id)
        if state is None:
            continue

        path = _extract_linestring(street.geometry)
        if len(path) < 2:
            continue

        segments.append(
            MemoryCitySegment(
                segment_id=street.segment_id,
                street_name=street.street_name,
                highway_type=street.highway_type,
                length_miles=round(street.length_miles, 4),
                path=path,
                first_driven_at=state.first_driven_at,
                last_driven_at=state.last_driven_at,
            ),
        )

        if state.first_driven_at is not None:
            first_driven_values.append(state.first_driven_at)

    first_driven_min = min(first_driven_values) if first_driven_values else None
    first_driven_max = max(first_driven_values) if first_driven_values else None

    rendered_length_miles = round(sum(segment.length_miles for segment in segments), 3)
    if (
        area.driven_segments != len(segments)
        or round(float(area.driven_length_miles or 0.0), 3) != rendered_length_miles
    ):
        refreshed_area = await update_area_stats(area_id)
        if refreshed_area is not None:
            area = refreshed_area

    return MemoryCityResponse(
        area=MemoryCityArea(
            id=str(area.id),
            display_name=area.display_name,
            bounding_box=area.bounding_box or None,
            driven_segments=area.driven_segments,
            driven_length_miles=round(area.driven_length_miles, 3),
            coverage_percentage=area.coverage_percentage,
        ),
        segments=segments,
        first_driven_min=first_driven_min,
        first_driven_max=first_driven_max,
    )
