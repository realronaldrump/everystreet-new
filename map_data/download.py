"""
Download orchestration for OSM data.

Handles streaming downloads from Geofabrik with progress tracking.
Supports parallel multi-connection downloads for maximum speed.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import httpx

try:
    import h2  # noqa: F401
except ImportError as exc:
    msg = "HTTP/2 is required. Install httpx[http2] (or h2) before running downloads."
    raise RuntimeError(msg) from exc

HAS_HTTP2 = True

from config import get_geofabrik_mirror, get_osm_extracts_path
from map_data.models import MapDataJob, MapRegion

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)


# =============================================================================
# Download Configuration - Optimized for gigabit connections
# =============================================================================

# Parallel download settings
PARALLEL_CONNECTIONS = 16  # Number of simultaneous download connections
SEGMENT_SIZE = 50 * 1024 * 1024  # 50MB per segment (minimum)
MIN_PARALLEL_SIZE = 10 * 1024 * 1024  # Only parallelize files > 10MB

# Timeout settings (seconds)
CONNECT_TIMEOUT = 30  # Time to establish connection
READ_TIMEOUT = 120  # Time to read data (per chunk, generous for slow segments)
TOTAL_TIMEOUT = 7200  # 2 hour max for entire download

# Chunk sizes
CHUNK_SIZE = 1024 * 1024  # 1MB chunks for streaming
PROGRESS_UPDATE_INTERVAL = 0.5  # Update progress every 0.5 seconds for responsiveness


class DownloadCancelled(Exception):
    """Raised when a download is cancelled."""


def _resolve_download_paths(region: MapRegion) -> tuple[str, str, str]:
    extracts_path = get_osm_extracts_path()
    output_filename = region.pbf_path
    if not output_filename:
        safe_name = region.name.replace("/", "_").replace(" ", "_")
        output_filename = f"{safe_name}.osm.pbf"
    output_path = os.path.join(extracts_path, output_filename)
    temp_dir = f"{output_path}.parts"
    temp_path = f"{output_path}.downloading"
    return output_path, temp_dir, temp_path


def cleanup_download_artifacts(region: MapRegion, remove_output: bool = False) -> None:
    output_path, temp_dir, temp_path = _resolve_download_paths(region)

    if os.path.exists(temp_path):
        with contextlib.suppress(Exception):
            os.remove(temp_path)
        logger.info("Deleted download temp file: %s", temp_path)

    if os.path.isdir(temp_dir):
        with contextlib.suppress(Exception):
            shutil.rmtree(temp_dir, ignore_errors=True)
        logger.info("Deleted download temp directory: %s", temp_dir)

    if remove_output and os.path.exists(output_path):
        with contextlib.suppress(Exception):
            os.remove(output_path)
        logger.info("Deleted download output file: %s", output_path)


@dataclass
class DownloadSegment:
    """Represents a single download segment."""

    index: int
    start_byte: int
    end_byte: int
    temp_path: str
    downloaded: int = 0
    complete: bool = False
    error: str | None = None


@dataclass
class DownloadProgress:
    """Aggregated download progress across all segments."""

    total_size: int
    segments: list[DownloadSegment] = field(default_factory=list)
    start_time: float = 0.0

    @property
    def downloaded(self) -> int:
        return sum(s.downloaded for s in self.segments)

    @property
    def percent(self) -> float:
        if self.total_size == 0:
            return 0.0
        return (self.downloaded / self.total_size) * 100

    @property
    def speed_mbps(self) -> float:
        """Calculate current download speed in MB/s."""
        if self.start_time == 0:
            return 0.0
        elapsed = asyncio.get_event_loop().time() - self.start_time
        if elapsed < 0.1:
            return 0.0
        return (self.downloaded / (1024 * 1024)) / elapsed


async def parallel_download_region(
    region: MapRegion,
    progress_callback: Callable[[float, str], Any] | None = None,
    cancel_event: asyncio.Event | None = None,
) -> str:
    """
    Download a region using parallel connections for maximum speed.

    Uses HTTP Range requests to download multiple segments simultaneously,
    then merges them into the final file.

    Args:
        region: MapRegion document with source_url
        progress_callback: Optional callback(progress_pct, message) for updates
        cancel_event: Optional asyncio.Event to cancel the download

    Returns:
        Path to the downloaded file (relative to osm_extracts)

    Raises:
        ValueError: If region doesn't have a source URL
        httpx.HTTPError: If download fails
    """
    if cancel_event and cancel_event.is_set():
        msg = "Download cancelled"
        raise DownloadCancelled(msg)

    if not region.source_url:
        mirror = get_geofabrik_mirror()
        region.source_url = f"{mirror}/{region.name}-latest.osm.pbf"
        await region.save()

    source_url = region.source_url
    extracts_path = get_osm_extracts_path()

    os.makedirs(extracts_path, exist_ok=True)

    safe_name = region.name.replace("/", "_").replace(" ", "_")
    output_filename = f"{safe_name}.osm.pbf"
    output_path = os.path.join(extracts_path, output_filename)
    temp_dir = f"{output_path}.parts"

    logger.info("Starting parallel download: %s -> %s", source_url, output_path)

    try:
        # Check if server supports range requests and get file size
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(CONNECT_TIMEOUT),
            follow_redirects=True,
        ) as client:
            head_response = await client.head(source_url)
            head_response.raise_for_status()

            total_size = int(head_response.headers.get("content-length", 0))
            accept_ranges = head_response.headers.get("accept-ranges", "none")
            supports_ranges = accept_ranges.lower() != "none" and total_size > 0

        if not supports_ranges or total_size < MIN_PARALLEL_SIZE:
            logger.info(
                "Server doesn't support ranges or file too small, using single stream",
            )
            return await stream_download_region(
                region,
                progress_callback,
                cancel_event=cancel_event,
            )

        # Create segments directory
        os.makedirs(temp_dir, exist_ok=True)

        # Calculate segments
        num_segments = min(PARALLEL_CONNECTIONS, max(1, total_size // SEGMENT_SIZE))
        segment_size = total_size // num_segments

        progress = DownloadProgress(total_size=total_size)

        for i in range(num_segments):
            start = i * segment_size
            # Last segment gets any remaining bytes
            end = (
                total_size - 1 if i == num_segments - 1 else (i + 1) * segment_size - 1
            )
            segment = DownloadSegment(
                index=i,
                start_byte=start,
                end_byte=end,
                temp_path=os.path.join(temp_dir, f"part_{i:04d}"),
            )
            progress.segments.append(segment)

        size_mb = total_size / (1024 * 1024)
        logger.info(
            "Downloading %.1f MB in %d parallel segments",
            size_mb,
            num_segments,
        )

        if progress_callback:
            await _safe_callback(
                progress_callback,
                0,
                f"Starting parallel download ({size_mb:.1f} MB, {num_segments} connections)",
            )

        progress.start_time = asyncio.get_event_loop().time()

        if cancel_event and cancel_event.is_set():
            msg = "Download cancelled"
            raise DownloadCancelled(msg)

        # Start progress reporter task
        progress_task = asyncio.create_task(
            _report_progress(progress, progress_callback),
        )

        # Download all segments in parallel
        try:
            await asyncio.gather(
                *[
                    _download_segment(
                        source_url,
                        segment,
                        progress,
                        cancel_event=cancel_event,
                    )
                    for segment in progress.segments
                ],
            )
        finally:
            progress_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await progress_task

        if cancel_event and cancel_event.is_set():
            msg = "Download cancelled"
            raise DownloadCancelled(msg)

        # Check for segment errors
        failed_segments = [s for s in progress.segments if s.error]
        if failed_segments:
            errors = "; ".join(f"Segment {s.index}: {s.error}" for s in failed_segments)
            msg = f"Download failed: {errors}"
            raise RuntimeError(msg)

        # Merge segments into final file
        if cancel_event and cancel_event.is_set():
            msg = "Download cancelled"
            raise DownloadCancelled(msg)

        if progress_callback:
            await _safe_callback(progress_callback, 99, "Merging segments...")

        await _merge_segments(progress.segments, output_path)

        # Cleanup temp directory
        for segment in progress.segments:
            with contextlib.suppress(Exception):
                os.remove(segment.temp_path)
        with contextlib.suppress(Exception):
            os.rmdir(temp_dir)

        # Update region
        region.pbf_path = output_filename
        region.file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
        region.downloaded_at = datetime.now(UTC)
        region.status = MapRegion.STATUS_DOWNLOADED
        region.download_progress = 100.0
        region.updated_at = datetime.now(UTC)
        await region.save()

        elapsed = asyncio.get_event_loop().time() - progress.start_time
        avg_speed = (total_size / (1024 * 1024)) / elapsed if elapsed > 0 else 0

        if progress_callback:
            await _safe_callback(
                progress_callback,
                100,
                f"Download complete ({region.file_size_mb:.1f} MB at {avg_speed:.1f} MB/s)",
            )

        logger.info(
            "Download complete: %s (%.1f MB in %.1fs, avg %.1f MB/s)",
            output_path,
            region.file_size_mb,
            elapsed,
            avg_speed,
        )

        return output_filename

    except DownloadCancelled:
        cleanup_download_artifacts(
            region,
            remove_output=region.downloaded_at is None,
        )
        raise
    except asyncio.CancelledError:
        cleanup_download_artifacts(
            region,
            remove_output=region.downloaded_at is None,
        )
        raise
    except Exception:
        # Cleanup on error
        if os.path.exists(temp_dir):
            for f in os.listdir(temp_dir):
                with contextlib.suppress(Exception):
                    os.remove(os.path.join(temp_dir, f))
            with contextlib.suppress(Exception):
                os.rmdir(temp_dir)

        logger.exception("Parallel download failed for %s", region.name)
        raise


async def _download_segment(
    url: str,
    segment: DownloadSegment,
    progress: DownloadProgress,
    cancel_event: asyncio.Event | None = None,
) -> None:
    """Download a single segment using range request."""
    if cancel_event and cancel_event.is_set():
        msg = "Download cancelled"
        raise DownloadCancelled(msg)
    headers = {"Range": f"bytes={segment.start_byte}-{segment.end_byte}"}

    # Check for existing partial download
    if os.path.exists(segment.temp_path):
        existing_size = os.path.getsize(segment.temp_path)
        expected_size = segment.end_byte - segment.start_byte + 1
        if existing_size == expected_size:
            # Already complete
            segment.downloaded = existing_size
            segment.complete = True
            logger.debug("Segment %d already complete", segment.index)
            return
        if existing_size > 0:
            # Resume from where we left off
            segment.start_byte += existing_size
            segment.downloaded = existing_size
            headers = {"Range": f"bytes={segment.start_byte}-{segment.end_byte}"}
            logger.debug(
                "Resuming segment %d from byte %d",
                segment.index,
                segment.start_byte,
            )

    try:
        timeout = httpx.Timeout(
            connect=CONNECT_TIMEOUT,
            read=READ_TIMEOUT,
            write=30.0,
            pool=30.0,
        )

        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            http2=HAS_HTTP2,  # HTTP/2 is required
        ) as client:
            async with client.stream("GET", url, headers=headers) as response:
                # Accept both 200 (full) and 206 (partial content)
                if response.status_code not in (200, 206):
                    segment.error = f"HTTP {response.status_code}"
                    return

                mode = "ab" if segment.downloaded > 0 else "wb"
                with open(segment.temp_path, mode) as f:
                    async for chunk in response.aiter_bytes(chunk_size=CHUNK_SIZE):
                        if cancel_event and cancel_event.is_set():
                            msg = "Download cancelled"
                            raise DownloadCancelled(msg)
                        f.write(chunk)
                        segment.downloaded += len(chunk)

        segment.complete = True

    except DownloadCancelled:
        segment.error = "cancelled"
        raise
    except asyncio.CancelledError:
        segment.error = "cancelled"
        raise
    except Exception as e:
        segment.error = str(e)
        logger.warning("Segment %d failed: %s", segment.index, e)


async def _report_progress(
    progress: DownloadProgress,
    callback: Callable[[float, str], Any] | None,
) -> None:
    """Periodically report aggregated progress."""
    if not callback:
        return

    try:
        while True:
            await asyncio.sleep(PROGRESS_UPDATE_INTERVAL)

            downloaded_mb = progress.downloaded / (1024 * 1024)
            total_mb = progress.total_size / (1024 * 1024)
            speed = progress.speed_mbps
            active = sum(1 for s in progress.segments if not s.complete and not s.error)

            message = (
                f"Downloaded {downloaded_mb:.1f} / {total_mb:.1f} MB "
                f"({speed:.1f} MB/s, {active} active)"
            )

            await _safe_callback(callback, progress.percent, message)

    except asyncio.CancelledError:
        pass


async def _merge_segments(segments: list[DownloadSegment], output_path: str) -> None:
    """Merge downloaded segments into final file."""
    # Sort by index to ensure correct order
    sorted_segments = sorted(segments, key=lambda s: s.index)

    # Use async file I/O for better performance
    loop = asyncio.get_event_loop()

    def _do_merge() -> None:
        with open(output_path, "wb") as outfile:
            for segment in sorted_segments:
                with open(segment.temp_path, "rb") as infile:
                    while True:
                        chunk = infile.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        outfile.write(chunk)

    await loop.run_in_executor(None, _do_merge)


async def stream_download_region(
    region: MapRegion,
    progress_callback: Callable[[float, str], Any] | None = None,
    cancel_event: asyncio.Event | None = None,
) -> str:
    """
    Stream download a region's PBF file from Geofabrik (single connection fallback).

    Args:
        region: MapRegion document with source_url
        progress_callback: Optional callback(progress_pct, message) for updates
        cancel_event: Optional asyncio.Event to cancel the download

    Returns:
        Path to the downloaded file (relative to osm_extracts)

    Raises:
        ValueError: If region doesn't have a source URL
        httpx.HTTPError: If download fails
    """
    if cancel_event and cancel_event.is_set():
        msg = "Download cancelled"
        raise DownloadCancelled(msg)

    if not region.source_url:
        mirror = get_geofabrik_mirror()
        region.source_url = f"{mirror}/{region.name}-latest.osm.pbf"
        await region.save()

    source_url = region.source_url
    extracts_path = get_osm_extracts_path()

    os.makedirs(extracts_path, exist_ok=True)

    safe_name = region.name.replace("/", "_").replace(" ", "_")
    output_filename = f"{safe_name}.osm.pbf"
    output_path = os.path.join(extracts_path, output_filename)
    temp_path = f"{output_path}.downloading"

    logger.info("Starting single-stream download: %s -> %s", source_url, output_path)

    try:
        timeout = httpx.Timeout(
            connect=CONNECT_TIMEOUT,
            read=READ_TIMEOUT,
            write=30.0,
            pool=30.0,
        )

        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            http2=HAS_HTTP2,
        ) as client:
            async with client.stream("GET", source_url) as response:
                response.raise_for_status()

                total_size = int(response.headers.get("content-length", 0))
                downloaded = 0
                last_progress_update = 0.0
                start_time = asyncio.get_event_loop().time()

                if progress_callback:
                    size_mb = total_size / (1024 * 1024) if total_size else 0
                    await _safe_callback(
                        progress_callback,
                        0,
                        f"Starting download ({size_mb:.1f} MB)",
                    )

                with open(temp_path, "wb") as f:
                    async for chunk in response.aiter_bytes(chunk_size=CHUNK_SIZE):
                        if cancel_event and cancel_event.is_set():
                            msg = "Download cancelled"
                            raise DownloadCancelled(msg)
                        f.write(chunk)
                        downloaded += len(chunk)

                        now = asyncio.get_event_loop().time()
                        if now - last_progress_update >= PROGRESS_UPDATE_INTERVAL:
                            if total_size > 0:
                                progress = (downloaded / total_size) * 100
                                downloaded_mb = downloaded / (1024 * 1024)
                                total_mb = total_size / (1024 * 1024)
                                elapsed = now - start_time
                                speed = downloaded_mb / elapsed if elapsed > 0 else 0

                                if progress_callback:
                                    await _safe_callback(
                                        progress_callback,
                                        progress,
                                        f"Downloaded {downloaded_mb:.1f} / {total_mb:.1f} MB ({speed:.1f} MB/s)",
                                    )
                            last_progress_update = now

                os.rename(temp_path, output_path)

                region.pbf_path = output_filename
                region.file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
                region.downloaded_at = datetime.now(UTC)
                region.status = MapRegion.STATUS_DOWNLOADED
                region.download_progress = 100.0
                region.updated_at = datetime.now(UTC)
                await region.save()

                elapsed = asyncio.get_event_loop().time() - start_time
                avg_speed = region.file_size_mb / elapsed if elapsed > 0 else 0

                if progress_callback:
                    await _safe_callback(
                        progress_callback,
                        100,
                        f"Download complete ({region.file_size_mb:.1f} MB at {avg_speed:.1f} MB/s)",
                    )

                logger.info(
                    "Download complete: %s (%.1f MB)",
                    output_path,
                    region.file_size_mb,
                )

                return output_filename

    except DownloadCancelled:
        cleanup_download_artifacts(
            region,
            remove_output=region.downloaded_at is None,
        )
        raise
    except asyncio.CancelledError:
        cleanup_download_artifacts(
            region,
            remove_output=region.downloaded_at is None,
        )
        raise
    except Exception:
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

        size = os.path.getsize(filepath)
        if size < 1024:
            logger.warning("PBF file too small: %d bytes", size)
            return False

        with open(filepath, "rb") as f:
            header = f.read(32)

            if len(header) < 16:
                return False

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
