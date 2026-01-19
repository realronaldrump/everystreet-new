"""
Map Data Management API endpoints.

Provides endpoints for:
- Listing available Geofabrik regions
- Managing downloaded regions
- Triggering downloads and builds
- Monitoring job progress
- Service health checks
"""

from __future__ import annotations

import logging
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from map_data.models import MapDataJob, MapRegion
from map_data.services import (
    build_nominatim,
    build_valhalla,
    cancel_job,
    check_service_health,
    delete_region,
    download_region,
    get_geofabrik_regions,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/map-data", tags=["map-data"])


# =============================================================================
# Request/Response Models
# =============================================================================


class GeofabrikRegionResponse(BaseModel):
    """Available region from Geofabrik."""

    id: str
    name: str
    parent: str | None = None
    type: str | None = None
    pbf_url: str | None = None
    pbf_size_mb: float | None = None
    last_modified: str | None = None
    has_children: bool = False
    bounding_box: list[float] = Field(default_factory=list)


class RegionResponse(BaseModel):
    """Managed region response."""

    id: str
    name: str
    display_name: str
    source: str
    status: str
    nominatim_status: str
    valhalla_status: str
    file_size_mb: float | None = None
    downloaded_at: str | None = None
    last_error: str | None = None
    bounding_box: list[float] = Field(default_factory=list)


class RegionDetailResponse(BaseModel):
    """Detailed region response with active job info."""

    success: bool = True
    region: dict[str, Any]
    active_job: dict[str, Any] | None = None


class DownloadRequest(BaseModel):
    """Request to download a region."""

    geofabrik_id: str
    display_name: str | None = None


class JobResponse(BaseModel):
    """Job creation response."""

    success: bool = True
    job_id: str
    message: str


class JobStatusResponse(BaseModel):
    """Job status response."""

    success: bool = True
    id: str
    job_type: str
    region_id: str | None = None
    status: str
    stage: str
    progress: float
    message: str
    error: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None


class ServiceHealthResponse(BaseModel):
    """Geo service health status."""

    success: bool = True
    nominatim: dict[str, Any]
    valhalla: dict[str, Any]
    overall_healthy: bool


# =============================================================================
# Geofabrik Catalog Endpoints
# =============================================================================


@router.get("/geofabrik/regions")
async def list_geofabrik_regions(parent: str | None = None) -> dict[str, Any]:
    """
    List available regions from Geofabrik.

    Optionally filter by parent region (e.g., "north-america" or "north-
    america/us"). Returns regions that can be downloaded for Nominatim
    and Valhalla.
    """
    try:
        regions = await get_geofabrik_regions(parent=parent)
        return {"success": True, "regions": regions, "parent": parent}
    except Exception as e:
        logger.exception("Failed to fetch Geofabrik regions")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch regions: {e!s}",
        )


# =============================================================================
# Region Management Endpoints
# =============================================================================


@router.get("/regions")
async def list_regions() -> dict[str, Any]:
    """Get all managed map regions with their status."""
    try:
        regions = await MapRegion.find_all().sort("-created_at").to_list()
        return {
            "success": True,
            "regions": [
                {
                    "id": str(r.id),
                    "name": r.name,
                    "display_name": r.display_name,
                    "source": r.source,
                    "status": r.status,
                    "nominatim_status": r.nominatim_status,
                    "valhalla_status": r.valhalla_status,
                    "file_size_mb": r.file_size_mb,
                    "downloaded_at": (
                        r.downloaded_at.isoformat() if r.downloaded_at else None
                    ),
                    "last_error": r.last_error,
                    "bounding_box": r.bounding_box,
                }
                for r in regions
            ],
        }
    except Exception as e:
        logger.exception("Failed to list regions")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list regions: {e!s}",
        )


