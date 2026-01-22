"""
Background tasks for map data operations.

Handles:
- Region downloads from Geofabrik
- Nominatim data imports
- Valhalla tile builds
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from datetime import UTC, datetime

from beanie import PydanticObjectId

from map_data.builders import (
    build_nominatim_data,
    build_valhalla_tiles,
    start_container_on_demand,
)
from map_data.download import (
    DownloadCancelled,
    cleanup_download_artifacts,
    parallel_download_region,
)
from map_data.models import MapDataJob, MapRegion
from tasks.ops import abort_job, run_task_with_history

logger = logging.getLogger(__name__)


async def _watch_job_cancelled(
    job_id: str,
    cancel_event: asyncio.Event,
    interval: float = 1.0,
) -> None:
    while not cancel_event.is_set():
        await asyncio.sleep(interval)
        job = await MapDataJob.get(PydanticObjectId(job_id))
        if not job:
            return
        if job.status == MapDataJob.STATUS_CANCELLED:
            cancel_event.set()
            return


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

    cancel_event = asyncio.Event()
    cancel_watch = asyncio.create_task(_watch_job_cancelled(job_id, cancel_event))

    try:
        if cancel_event.is_set():
            msg = "Download cancelled"
            raise DownloadCancelled(msg)

        # Update job status to running
        job.status = MapDataJob.STATUS_RUNNING
        job.started_at = job.started_at or datetime.now(UTC)
        job.stage = "Downloading"
        job.progress = 0
        job.error = None
        job.message = "Starting download"
        job.retry_count = 0
        job.last_progress_at = datetime.now(UTC)
        await job.save()

        region.status = MapRegion.STATUS_DOWNLOADING
        region.last_error = None
        region.download_progress = 0
        region.updated_at = datetime.now(UTC)
        await region.save()

        # Progress callback to update job
        async def update_progress(progress: float, message: str) -> None:
            if cancel_event.is_set():
                return
            job.progress = progress
            job.message = message
            job.last_progress_at = datetime.now(UTC)
            region.download_progress = progress
            region.updated_at = datetime.now(UTC)
            await job.save()
            await region.save()

        # Execute download
        await parallel_download_region(
            region,
            progress_callback=update_progress,
            cancel_event=cancel_event,
        )

        # Mark job complete
        job.status = MapDataJob.STATUS_COMPLETED
        job.progress = 100
        job.message = "Download complete"
        job.completed_at = datetime.now(UTC)
        job.last_progress_at = datetime.now(UTC)
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

    except DownloadCancelled:
        logger.info("Download cancelled for job %s", job_id)
        refreshed_job = await MapDataJob.get(PydanticObjectId(job_id))
        if refreshed_job:
            if refreshed_job.status != MapDataJob.STATUS_CANCELLED:
                refreshed_job.status = MapDataJob.STATUS_CANCELLED
            refreshed_job.stage = "Cancelled by user"
            refreshed_job.message = "Download cancelled"
            refreshed_job.error = refreshed_job.error or "Cancelled by user"
            refreshed_job.completed_at = datetime.now(UTC)
            refreshed_job.last_progress_at = datetime.now(UTC)
            await refreshed_job.save()

        if region:
            cleanup_download_artifacts(
                region,
                remove_output=region.downloaded_at is None,
            )
            region.status = MapRegion.STATUS_NOT_DOWNLOADED
            region.download_progress = 0
            region.pbf_path = None
            region.file_size_mb = None
            region.downloaded_at = None
            region.nominatim_status = "not_built"
            region.valhalla_status = "not_built"
            region.last_error = "Download cancelled"
            region.updated_at = datetime.now(UTC)
            await region.save()

        return {"success": False, "error": "Job cancelled"}
    except Exception as e:
        logger.exception("Download failed for job %s", job_id)

        job.status = MapDataJob.STATUS_FAILED
        job.error = str(e)
        job.completed_at = datetime.now(UTC)
        job.last_progress_at = datetime.now(UTC)
        await job.save()

        region.status = MapRegion.STATUS_ERROR
        region.last_error = str(e)
        region.updated_at = datetime.now(UTC)
        await region.save()

        return {"success": False, "error": str(e)}
    finally:
        cancel_watch.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cancel_watch


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
        job.last_progress_at = datetime.now(UTC)
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
            job.last_progress_at = datetime.now(UTC)
            await job.save()

        # Execute build
        await build_nominatim_data(region, progress_callback=update_progress)

        # Mark complete
        job.progress = 100
        job.message = "Nominatim build complete"
        job.completed_at = datetime.now(UTC)
        job.last_progress_at = datetime.now(UTC)

        region.nominatim_status = "ready"
        region.nominatim_built_at = datetime.now(UTC)
        region.nominatim_error = None
        region.updated_at = datetime.now(UTC)

        # Check if this was a "build all" job
        if job.job_type == MapDataJob.JOB_BUILD_ALL:
            # Continue with Valhalla build
            job.stage = "Starting Valhalla build"
            job.progress = 50
            job.last_progress_at = datetime.now(UTC)
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
        job.last_progress_at = datetime.now(UTC)
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
        job.last_progress_at = datetime.now(UTC)
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
        job.last_progress_at = datetime.now(UTC)
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
            job.last_progress_at = datetime.now(UTC)
            await job.save()

        # Execute build
        await build_valhalla_tiles(region, progress_callback=update_progress)

        # Mark complete
        job.status = MapDataJob.STATUS_COMPLETED
        job.progress = 100
        job.message = "Valhalla build complete"
        job.completed_at = datetime.now(UTC)
        job.last_progress_at = datetime.now(UTC)
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
        job.last_progress_at = datetime.now(UTC)
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


async def _monitor_map_data_jobs_logic() -> dict[str, object]:
    now = datetime.now(UTC)
    running_threshold = int(os.getenv("MAP_DATA_JOB_STALLED_RUNNING_MINUTES", "20"))
    pending_threshold = int(os.getenv("MAP_DATA_JOB_STALLED_PENDING_MINUTES", "30"))

    jobs = await MapDataJob.find(
        {
            "status": {
                "$in": [MapDataJob.STATUS_PENDING, MapDataJob.STATUS_RUNNING],
            },
        },
    ).to_list()

    stalled = []

    for job in jobs:
        last_activity = job.last_progress_at or job.started_at or job.created_at
        if not last_activity:
            continue

        age_minutes = (now - last_activity).total_seconds() / 60
        threshold = (
            pending_threshold
            if job.status == MapDataJob.STATUS_PENDING
            else running_threshold
        )
        if age_minutes < threshold:
            continue

        reason = f"Job stalled: no progress for {int(age_minutes)} minutes"
        job.status = MapDataJob.STATUS_FAILED
        job.stage = "Stalled"
        job.message = reason
        job.error = reason
        job.completed_at = now
        job.last_progress_at = now
        await job.save()

        if job.arq_job_id:
            with contextlib.suppress(Exception):
                await abort_job(job.arq_job_id)

        if job.region_id:
            region = await MapRegion.get(job.region_id)
            if region:
                if job.job_type in (MapDataJob.JOB_DOWNLOAD, "download_and_build_all"):
                    region.status = MapRegion.STATUS_ERROR
                    region.last_error = reason
                elif job.job_type == MapDataJob.JOB_BUILD_NOMINATIM:
                    region.nominatim_status = "error"
                    region.nominatim_error = reason
                    region.status = MapRegion.STATUS_ERROR
                    region.last_error = reason
                elif job.job_type == MapDataJob.JOB_BUILD_VALHALLA:
                    region.valhalla_status = "error"
                    region.valhalla_error = reason
                    region.status = MapRegion.STATUS_ERROR
                    region.last_error = reason
                elif job.job_type == MapDataJob.JOB_BUILD_ALL:
                    region.nominatim_status = "error"
                    region.valhalla_status = "error"
                    region.status = MapRegion.STATUS_ERROR
                    region.last_error = reason
                region.updated_at = now
                await region.save()

        stalled.append({"job_id": str(job.id), "age_minutes": int(age_minutes)})

    return {
        "status": "success",
        "stalled_jobs": stalled,
        "checked": len(jobs),
    }


async def monitor_map_data_jobs(
    ctx: dict,
    manual_run: bool = False,
) -> dict[str, object]:
    return await run_task_with_history(
        ctx,
        "monitor_map_data_jobs",
        _monitor_map_data_jobs_logic,
        manual_run=manual_run,
    )


async def enqueue_download_task(job_id: str, build_after: bool = False) -> None:
    """
    Enqueue a download task to the ARQ worker.

    Args:
        job_id: MapDataJob document ID
        build_after: If True, will chain to build after download (for pipeline jobs)
    """
    from tasks.arq import get_arq_pool

    pool = await get_arq_pool()
    arq_job = await pool.enqueue_job("download_region_task", job_id)
    arq_job_id = (
        getattr(arq_job, "job_id", None) or getattr(arq_job, "id", None) or str(arq_job)
    )
    try:
        stored_job = await MapDataJob.get(PydanticObjectId(job_id))
        if stored_job:
            stored_job.arq_job_id = arq_job_id
            await stored_job.save()
    except Exception as exc:
        logger.warning("Failed to store ARQ job id for %s: %s", job_id, exc)
    logger.info(
        "Enqueued download task for job %s (build_after=%s)",
        job_id,
        build_after,
    )


async def enqueue_nominatim_build_task(job_id: str) -> None:
    """Enqueue a Nominatim build task to the ARQ worker."""
    from tasks.arq import get_arq_pool

    pool = await get_arq_pool()
    arq_job = await pool.enqueue_job("build_nominatim_task", job_id)
    arq_job_id = (
        getattr(arq_job, "job_id", None) or getattr(arq_job, "id", None) or str(arq_job)
    )
    try:
        stored_job = await MapDataJob.get(PydanticObjectId(job_id))
        if stored_job:
            stored_job.arq_job_id = arq_job_id
            await stored_job.save()
    except Exception as exc:
        logger.warning("Failed to store ARQ job id for %s: %s", job_id, exc)
    logger.info("Enqueued Nominatim build task for job %s", job_id)


async def enqueue_valhalla_build_task(job_id: str) -> None:
    """Enqueue a Valhalla build task to the ARQ worker."""
    from tasks.arq import get_arq_pool

    pool = await get_arq_pool()
    arq_job = await pool.enqueue_job("build_valhalla_task", job_id)
    arq_job_id = (
        getattr(arq_job, "job_id", None) or getattr(arq_job, "id", None) or str(arq_job)
    )
    try:
        stored_job = await MapDataJob.get(PydanticObjectId(job_id))
        if stored_job:
            stored_job.arq_job_id = arq_job_id
            await stored_job.save()
    except Exception as exc:
        logger.warning("Failed to store ARQ job id for %s: %s", job_id, exc)
    logger.info("Enqueued Valhalla build task for job %s", job_id)
