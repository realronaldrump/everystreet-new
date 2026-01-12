"""
Coverage area CRUD API endpoints.

Simplified API for managing coverage areas:
- Add area by name (no configuration)
- List areas with stats
- Get single area details
- Delete area
- Trigger rebuild
"""

import logging
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from coverage.ingestion import create_area, delete_area, rebuild_area
from coverage.models import CoverageArea, Job

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["coverage"])


# =============================================================================
# Request/Response Models
# =============================================================================


class CreateAreaRequest(BaseModel):
    """Request to create a new coverage area."""

    display_name: str
    area_type: str = "city"  # city, county, state, custom
    boundary: dict[str, Any] | None = None  # Optional GeoJSON, fetched if not provided


class AreaResponse(BaseModel):
    """Coverage area response."""

    id: str
    display_name: str
    area_type: str
    status: str
    health: str

    # Statistics (imperial only)
    total_length_miles: float
    driveable_length_miles: float
    driven_length_miles: float
    coverage_percentage: float
    total_segments: int
    driven_segments: int

    # Timestamps
    created_at: str
    last_synced: str | None
    optimal_route_generated_at: str | None
    has_optimal_route: bool

    class Config:
        from_attributes = True


class AreaListResponse(BaseModel):
    """Response for listing areas."""

    success: bool = True
    areas: list[AreaResponse]


class AreaDetailResponse(BaseModel):
    """Response for single area with full details."""

    success: bool = True
    area: AreaResponse
    bounding_box: list[float] | None = None
    has_optimal_route: bool = False


class CreateAreaResponse(BaseModel):
    """Response after creating an area."""

    success: bool = True
    area_id: str
    job_id: str | None = None
    message: str


class DeleteAreaResponse(BaseModel):
    """Response after deleting an area."""

    success: bool = True
    message: str


# =============================================================================
# Endpoints
# =============================================================================


@router.get("/areas", response_model=AreaListResponse)
async def list_areas():
    """
    Get all coverage areas with their statistics.

    Returns a simplified list of areas with coverage stats.
    No pagination - designed for typical usage (< 20 areas).
    """
    try:
        areas = await CoverageArea.find_all().to_list()

        area_responses = []
        for area in areas:
            area_responses.append(
                AreaResponse(
                    id=str(area.id),
                    display_name=area.display_name,
                    area_type=area.area_type,
                    status=area.status,
                    health=area.health,
                    total_length_miles=area.total_length_miles,
                    driveable_length_miles=area.driveable_length_miles,
                    driven_length_miles=area.driven_length_miles,
                    coverage_percentage=area.coverage_percentage,
                    total_segments=area.total_segments,
                    driven_segments=area.driven_segments,
                    created_at=area.created_at.isoformat(),
                    last_synced=(
                        area.last_synced.isoformat() if area.last_synced else None
                    ),
                    optimal_route_generated_at=(
                        area.optimal_route_generated_at.isoformat()
                        if area.optimal_route_generated_at
                        else None
                    ),
                    has_optimal_route=area.optimal_route is not None,
                )
            )

        return AreaListResponse(areas=area_responses)

    except Exception as e:
        logger.error(f"Error listing coverage areas: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/areas/{area_id}", response_model=AreaDetailResponse)
async def get_area(area_id: str):
    """
    Get detailed information about a coverage area.

    Includes bounding box and optimal route availability.
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

    return AreaDetailResponse(
        area=AreaResponse(
            id=str(area.id),
            display_name=area.display_name,
            area_type=area.area_type,
            status=area.status,
            health=area.health,
            total_length_miles=area.total_length_miles,
            driveable_length_miles=area.driveable_length_miles,
            driven_length_miles=area.driven_length_miles,
            coverage_percentage=area.coverage_percentage,
            total_segments=area.total_segments,
            driven_segments=area.driven_segments,
            created_at=area.created_at.isoformat(),
            last_synced=area.last_synced.isoformat() if area.last_synced else None,
            optimal_route_generated_at=(
                area.optimal_route_generated_at.isoformat()
                if area.optimal_route_generated_at
                else None
            ),
            has_optimal_route=area.optimal_route is not None,
        ),
        bounding_box=area.bounding_box if area.bounding_box else None,
        has_optimal_route=area.optimal_route is not None,
    )


@router.post("/areas", response_model=CreateAreaResponse)
async def add_area(request: CreateAreaRequest):
    """
    Add a new coverage area.

    Simply provide the name (e.g., "Seattle, WA") and the system
    handles everything else automatically:
    - Fetches boundary from geocoding
    - Downloads streets from OpenStreetMap
    - Calculates coverage from existing trips

    No configuration options - the system "just works".
    """
    try:
        area = await create_area(
            display_name=request.display_name,
            area_type=request.area_type,
            boundary=request.boundary,
        )

        # Get the associated job
        job = await Job.find_one({"area_id": area.id, "job_type": "area_ingestion"})

        return CreateAreaResponse(
            area_id=str(area.id),
            job_id=str(job.id) if job else None,
            message=f"Area '{request.display_name}' is being set up. This typically takes 1-2 minutes.",
        )

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.error(f"Error creating coverage area: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.delete("/areas/{area_id}", response_model=DeleteAreaResponse)
async def remove_area(area_id: str):
    """
    Delete a coverage area and all associated data.

    This removes:
    - Street segments
    - Coverage state
    - Statistics

    This action cannot be undone.
    """
    try:
        oid = PydanticObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID format",
        )

    deleted = await delete_area(oid)

    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    return DeleteAreaResponse(
        message="Coverage area deleted successfully",
    )


@router.post("/areas/{area_id}/rebuild")
async def trigger_rebuild(area_id: str):
    """
    Trigger a rebuild of an area with fresh OSM data.

    Use this when:
    - New streets have been added to OpenStreetMap
    - The area data is more than 90 days old
    - You want to reset and recalculate everything

    Returns a job ID for tracking progress.
    """
    try:
        oid = PydanticObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID format",
        )

    try:
        job = await rebuild_area(oid)

        return {
            "success": True,
            "job_id": str(job.id),
            "message": "Rebuild started. This typically takes 1-2 minutes.",
        }

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except Exception as e:
        logger.error(f"Error triggering rebuild: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/areas/{area_id}/backfill")
async def trigger_backfill(area_id: str):
    """
    Trigger a backfill of coverage data for an existing area.

    This matches all existing trips against the area's streets and updates
    coverage accordingly. Use this when:
    - The area was created but trips weren't matched correctly
    - You've imported historical trip data
    - Coverage seems incomplete

    Unlike rebuild, this does NOT re-fetch OSM data or re-segment streets.
    It only re-processes trip matching.

    Returns the number of segments updated.
    """
    from coverage.worker import backfill_coverage_for_area

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

    try:
        logger.info(f"Starting backfill for area {area.display_name}")
        segments_updated = await backfill_coverage_for_area(oid)

        return {
            "success": True,
            "message": f"Backfill complete. Updated {segments_updated} segments.",
            "segments_updated": segments_updated,
        }

    except Exception as e:
        logger.error(f"Error during backfill: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
