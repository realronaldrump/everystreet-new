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
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from core.http.nominatim import NominatimClient
from db.models import CoverageArea, Job
from street_coverage.ingestion import (
    _calculate_bounding_box,
    _fetch_boundary,
    backfill_area,
    create_area,
    delete_area,
    rebuild_area,
)
from street_coverage.stats import update_area_stats

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


class ValidateAreaRequest(BaseModel):
    """Request to validate a potential coverage area."""

    location: str
    area_type: str = "city"
    limit: int | None = None


class ValidateCandidate(BaseModel):
    """Candidate match for a coverage area lookup."""

    display_name: str
    osm_id: int | None = None
    osm_type: str | None = None
    type: str | None = None
    class_: str | None = Field(default=None, alias="class")
    address: dict[str, Any] | None = None
    importance: float | None = None
    bounding_box: list[float] | None = None
    type_match: bool = False

    model_config = ConfigDict(populate_by_name=True)


class ValidateAreaResponse(BaseModel):
    """Response for validating a location."""

    success: bool = True
    candidates: list[ValidateCandidate]
    note: str | None = None


class ResolveAreaRequest(BaseModel):
    """Request to resolve a coverage area boundary."""

    osm_id: int | str
    osm_type: str


class ResolveCandidate(BaseModel):
    """Resolved candidate with boundary details."""

    display_name: str
    boundary: dict[str, Any]
    bounding_box: list[float] | None = None
    type: str | None = None
    class_: str | None = Field(default=None, alias="class")
    address: dict[str, Any] | None = None
    osm_id: int | None = None
    osm_type: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class ResolveAreaResponse(BaseModel):
    """Response for resolving a candidate boundary."""

    success: bool = True
    candidate: ResolveCandidate


class AreaResponse(BaseModel):
    """Coverage area response."""

    id: str
    display_name: str
    area_type: str
    status: str
    health: str
    last_error: str | None = None

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

    model_config = ConfigDict(from_attributes=True)


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
# Helpers
# =============================================================================


def _normalize_area_type(area_type: str) -> str:
    return str(area_type or "").strip().lower()


def _parse_bounding_box(raw_bbox: Any) -> list[float] | None:
    if not isinstance(raw_bbox, list) or len(raw_bbox) != 4:
        return None
    try:
        south, north, west, east = map(float, raw_bbox)
    except (TypeError, ValueError):
        return None
    return [west, south, east, north]


def _is_type_match(area_type: str, result: dict[str, Any]) -> bool:
    normalized = _normalize_area_type(area_type)
    if not normalized:
        return True

    result_type = str(result.get("type") or "").lower()
    result_class = str(result.get("class") or "").lower()
    address = result.get("address") or {}

    if normalized == "city":
        return result_type in {
            "city",
            "town",
            "village",
            "hamlet",
            "municipality",
            "locality",
        } or (result_class == "place" and result_type not in {"state", "county"})
    if normalized == "county":
        return result_type == "county" or bool(address.get("county"))
    if normalized == "state":
        return result_type in {"state", "province", "region"} or bool(
            address.get("state")
        )
    return True


def _normalize_candidate(
    result: dict[str, Any],
    area_type: str,
) -> dict[str, Any] | None:
    display_name = result.get("display_name") or result.get("name") or ""
    osm_id = result.get("osm_id")
    osm_type = result.get("osm_type")
    if not display_name or osm_id is None or not osm_type:
        return None

    return {
        "display_name": display_name,
        "osm_id": osm_id,
        "osm_type": osm_type,
        "type": result.get("type"),
        "class": result.get("class"),
        "address": result.get("address") or {},
        "importance": result.get("importance"),
        "bounding_box": _parse_bounding_box(result.get("boundingbox")),
        "type_match": _is_type_match(area_type, result),
    }


def _extract_boundary(result: dict[str, Any], label: str) -> dict[str, Any]:
    geojson = result.get("geojson")
    if isinstance(geojson, dict) and geojson.get("type") == "Feature":
        geojson = geojson.get("geometry")

    if not geojson:
        bbox = result.get("boundingbox")
        if isinstance(bbox, list) and len(bbox) == 4:
            try:
                south, north, west, east = map(float, bbox)
                geojson = {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [west, south],
                            [west, north],
                            [east, north],
                            [east, south],
                            [west, south],
                        ],
                    ],
                }
                logger.warning(
                    "Using bounding box fallback for %s due to missing polygon",
                    label,
                )
            except (TypeError, ValueError):
                geojson = None

    if not geojson:
        msg = f"No boundary polygon for: {label}"
        raise ValueError(msg)

    geom_type = geojson.get("type")
    if geom_type not in ("Polygon", "MultiPolygon"):
        msg = f"Invalid geometry type for boundary: {geom_type}"
        raise ValueError(msg)

    return geojson