@router.get("/regions/{region_id}")
async def get_region(region_id: str) -> RegionDetailResponse:
    """Get detailed info about a specific region."""
    try:
        region = await MapRegion.get(PydanticObjectId(region_id))
        if not region:
            raise HTTPException(status_code=404, detail="Region not found")

        # Get active job if any
        active_job = await MapDataJob.find_one(
            {
                "region_id": region.id,
                "status": {
                    "$in": [MapDataJob.STATUS_PENDING, MapDataJob.STATUS_RUNNING],
                },
            },
        )

        return RegionDetailResponse(
            region={
                "id": str(region.id),
                "name": region.name,
                "display_name": region.display_name,
                "source": region.source,
                "source_url": region.source_url,
                "source_size_mb": region.source_size_mb,
                "status": region.status,
                "pbf_path": region.pbf_path,
                "file_size_mb": region.file_size_mb,
                "download_progress": region.download_progress,
                "downloaded_at": (
                    region.downloaded_at.isoformat() if region.downloaded_at else None
                ),
                "nominatim_status": region.nominatim_status,
                "nominatim_built_at": (
                    region.nominatim_built_at.isoformat()
                    if region.nominatim_built_at
                    else None
                ),
                "nominatim_error": region.nominatim_error,
                "valhalla_status": region.valhalla_status,
                "valhalla_built_at": (
                    region.valhalla_built_at.isoformat()
                    if region.valhalla_built_at
                    else None
                ),
                "valhalla_error": region.valhalla_error,
                "bounding_box": region.bounding_box,
                "last_error": region.last_error,
                "created_at": region.created_at.isoformat(),
                "updated_at": (
                    region.updated_at.isoformat() if region.updated_at else None
                ),
            },
            active_job=(
                {
                    "id": str(active_job.id),
                    "job_type": active_job.job_type,
                    "status": active_job.status,
                    "stage": active_job.stage,
                    "progress": active_job.progress,
                    "message": active_job.message,
                }
                if active_job
                else None
            ),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to get region %s", region_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get region: {e!s}",
        )


@router.post("/regions/download")
async def download_new_region(request: DownloadRequest) -> JobResponse:
    """
    Download a new region from Geofabrik.

    Creates a MapRegion record and starts the download job.
    """
    try:
        job = await download_region(
            geofabrik_id=request.geofabrik_id,
            display_name=request.display_name,
        )
        return JobResponse(
            job_id=str(job.id),
            message=f"Download started for {request.geofabrik_id}",
        )
    except Exception as e:
        logger.exception("Failed to start download for %s", request.geofabrik_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to start download: {e!s}",
        )


@router.post("/regions/download-and-build")
async def download_and_build_new_region(request: DownloadRequest) -> JobResponse:
    """
    Download a region and automatically build both Nominatim and Valhalla.

    This is a one-click setup endpoint that:
    1. Downloads the OSM PBF file from Geofabrik
    2. Imports into Nominatim for geocoding
    3. Builds Valhalla tiles for routing

    The entire pipeline runs automatically after triggering.
    """
    from map_data.services import download_and_build_all

    try:
        job = await download_and_build_all(
            geofabrik_id=request.geofabrik_id,
            display_name=request.display_name,
        )
        return JobResponse(
            job_id=str(job.id),
            message=f"Download and build started for {request.geofabrik_id}",
        )
    except Exception as e:
        logger.exception(
            "Failed to start download and build for %s", request.geofabrik_id
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to start download and build: {e!s}",
        )


@router.post("/regions/{region_id}/build/nominatim")
async def trigger_nominatim_build(region_id: str) -> JobResponse:
    """Trigger Nominatim import for a downloaded region."""
    try:
        job = await build_nominatim(region_id)
        return JobResponse(
            job_id=str(job.id),
            message="Nominatim build started",
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Failed to start Nominatim build for %s", region_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to start build: {e!s}",
        )


@router.post("/regions/{region_id}/build/valhalla")
async def trigger_valhalla_build(region_id: str) -> JobResponse:
    """Trigger Valhalla tile build for a downloaded region."""
    try:
        job = await build_valhalla(region_id)
        return JobResponse(
            job_id=str(job.id),
            message="Valhalla build started",
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Failed to start Valhalla build for %s", region_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to start build: {e!s}",
        )


@router.post("/regions/{region_id}/build/all")
async def trigger_full_build(region_id: str) -> JobResponse:
    """Build both Nominatim and Valhalla for a region."""
    try:
        job = await build_nominatim(region_id, then_build_valhalla=True)
        return JobResponse(
            job_id=str(job.id),
            message="Full build started (Nominatim, then Valhalla)",
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Failed to start full build for %s", region_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to start build: {e!s}",
        )


