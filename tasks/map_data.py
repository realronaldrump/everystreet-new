"""
Background tasks for map data operations.

Handles:
- Region downloads from Geofabrik
- Nominatim data imports
- Valhalla tile builds
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from beanie import PydanticObjectId

from map_data.builders import (
    build_nominatim_data,
    build_valhalla_tiles,
    start_container_on_demand,
)
from map_data.download import parallel_download_region
from map_data.models import MapDataJob, MapRegion

logger = logging.getLogger(__name__)


async def download_region_task(ctx: dict, job_id: str) -> dict:
    """
    Execute region download in background.

    Args:
        ctx: ARQ context
        job_id: MapDataJob document ID

    Returns:
        Result dictionary with status
    """
    logger.info("Starting download task for job %s", job_id)

    job = await MapDataJob.get(PydanticObjectId(job_id))
    if not job:
        logger.error("Job not found: %s", job_id)
        return {"success": False, "error": "Job not found"}

    if job.status == MapDataJob.STATUS_CANCELLED:
        logger.info("Job was cancelled: %s", job_id)
        return {"success": False, "error": "Job cancelled"}

    region = await MapRegion.get(job.region_id)
    if not region:
        job.status = MapDataJob.STATUS_FAILED
        job.error = "Region not found"
        await job.save()
        return {"success": False, "error": "Region not found"}

    retry_delays = [30, 60, 300]
    max_retries = job.max_retries or 3
    attempt = job.retry_count or 0

    while True:
        if job.status == MapDataJob.STATUS_CANCELLED:
            logger.info("Job was cancelled during retry: %s", job_id)
            return {"success": False, "error": "Job cancelled"}

        try:
            # Update job status to running
            job.status = MapDataJob.STATUS_RUNNING
            job.started_at = job.started_at or datetime.now(UTC)
            job.stage = "Downloading"
            job.progress = 0
            job.error = None
            job.message = "Starting download"
            job.retry_count = attempt
            await job.save()

            region.status = MapRegion.STATUS_DOWNLOADING
            region.last_error = None
            region.download_progress = 0
            region.updated_at = datetime.now(UTC)
            await region.save()

            # Progress callback to update job
            async def update_progress(progress: float, message: str) -> None:
                job.progress = progress
                job.message = message
                region.download_progress = progress
                await job.save()
                await region.save()

            # Execute download
            await parallel_download_region(region, progress_callback=update_progress)

            # Mark job complete
            job.status = MapDataJob.STATUS_COMPLETED
            job.progress = 100
            job.message = "Download complete"
            job.completed_at = datetime.now(UTC)
            await job.save()

            logger.info("Download complete for region %s", region.display_name)

            # Check if this is a full pipeline job - chain to build
            if job.job_type == "download_and_build_all":
                logger.info(
                    "Chaining to Nominatim + Valhalla build for region %s",
                    region.display_name,
                )
                # Create a new build_all job
                from map_data.models import MapDataJob as MDJ

                build_job = MDJ(
                    job_type=MDJ.JOB_BUILD_ALL,
                    region_id=region.id,
                    status=MDJ.STATUS_PENDING,
                    stage="Queued for Nominatim + Valhalla build",
                    message=f"Building geo services for {region.display_name}",
                )
                await build_job.insert()
                await enqueue_nominatim_build_task(str(build_job.id))

            return {"success": True, "region_id": str(region.id)}

        except Exception as e:
            attempt += 1
            job.retry_count = attempt

            if attempt <= max_retries:
                delay = retry_delays[min(attempt - 1, len(retry_delays) - 1)]
                logger.warning(
                    "Download failed for job %s (attempt %s/%s): %s",
                    job_id,
                    attempt,
                    max_retries,
                    e,
                )

                job.status = MapDataJob.STATUS_RUNNING
                job.stage = f"Retrying in {delay}s"
                job.message = f"Download failed. Retrying ({attempt}/{max_retries})"
                job.error = str(e)
                job.completed_at = None
                await job.save()

                region.last_error = str(e)
                region.status = MapRegion.STATUS_DOWNLOADING
                region.updated_at = datetime.now(UTC)
                await region.save()

                await asyncio.sleep(delay)
                continue

            logger.exception("Download failed for job %s", job_id)

            job.status = MapDataJob.STATUS_FAILED
            job.error = str(e)
            job.completed_at = datetime.now(UTC)
            await job.save()

            region.status = MapRegion.STATUS_ERROR
            region.last_error = str(e)
            region.updated_at = datetime.now(UTC)
            await region.save()

            return {"success": False, "error": str(e)}


async def build_nominatim_task(ctx: dict, job_id: str) -> dict:
    """
    Execute Nominatim import in background.

    Args:
        ctx: ARQ context
        job_id: MapDataJob document ID

    Returns:
        Result dictionary with status
    """
    logger.info("Starting Nominatim build task for job %s", job_id)

    job = await MapDataJob.get(PydanticObjectId(job_id))
    if not job:
        logger.error("Job not found: %s", job_id)
        return {"success": False, "error": "Job not found"}

    if job.status == MapDataJob.STATUS_CANCELLED:
        logger.info("Job was cancelled: %s", job_id)
        return {"success": False, "error": "Job cancelled"}

    region = await MapRegion.get(job.region_id)
    if not region:
        job.status = MapDataJob.STATUS_FAILED
        job.error = "Region not found"
        await job.save()
        return {"success": False, "error": "Region not found"}

    try:
        # Update job status
        job.status = MapDataJob.STATUS_RUNNING
        job.started_at = datetime.now(UTC)
        job.stage = "Starting Nominatim service"
        job.message = "Ensuring Nominatim container is running"
        await job.save()

        await start_container_on_demand("nominatim")

        job.stage = "Building Nominatim"

        # Update region status
        region.nominatim_status = "building"
        region.status = MapRegion.STATUS_BUILDING_NOMINATIM
        region.updated_at = datetime.now(UTC)
        await region.save()

        # Progress callback
        async def update_progress(progress: float, message: str) -> None:
            job.progress = progress
            job.message = message
            await job.save()

        # Execute build
        await build_nominatim_data(region, progress_callback=update_progress)

        # Mark complete
        job.progress = 100
        job.message = "Nominatim build complete"
        job.completed_at = datetime.now(UTC)

        region.nominatim_status = "ready"
        region.nominatim_built_at = datetime.now(UTC)
        region.nominatim_error = None
        region.updated_at = datetime.now(UTC)

        # Check if this was a "build all" job
        if job.job_type == MapDataJob.JOB_BUILD_ALL:
            # Continue with Valhalla build
            job.stage = "Starting Valhalla build"
            job.progress = 50
            await job.save()
            await region.save()

            # Build Valhalla
            region.valhalla_status = "building"
            region.status = MapRegion.STATUS_BUILDING_VALHALLA
            await region.save()

            await build_valhalla_tiles(region, progress_callback=update_progress)

            region.valhalla_status = "ready"
            region.valhalla_built_at = datetime.now(UTC)
            region.valhalla_error = None
            region.status = MapRegion.STATUS_READY
            job.message = "Full build complete"
        else:
            # Just Nominatim was built
            region.status = MapRegion.STATUS_DOWNLOADED
            if region.valhalla_status == "ready":
                region.status = MapRegion.STATUS_READY

        job.status = MapDataJob.STATUS_COMPLETED
        job.completed_at = datetime.now(UTC)
        await job.save()

        region.updated_at = datetime.now(UTC)
        await region.save()

        logger.info("Nominatim build complete for region %s", region.display_name)
        return {"success": True, "region_id": str(region.id)}

    except Exception as e:
        logger.exception("Nominatim build failed for job %s", job_id)

        job.status = MapDataJob.STATUS_FAILED
        job.error = str(e)
        job.completed_at = datetime.now(UTC)
        await job.save()

        region.nominatim_status = "error"
        region.nominatim_error = str(e)
        region.status = MapRegion.STATUS_ERROR
        region.last_error = str(e)
        region.updated_at = datetime.now(UTC)
        await region.save()

        return {"success": False, "error": str(e)}


async def build_valhalla_task(ctx: dict, job_id: str) -> dict:
    """
    Execute Valhalla tile build in background.

    Args:
        ctx: ARQ context
        job_id: MapDataJob document ID

    Returns:
        Result dictionary with status
    """
    logger.info("Starting Valhalla build task for job %s", job_id)

    job = await MapDataJob.get(PydanticObjectId(job_id))
    if not job:
        logger.error("Job not found: %s", job_id)
        return {"success": False, "error": "Job not found"}

    if job.status == MapDataJob.STATUS_CANCELLED:
        logger.info("Job was cancelled: %s", job_id)
        return {"success": False, "error": "Job cancelled"}

    region = await MapRegion.get(job.region_id)
    if not region:
        job.status = MapDataJob.STATUS_FAILED
        job.error = "Region not found"
        await job.save()
        return {"success": False, "error": "Region not found"}

    try:
        # Update job status
        job.status = MapDataJob.STATUS_RUNNING
        job.started_at = datetime.now(UTC)
        job.stage = "Starting Valhalla service"
        job.message = "Ensuring Valhalla container is running"
        await job.save()

        await start_container_on_demand("valhalla")

        job.stage = "Building Valhalla tiles"

        # Update region status
        region.valhalla_status = "building"
        region.status = MapRegion.STATUS_BUILDING_VALHALLA
        region.updated_at = datetime.now(UTC)
        await region.save()

        # Progress callback
        async def update_progress(progress: float, message: str) -> None:
            job.progress = progress
            job.message = message
            await job.save()

        # Execute build
        await build_valhalla_tiles(region, progress_callback=update_progress)

        # Mark complete
        job.status = MapDataJob.STATUS_COMPLETED
        job.progress = 100
        job.message = "Valhalla build complete"
        job.completed_at = datetime.now(UTC)
        await job.save()

        region.valhalla_status = "ready"
        region.valhalla_built_at = datetime.now(UTC)
        region.valhalla_error = None

        # Update overall status
        if region.nominatim_status == "ready":
            region.status = MapRegion.STATUS_READY
        else:
            region.status = MapRegion.STATUS_DOWNLOADED

        region.updated_at = datetime.now(UTC)
        await region.save()

        logger.info("Valhalla build complete for region %s", region.display_name)
        return {"success": True, "region_id": str(region.id)}

    except Exception as e:
        logger.exception("Valhalla build failed for job %s", job_id)

        job.status = MapDataJob.STATUS_FAILED
        job.error = str(e)
        job.completed_at = datetime.now(UTC)
        await job.save()

        region.valhalla_status = "error"
        region.valhalla_error = str(e)
        region.status = MapRegion.STATUS_ERROR
        region.last_error = str(e)
        region.updated_at = datetime.now(UTC)
        await region.save()

        return {"success": False, "error": str(e)}


# =============================================================================
# Task enqueueing functions (called from services.py)
# =============================================================================


async def enqueue_download_task(job_id: str, build_after: bool = False) -> None:
    """
    Enqueue a download task to the ARQ worker.

    Args:
        job_id: MapDataJob document ID
        build_after: If True, will chain to build after download (for pipeline jobs)
    """
    from tasks.arq import get_arq_pool

    pool = await get_arq_pool()
    await pool.enqueue_job("download_region_task", job_id)
    logger.info(
        "Enqueued download task for job %s (build_after=%s)",
        job_id,
        build_after,
    )


async def enqueue_nominatim_build_task(job_id: str) -> None:
    """Enqueue a Nominatim build task to the ARQ worker."""
    from tasks.arq import get_arq_pool

    pool = await get_arq_pool()
    await pool.enqueue_job("build_nominatim_task", job_id)
    logger.info("Enqueued Nominatim build task for job %s", job_id)


async def enqueue_valhalla_build_task(job_id: str) -> None:
    """Enqueue a Valhalla build task to the ARQ worker."""
    from tasks.arq import get_arq_pool

    pool = await get_arq_pool()
    await pool.enqueue_job("build_valhalla_task", job_id)
    logger.info("Enqueued Valhalla build task for job %s", job_id)