def _ensure_polygon_geojson(boundary: dict[str, Any], label: str) -> dict[str, Any]:
    if not boundary:
        msg = f"No boundary polygon for: {label}"
        raise ValueError(msg)
    geojson = boundary
    if isinstance(geojson, dict) and geojson.get("type") == "Feature":
        geojson = geojson.get("geometry")
    if not isinstance(geojson, dict):
        msg = "Boundary geometry must be a GeoJSON object."
        raise TypeError(msg)
    geom_type = geojson.get("type")
    if geom_type not in ("Polygon", "MultiPolygon"):
        msg = f"Invalid geometry type for boundary: {geom_type}"
        raise ValueError(msg)
    return geojson


def _candidate_bounding_box(
    result: dict[str, Any],
    boundary: dict[str, Any] | None,
) -> list[float] | None:
    bbox = _parse_bounding_box(result.get("boundingbox"))
    if bbox:
        return bbox
    if boundary:
        return _calculate_bounding_box(boundary)
    return None


# =============================================================================
# Endpoints
# =============================================================================


@router.post(
    "/areas/validate",
    response_model=ValidateAreaResponse,
    response_model_by_alias=True,
)
async def validate_area(request: ValidateAreaRequest):
    """
    Validate a location before creating a coverage area.

    Returns candidate matches for selection.
    """
    location = request.location.strip()
    if not location:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Location is required.",
        )

    limit = request.limit or 5
    limit = max(1, min(int(limit), 10))

    client = NominatimClient()
    try:
        results = await client.search_raw(
            query=location,
            limit=limit,
            polygon_geojson=False,
            addressdetails=True,
        )
    except Exception as exc:
        logger.exception("Location validation failed for %s", location)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to validate location at this time.",
        ) from exc

    if not results:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location not found.",
        )

    candidates = [
        candidate
        for result in results
        if (candidate := _normalize_candidate(result, request.area_type)) is not None
    ]

    if not candidates:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location not found.",
        )

    note = None
    if candidates and not any(candidate["type_match"] for candidate in candidates):
        note = (
            "No matches for the selected area type. "
            "Select the closest result or adjust the area type."
        )

    return ValidateAreaResponse(candidates=candidates, note=note)


