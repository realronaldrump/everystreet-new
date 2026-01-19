"""
Build orchestration for Nominatim and Valhalla.

Handles triggering and monitoring builds using Docker SDK.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from datetime import UTC, datetime
from typing import Any, Callable

from config import get_osm_extracts_path
from map_data.models import MapDataJob, MapRegion

logger = logging.getLogger(__name__)

# Build configuration
BUILD_TIMEOUT = 7200  # 2 hours max build time
PROGRESS_UPDATE_INTERVAL = 5.0  # Update progress every 5 seconds


async def build_nominatim_data(
    region: MapRegion,
    progress_callback: Callable[[float, str], Any] | None = None,
) -> bool:
    """
    Build Nominatim data from a downloaded PBF file.

    This executes the nominatim import command inside the Nominatim container.

    Args:
        region: MapRegion with downloaded PBF file
        progress_callback: Optional callback(progress_pct, message) for updates

    Returns:
        True if build succeeded

    Raises:
        ValueError: If region doesn't have a downloaded PBF
        RuntimeError: If build fails
    """
    if not region.pbf_path:
        raise ValueError("Region has no downloaded PBF file")

    extracts_path = get_osm_extracts_path()
    pbf_full_path = os.path.join(extracts_path, region.pbf_path)

    if not os.path.exists(pbf_full_path):
        raise ValueError(f"PBF file not found: {pbf_full_path}")

    logger.info("Starting Nominatim build for %s", region.display_name)

    if progress_callback:
        await _safe_callback(progress_callback, 5, "Preparing Nominatim import...")

    try:
        # The Nominatim container expects the PBF file at /nominatim/data/
        # Our docker-compose mounts osm_extracts:/nominatim/data:ro
        # So the file should be accessible inside the container

        # For now, we'll use docker exec to run the import
        # In production, you might want to use the Docker SDK for better control

        # Note: Nominatim import is a blocking operation that can take hours
        # for large regions. We simulate progress updates here.

        if progress_callback:
            await _safe_callback(progress_callback, 10, "Starting Nominatim import...")

        # Execute nominatim import command
        # The container name is 'nominatim' based on docker-compose service name
        container_name = _get_container_name("nominatim")

        # Build the import command
        # The PBF path inside container is /nominatim/data/{filename}
        pbf_container_path = f"/nominatim/data/{region.pbf_path}"

        import_cmd = [
            "docker", "exec", container_name,
            "nominatim", "import",
            "--osm-file", pbf_container_path,
            "--threads", "4",
        ]

        logger.info("Running Nominatim import: %s", " ".join(import_cmd))

        if progress_callback:
            await _safe_callback(progress_callback, 15, "Running Nominatim import (this may take a while)...")

        # Run the import command
        # This is a long-running process, so we run it asynchronously
        process = await asyncio.create_subprocess_exec(
            *import_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Monitor progress by reading output
        progress = 15
        while True:
            # Check if process is still running
            if process.returncode is not None:
                break

            # Update progress estimate (Nominatim doesn't provide real progress)
            # We simulate progress based on time elapsed
            progress = min(progress + 5, 90)
            if progress_callback:
                await _safe_callback(progress_callback, progress, "Nominatim import in progress...")

            await asyncio.sleep(PROGRESS_UPDATE_INTERVAL)

            # Poll for completion
            try:
                await asyncio.wait_for(process.wait(), timeout=PROGRESS_UPDATE_INTERVAL)
            except asyncio.TimeoutError:
                continue

        # Get final output
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown error"
            logger.error("Nominatim import failed: %s", error_msg)
            raise RuntimeError(f"Nominatim import failed: {error_msg}")

        if progress_callback:
            await _safe_callback(progress_callback, 95, "Restarting Nominatim service...")

        # Restart Nominatim to pick up new data
        await _restart_container("nominatim")

        if progress_callback:
            await _safe_callback(progress_callback, 100, "Nominatim build complete")

        logger.info("Nominatim build complete for %s", region.display_name)
        return True

    except Exception as e:
        logger.exception("Nominatim build failed for %s", region.display_name)
        raise


async def build_valhalla_tiles(
    region: MapRegion,
    progress_callback: Callable[[float, str], Any] | None = None,
) -> bool:
    """
    Build Valhalla tiles from a downloaded PBF file.

    This executes the valhalla_build_tiles command inside the Valhalla container.

    Args:
        region: MapRegion with downloaded PBF file
        progress_callback: Optional callback(progress_pct, message) for updates

    Returns:
        True if build succeeded

    Raises:
        ValueError: If region doesn't have a downloaded PBF
        RuntimeError: If build fails
    """
    if not region.pbf_path:
        raise ValueError("Region has no downloaded PBF file")

    extracts_path = get_osm_extracts_path()
    pbf_full_path = os.path.join(extracts_path, region.pbf_path)

    if not os.path.exists(pbf_full_path):
        raise ValueError(f"PBF file not found: {pbf_full_path}")

    logger.info("Starting Valhalla build for %s", region.display_name)

    if progress_callback:
        await _safe_callback(progress_callback, 5, "Preparing Valhalla tile build...")

    try:
        # The Valhalla container expects PBF at /data/osm/
        # Our docker-compose mounts osm_extracts:/data/osm:ro

        if progress_callback:
            await _safe_callback(progress_callback, 10, "Starting Valhalla tile build...")

        container_name = _get_container_name("valhalla")

        # Build command for Valhalla
        # The PBF path inside container is /data/osm/{filename}
        pbf_container_path = f"/data/osm/{region.pbf_path}"

        build_cmd = [
            "docker", "exec", container_name,
            "valhalla_build_tiles",
            "-c", "/custom_files/valhalla.json",
            pbf_container_path,
        ]

        logger.info("Running Valhalla build: %s", " ".join(build_cmd))

        if progress_callback:
            await _safe_callback(progress_callback, 15, "Building Valhalla tiles (this may take a while)...")

        # Run the build command
        process = await asyncio.create_subprocess_exec(
            *build_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Monitor progress
        progress = 15
        while True:
            if process.returncode is not None:
                break

            progress = min(progress + 5, 90)
            if progress_callback:
                await _safe_callback(progress_callback, progress, "Building Valhalla tiles...")

            await asyncio.sleep(PROGRESS_UPDATE_INTERVAL)

            try:
                await asyncio.wait_for(process.wait(), timeout=PROGRESS_UPDATE_INTERVAL)
            except asyncio.TimeoutError:
                continue

        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown error"
            logger.error("Valhalla build failed: %s", error_msg)
            raise RuntimeError(f"Valhalla build failed: {error_msg}")

        if progress_callback:
            await _safe_callback(progress_callback, 95, "Restarting Valhalla service...")

        # Restart Valhalla to pick up new tiles
        await _restart_container("valhalla")

        if progress_callback:
            await _safe_callback(progress_callback, 100, "Valhalla build complete")

        logger.info("Valhalla build complete for %s", region.display_name)
        return True

    except Exception as e:
        logger.exception("Valhalla build failed for %s", region.display_name)
        raise


def _get_container_name(service_name: str) -> str:
    """
    Get the Docker container name for a service.

    By default, docker-compose names containers as {project}_{service}_1
    or {project}-{service}-1 depending on version.

    Args:
        service_name: The service name from docker-compose.yml

    Returns:
        The container name to use with docker exec
    """
    # Try to find the container using docker ps
    try:
        result = subprocess.run(
            ["docker", "ps", "--filter", f"name={service_name}", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            # Return the first matching container
            containers = result.stdout.strip().split("\n")
            for container in containers:
                if service_name in container:
                    return container
    except Exception as e:
        logger.warning("Failed to lookup container name: %s", e)

    # Fallback: try common naming patterns
    # Modern docker-compose uses project-service-1
    # Older versions use project_service_1
    return service_name


async def _restart_container(service_name: str) -> None:
    """
    Restart a Docker container.

    Args:
        service_name: The service name to restart
    """
    container_name = _get_container_name(service_name)

    try:
        logger.info("Restarting container: %s", container_name)

        process = await asyncio.create_subprocess_exec(
            "docker", "restart", container_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown error"
            logger.warning("Failed to restart container %s: %s", container_name, error_msg)
        else:
            logger.info("Container restarted: %s", container_name)

        # Wait for service to be ready
        await asyncio.sleep(5)

    except Exception as e:
        logger.warning("Error restarting container %s: %s", container_name, e)


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


async def check_container_running(service_name: str) -> bool:
    """
    Check if a container is running.

    Args:
        service_name: The service name to check

    Returns:
        True if container is running
    """
    try:
        result = subprocess.run(
            ["docker", "ps", "--filter", f"name={service_name}", "--filter", "status=running", "-q"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return bool(result.stdout.strip())
    except Exception as e:
        logger.warning("Failed to check container status: %s", e)
        return False
