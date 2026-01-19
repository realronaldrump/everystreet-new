"""
Download orchestration for OSM data.

Handles streaming downloads from Geofabrik with progress tracking.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import httpx

from config import get_geofabrik_mirror, get_osm_extracts_path
from map_data.models import MapDataJob, MapRegion

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

# Download configuration
CHUNK_SIZE = 1024 * 1024  # 1MB chunks
DOWNLOAD_TIMEOUT = 3600  # 1 hour max download time
PROGRESS_UPDATE_INTERVAL = 2.0  # Update progress every 2 seconds


async def stream_download_region(
    region: MapRegion,
    progress_callback: Callable[[float, str], Any] | None = None,
) -> str:
    """
    Stream download a region's PBF file from Geofabrik.

    Args:
        region: MapRegion document with source_url
        progress_callback: Optional callback(progress_pct, message) for updates

    Returns:
        Path to the downloaded file (relative to osm_extracts)

    Raises:
        ValueError: If region doesn't have a source URL
        httpx.HTTPError: If download fails
    """
    if not region.source_url:
        # Construct URL from region name
        mirror = get_geofabrik_mirror()
        region.source_url = f"{mirror}/{region.name}-latest.osm.pbf"
        await region.save()

    source_url = region.source_url
    extracts_path = get_osm_extracts_path()

    # Ensure extracts directory exists
    os.makedirs(extracts_path, exist_ok=True)

    # Generate output filename from region name
    safe_name = region.name.replace("/", "_").replace(" ", "_")
    output_filename = f"{safe_name}.osm.pbf"
    output_path = os.path.join(extracts_path, output_filename)
    temp_path = f"{output_path}.downloading"

    logger.info("Starting download: %s -> %s", source_url, output_path)

    try:
        async with httpx.AsyncClient(
            timeout=DOWNLOAD_TIMEOUT,
            follow_redirects=True,
        ) as client:
            async with client.stream("GET", source_url) as response:
                response.raise_for_status()

                # Get total size from headers
                total_size = int(response.headers.get("content-length", 0))
                downloaded = 0
                last_progress_update = 0.0

                if progress_callback:
                    size_mb = total_size / (1024 * 1024) if total_size else 0
                    await _safe_callback(
                        progress_callback,
                        0,
                        f"Starting download ({size_mb:.1f} MB)",
                    )

                # Stream to temp file
                with open(temp_path, "wb") as f:
                    async for chunk in response.aiter_bytes(chunk_size=CHUNK_SIZE):
                        f.write(chunk)
                        downloaded += len(chunk)

                        # Update progress periodically
                        now = asyncio.get_event_loop().time()
                        if now - last_progress_update >= PROGRESS_UPDATE_INTERVAL:
                            if total_size > 0:
                                progress = (downloaded / total_size) * 100
                                downloaded_mb = downloaded / (1024 * 1024)
                                total_mb = total_size / (1024 * 1024)
                                if progress_callback:
                                    await _safe_callback(
                                        progress_callback,
                                        progress,
                                        f"Downloaded {downloaded_mb:.1f} / {total_mb:.1f} MB",
                                    )
                            last_progress_update = now

                # Rename temp file to final
                os.rename(temp_path, output_path)

                # Update region with file info
                region.pbf_path = output_filename
                region.file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
                region.downloaded_at = datetime.now(UTC)
                region.status = MapRegion.STATUS_DOWNLOADED
                region.download_progress = 100.0
                region.updated_at = datetime.now(UTC)
                await region.save()

                if progress_callback:
                    await _safe_callback(
                        progress_callback,
                        100,
                        f"Download complete ({region.file_size_mb:.1f} MB)",
                    )

                logger.info(
                    "Download complete: %s (%.1f MB)",
                    output_path,
                    region.file_size_mb,
                )

                return output_filename

    except Exception:
        # Clean up temp file on error
        if os.path.exists(temp_path):
            with contextlib.suppress(Exception):
                os.remove(temp_path)

        logger.exception("Download failed for %s", region.name)
        raise


async def _safe_callback(
    callback: Callable[[float, str], Any],
    progress: float,
    message: str,
) -> None:
    """Safely call a progress callback, handling both sync and async."""
    try:
        result = callback(progress, message)
        if asyncio.iscoroutine(result):
            await result
    except Exception as e:
        logger.warning("Progress callback failed: %s", e)


async def validate_pbf_file(filepath: str) -> bool:
    """
    Validate that a PBF file appears to be valid.

    Performs basic checks:
    - File exists and is readable
    - File has minimum size
    - File starts with valid PBF header

    Args:
        filepath: Path to the PBF file

    Returns:
        True if file appears valid
    """
    try:
        if not os.path.exists(filepath):
            return False

        # Check minimum size (at least 1KB)
        size = os.path.getsize(filepath)
        if size < 1024:
            logger.warning("PBF file too small: %d bytes", size)
            return False

        # Check PBF magic bytes
        # PBF files start with a BlobHeader length (4 bytes big-endian)
        # followed by the string "OSMHeader" or "OSMData"
        with open(filepath, "rb") as f:
            header = f.read(32)

            # Basic sanity check - should have some data
            if len(header) < 16:
                return False

            # Look for "OSM" somewhere in the header area
            # (The exact position depends on the header length)
            if b"OSM" not in header:
                logger.warning("PBF file missing OSM marker in header")
                return False

        return True

    except Exception:
        logger.exception("Error validating PBF file: %s", filepath)
        return False


async def get_download_progress(region_id: str) -> dict[str, Any]:
    """
    Get download progress for a region.

    Args:
        region_id: MapRegion document ID

    Returns:
        Dictionary with progress info
    """
    from beanie import PydanticObjectId

    region = await MapRegion.get(PydanticObjectId(region_id))
    if not region:
        return {"error": "Region not found"}

    # Find active download job
    job = await MapDataJob.find_one(
        {
            "region_id": region.id,
            "job_type": MapDataJob.JOB_DOWNLOAD,
            "status": {"$in": [MapDataJob.STATUS_PENDING, MapDataJob.STATUS_RUNNING]},
        },
    )

    return {
        "region_id": str(region.id),
        "region_name": region.display_name,
        "status": region.status,
        "progress": region.download_progress,
        "file_size_mb": region.file_size_mb,
        "job": (
            {
                "id": str(job.id),
                "status": job.status,
                "stage": job.stage,
                "progress": job.progress,
                "message": job.message,
            }
            if job
            else None
        ),
    }
