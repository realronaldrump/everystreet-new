"""Unified area routes for the new coverage system.

Replaces the old separate OSM/custom boundary endpoints with a single
unified area creation flow.
"""

import logging
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from db import serialize_document
from coverage_models.area import AreaCreate, AreaStatus, AreaType
from coverage_models.job_status import JobState
from services.area_manager import area_manager
from services.job_manager import job_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/areas", tags=["areas"])


class CreateAreaRequest(BaseModel):
    """Request body for creating an area."""

    display_name: str
    area_type: str  # "osm" or "custom"

    # For OSM areas
    osm_id: int | None = None
    osm_type: str | None = None

    # For custom areas - GeoJSON geometry
    geometry: dict[str, Any] | None = None

    # Optional configuration overrides
    segment_length_feet: float | None = None
    segment_length_meters: float | None = None
    match_buffer_feet: float | None = None
    match_buffer_meters: float | None = None


class RebuildAreaRequest(BaseModel):
    """Request body for rebuilding an area."""

    pass  # No body needed, area_id from path


def _serialize_area(area) -> dict[str, Any]:
    """Serialize an Area object for JSON response."""
    return {
        "id": str(area.id) if area.id else None,
        "display_name": area.display_name,
        "area_type": area.area_type,
        "status": area.status,
        "boundary": area.boundary,
        "bbox": area.bbox,
        "osm_id": area.osm_id,
        "osm_type": area.osm_type,
        "segment_length_m": area.segment_length_m,
        "match_buffer_m": area.match_buffer_m,
        "current_version": area.current_version,
        "last_error": area.last_error,
        "last_ingestion_at": area.last_ingestion_at.isoformat() if area.last_ingestion_at else None,
        "last_coverage_sync_at": area.last_coverage_sync_at.isoformat() if area.last_coverage_sync_at else None,
        "created_at": area.created_at.isoformat() if area.created_at else None,
        "updated_at": area.updated_at.isoformat() if area.updated_at else None,
        "cached_stats": area.cached_stats.model_dump() if area.cached_stats else None,
    }


def _serialize_job(job) -> dict[str, Any]:
    """Serialize a Job object for JSON response."""
    return {
        "id": str(job.id) if job.id else None,
        "job_type": job.job_type,
        "state": job.state,
        "stage": job.stage,
        "percent": job.percent,
        "message": job.message,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "metrics": job.metrics,
    }


@router.post("")
async def create_area(request: CreateAreaRequest):
    """Create a new area and start ingestion.

    The area will be created immediately with status="initializing" and
    ingestion will run in the background. No need to keep the browser open.
    """
    try:
        # Convert to AreaCreate model
        area_type = AreaType(request.area_type)

        create_req = AreaCreate(
            display_name=request.display_name,
            area_type=area_type,
            osm_id=request.osm_id,
            osm_type=request.osm_type,
            geometry=request.geometry,
            segment_length_feet=request.segment_length_feet,
            segment_length_meters=request.segment_length_meters,
            match_buffer_feet=request.match_buffer_feet,
            match_buffer_meters=request.match_buffer_meters,
        )

        area = await area_manager.create_area(create_req)

        return JSONResponse(
            status_code=status.HTTP_201_CREATED,
            content={
                "success": True,
                "area": _serialize_area(area),
                "message": "Area created. Ingestion running in background.",
            },
        )

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error creating area: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("")
async def list_areas(status_filter: str | None = None):
    """List all areas.

    Optional status filter: initializing, ingesting, ready, error
    """
    try:
        area_status = None
        if status_filter:
            try:
                area_status = AreaStatus(status_filter)
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid status: {status_filter}",
                )

        areas = await area_manager.list_areas(status=area_status)

        return {
            "success": True,
            "areas": [_serialize_area(area) for area in areas],
            "total": len(areas),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error listing areas: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/{area_id}")
async def get_area(area_id: str):
    """Get a specific area by ID."""
    try:
        area = await area_manager.get_area(area_id)
        if not area:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Area {area_id} not found",
            )

        return {
            "success": True,
            "area": _serialize_area(area),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error getting area %s: %s", area_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.delete("/{area_id}")
async def delete_area(area_id: str):
    """Delete an area and all associated data."""
    try:
        deleted = await area_manager.delete_area(area_id)
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Area {area_id} not found",
            )

        return {
            "success": True,
            "message": "Area deleted successfully",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error deleting area %s: %s", area_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/{area_id}/rebuild")
async def rebuild_area(area_id: str):
    """Trigger a rebuild for an area.

    This will increment the area version and re-ingest OSM data.
    Use this as an admin escape hatch when something goes wrong.
    """
    try:
        job_id = await area_manager.trigger_rebuild(area_id)

        return {
            "success": True,
            "job_id": job_id,
            "message": "Rebuild started. Check job status for progress.",
        }

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error triggering rebuild for area %s: %s", area_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/{area_id}/jobs")
async def get_area_jobs(area_id: str, limit: int = 10):
    """Get jobs for a specific area."""
    try:
        # Verify area exists
        area = await area_manager.get_area(area_id)
        if not area:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Area {area_id} not found",
            )

        jobs = await job_manager.get_jobs_for_area(area_id, limit=limit)

        return {
            "success": True,
            "jobs": [_serialize_job(job) for job in jobs],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error getting jobs for area %s: %s", area_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/{area_id}/active-job")
async def get_active_job(area_id: str):
    """Get the currently active job for an area, if any."""
    try:
        job = await job_manager.get_active_job_for_area(area_id)

        if job:
            return {
                "success": True,
                "has_active_job": True,
                "job": _serialize_job(job),
            }
        else:
            return {
                "success": True,
                "has_active_job": False,
                "job": None,
            }

    except Exception as e:
        logger.exception("Error getting active job for area %s: %s", area_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/{area_id}/sanity-check")
async def sanity_check_area(area_id: str, repair: bool = True):
    """Run sanity check on an area's coverage data.

    Checks for and optionally repairs:
    - Orphaned coverage_state records (no matching street)
    - Missing coverage_state records (street without coverage)
    - Stats drift (cached_stats don't match actual data)

    Args:
        area_id: Area ID to check
        repair: Whether to repair issues found (default: True)
    """
    from coverage_models.job_status import JobType
    from services.rebuild_service import rebuild_service

    try:
        # Verify area exists
        area = await area_manager.get_area(area_id)
        if not area:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Area {area_id} not found",
            )

        # Create job for tracking
        job = await job_manager.create_job(
            job_type=JobType.SANITY_CHECK,
            area_id=area_id,
        )

        result = await rebuild_service.sanity_check_area(
            area_id=area_id,
            job_id=str(job.id),
            repair=repair,
        )

        return {
            "success": True,
            "job_id": str(job.id),
            **result,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error running sanity check for area %s: %s", area_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


# Job status endpoints (not area-specific)
@router.get("/jobs/{job_id}", tags=["jobs"])
async def get_job_status(job_id: str):
    """Get status of a specific job."""
    try:
        job = await job_manager.get_job(job_id)
        if not job:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Job {job_id} not found",
            )

        return {
            "success": True,
            "job": _serialize_job(job),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error getting job %s: %s", job_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