@router.post(
    "/areas/resolve",
    response_model=ResolveAreaResponse,
    response_model_by_alias=True,
)
async def resolve_area(request: ResolveAreaRequest):
    """
    Resolve a candidate boundary for confirmation.
    """
    client = NominatimClient()
    try:
        results = await client.lookup_raw(
            osm_id=request.osm_id,
            osm_type=request.osm_type,
            polygon_geojson=True,
            addressdetails=True,
        )
    except Exception as exc:
        logger.exception(
            "Location resolve failed for osm_id=%s osm_type=%s",
            request.osm_id,
            request.osm_type,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to resolve location at this time.",
        ) from exc

    if not results:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location not found.",
        )

    result = results[0]
    try:
        boundary = _extract_boundary(
            result,
            str(result.get("display_name") or request.osm_id),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    candidate = {
        "display_name": result.get("display_name") or result.get("name") or "",
        "boundary": boundary,
        "bounding_box": _candidate_bounding_box(result, boundary),
        "type": result.get("type"),
        "class": result.get("class"),
        "address": result.get("address") or {},
        "osm_id": result.get("osm_id"),
        "osm_type": result.get("osm_type"),
    }

    return ResolveAreaResponse(candidate=candidate)


@router.get("/areas", response_model=AreaListResponse)
async def list_areas():
    """
    Get all coverage areas with their statistics.

    Returns a simplified list of areas with coverage stats.
    No pagination - designed for typical usage (< 20 areas).
    """
    try:
        areas = await CoverageArea.find_all().to_list()

        area_responses = [
            AreaResponse(
                id=str(area.id),
                display_name=area.display_name,
                area_type=area.area_type,
                status=area.status,
                health=area.health,
                last_error=area.last_error,
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
            )
            for area in areas
        ]

        return AreaListResponse(areas=area_responses)

    except Exception as e:
        logger.exception("Error listing coverage areas")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/areas/{area_id}", response_model=AreaDetailResponse)
async def get_area(area_id: PydanticObjectId):
    """
    Get detailed information about a coverage area.

    Includes bounding box and optimal route availability.
    """
    area = await CoverageArea.get(area_id)
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
            last_error=area.last_error,
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

    Simply provide the name (e.g., "Waco, TX") and the system
    handles everything else automatically:
    - Fetches boundary from geocoding
    - Loads streets from the local OSM extract
    - Calculates coverage from existing trips

    No configuration options - the system "just works".
    """
    try:
        boundary = request.boundary if request.boundary else None
        if boundary is None:
            try:
                boundary = await _fetch_boundary(request.display_name)
            except ValueError as exc:
                detail = str(exc)
                status_code = (
                    status.HTTP_404_NOT_FOUND
                    if "Location not found" in detail
                    else status.HTTP_400_BAD_REQUEST
                )
                raise HTTPException(status_code=status_code, detail=detail) from exc
        try:
            boundary = _ensure_polygon_geojson(boundary, request.display_name)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc

        area = await create_area(
            display_name=request.display_name,
            area_type=request.area_type,
            boundary=boundary,
        )

        # Get the associated job
        job = await Job.find_one({"area_id": area.id, "job_type": "area_ingestion"})

        return CreateAreaResponse(
            area_id=str(area.id),
            job_id=str(job.id) if job else None,
            message=f"Area '{request.display_name}' is being set up. This typically takes 1-2 minutes.",
        )

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error creating coverage area")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.delete("/areas/{area_id}", response_model=DeleteAreaResponse)
async def remove_area(area_id: PydanticObjectId):
    """
    Delete a coverage area and all associated data.

    This removes:
    - Street segments
    - Coverage state
    - Statistics

    This action cannot be undone.
    """
    deleted = await delete_area(area_id)

    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    return DeleteAreaResponse(
        message="Coverage area deleted successfully",
    )


@router.post("/areas/{area_id}/rebuild")
async def trigger_rebuild(area_id: PydanticObjectId):
    """
    Trigger a rebuild of an area with fresh OSM data.

    Use this when:
    - New streets have been added to your local OSM extract
    - The area data is more than 90 days old
    - You want to reset and recalculate everything

    Returns a job ID for tracking progress.
    """
    try:
        job = await rebuild_area(area_id)

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
        logger.exception("Error triggering rebuild")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/areas/{area_id}/backfill")
async def trigger_backfill(
    area_id: PydanticObjectId,
    background: bool = Query(False),
):
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
    from core.coverage import backfill_coverage_for_area

    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    if background:
        try:
            job = await backfill_area(area_id)
        except Exception as e:
            logger.exception(
                "Error enqueueing backfill job for area %s", area.display_name
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(e),
            )
        else:
            job_id = str(job.id) if job.id is not None else None
            return JSONResponse(
                status_code=status.HTTP_202_ACCEPTED,
                content={
                    "success": True,
                    "job_id": job_id,
                    "message": "Backfill enqueued.",
                    "status_url": f"/api/coverage/jobs/{job_id}" if job_id else None,
                },
            )

    try:
        logger.info("Starting backfill for area %s", area.display_name)
        segments_updated = await backfill_coverage_for_area(area_id)
    except Exception as e:
        logger.exception("Error during backfill for area %s", area.display_name)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
    else:
        return {
            "success": True,
            "message": f"Backfill complete. Updated {segments_updated} segments.",
            "segments_updated": segments_updated,
        }


@router.post("/areas/{area_id}/recalculate")
async def trigger_recalculate(area_id: PydanticObjectId):
    """
    Recalculate coverage statistics for an area.

    This refreshes the derived statistics without reloading OSM data or
    reprocessing trips. Useful when values look stale.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    try:
        updated_area = await update_area_stats(area_id)
    except Exception as e:
        logger.exception("Error recalculating stats for area %s", area.display_name)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )

    return {
        "success": True,
        "message": "Coverage statistics recalculated",
        "coverage_percentage": updated_area.coverage_percentage if updated_area else 0,
    }