@router.delete("/regions/{region_id}")
async def remove_region(region_id: str) -> dict[str, Any]:
    """
    Delete a region and its associated data.

    This removes the PBF file and clears related Nominatim/Valhalla
    data.
    """
    try:
        await delete_region(region_id)
        return {"success": True, "message": "Region deleted"}
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Failed to delete region %s", region_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete region: {e!s}",
        )


# =============================================================================
# Job Management Endpoints
# =============================================================================


@router.get("/jobs")
async def list_jobs(active_only: bool = True) -> dict[str, Any]:
    """Get map data jobs, optionally filtered to active only."""
    try:
        if active_only:
            jobs = (
                await MapDataJob.find(
                    {
                        "status": {
                            "$in": [
                                MapDataJob.STATUS_PENDING,
                                MapDataJob.STATUS_RUNNING,
                            ],
                        },
                    },
                )
                .sort("-created_at")
                .to_list()
            )
        else:
            jobs = await MapDataJob.find_all().sort("-created_at").limit(50).to_list()

        return {
            "success": True,
            "jobs": [
                {
                    "id": str(j.id),
                    "job_type": j.job_type,
                    "region_id": str(j.region_id) if j.region_id else None,
                    "status": j.status,
                    "stage": j.stage,
                    "progress": j.progress,
                    "message": j.message,
                    "error": j.error,
                    "created_at": j.created_at.isoformat(),
                    "started_at": j.started_at.isoformat() if j.started_at else None,
                    "completed_at": (
                        j.completed_at.isoformat() if j.completed_at else None
                    ),
                }
                for j in jobs
            ],
        }
    except Exception as e:
        logger.exception("Failed to list jobs")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list jobs: {e!s}",
        )


@router.get("/jobs/{job_id}")
async def get_job_status(job_id: str) -> JobStatusResponse:
    """Get status of a specific job."""
    try:
        job = await MapDataJob.get(PydanticObjectId(job_id))
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        return JobStatusResponse(
            id=str(job.id),
            job_type=job.job_type,
            region_id=str(job.region_id) if job.region_id else None,
            status=job.status,
            stage=job.stage,
            progress=job.progress,
            message=job.message,
            error=job.error,
            metrics=job.metrics,
            created_at=job.created_at.isoformat(),
            started_at=job.started_at.isoformat() if job.started_at else None,
            completed_at=job.completed_at.isoformat() if job.completed_at else None,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to get job %s", job_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get job: {e!s}",
        )


@router.delete("/jobs/{job_id}")
async def cancel_job_endpoint(job_id: str) -> dict[str, Any]:
    """Cancel a pending or running job."""
    try:
        job = await cancel_job(job_id)
        return {"success": True, "message": "Job cancelled", "job_id": str(job.id)}
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Failed to cancel job %s", job_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to cancel job: {e!s}",
        )


# =============================================================================
# Service Health Endpoints
# =============================================================================


@router.get("/health")
async def get_service_health() -> ServiceHealthResponse:
    """Get health status of Nominatim and Valhalla services."""
    try:
        health = await check_service_health()
        return ServiceHealthResponse(
            nominatim={
                "healthy": health.nominatim_healthy,
                "last_check": (
                    health.nominatim_last_check.isoformat()
                    if health.nominatim_last_check
                    else None
                ),
                "response_time_ms": health.nominatim_response_time_ms,
                "error": health.nominatim_error,
                "version": health.nominatim_version,
            },
            valhalla={
                "healthy": health.valhalla_healthy,
                "last_check": (
                    health.valhalla_last_check.isoformat()
                    if health.valhalla_last_check
                    else None
                ),
                "response_time_ms": health.valhalla_response_time_ms,
                "error": health.valhalla_error,
                "version": health.valhalla_version,
                "tile_count": health.valhalla_tile_count,
            },
            overall_healthy=health.overall_healthy,
        )
    except Exception as e:
        logger.exception("Failed to check service health")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to check health: {e!s}",
        )


@router.post("/health/refresh")
async def refresh_service_health() -> dict[str, Any]:
    """Force refresh of service health status."""
    try:
        health = await check_service_health(force_refresh=True)
        return {
            "success": True,
            "message": "Health check completed",
            "overall_healthy": health.overall_healthy,
        }
    except Exception as e:
        logger.exception("Failed to refresh service health")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to refresh health: {e!s}",
        )
