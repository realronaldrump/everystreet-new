"""
Build orchestration for Nominatim and Valhalla.

Handles triggering and monitoring builds using Docker SDK.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from typing import TYPE_CHECKING, Any

from config import get_osm_extracts_path

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

# Build configuration
BUILD_TIMEOUT = 7200  # 2 hours max build time
PROGRESS_UPDATE_INTERVAL = 5.0  # Update progress every 5 seconds
CONTAINER_START_TIMEOUT = 120  # seconds to wait for container to start


async def start_container_on_demand(
    service_name: str,
    compose_file: str = "docker-compose.yml",
) -> bool:
    """
    Start a Docker container using docker compose.

    This is used to start Nominatim/Valhalla containers on-demand before builds.
    Even with restart policies, containers may be stopped between imports, so we
    explicitly start them when needed.

    Supports both Docker Compose v2 (docker compose) and v1 (docker-compose).

    Args:
        service_name: The service name from docker-compose.yml
        compose_file: Path to docker-compose.yml

    Returns:
        True if container is running (started or was already running)

    Raises:
        RuntimeError: If container fails to start
    """
    # Check if already running
    if await check_container_running(service_name):
        logger.info("Container %s is already running", service_name)
        return True

    logger.info("Starting container %s on demand...", service_name)

    # Try modern docker compose first, then fall back to legacy docker-compose
    compose_commands = [
        # Docker Compose v2 (plugin): docker compose
        ["docker", "compose", "-f", compose_file, "up", "-d", service_name],
        # Docker Compose v1 (standalone): docker-compose
        ["docker-compose", "-f", compose_file, "up", "-d", service_name],
    ]

    last_error = None
    for cmd in compose_commands:
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            _, stderr = await process.communicate()

            error_msg = stderr.decode() if stderr else ""

            # Check if the docker compose subcommand is not available
            # This happens when Docker Compose V2 plugin is not installed
            # and we run "docker compose" - docker interprets "compose" as
            # a command and "-f" as a flag to docker itself
            if process.returncode != 0 and (
                "unknown shorthand flag" in error_msg
                or "is not a docker command" in error_msg
                or "'compose' is not a docker command" in error_msg
            ):
                logger.debug(
                    "Docker Compose V2 not available, trying legacy docker-compose"
                )
                continue

            if process.returncode == 0:
                # Command succeeded, wait for container to be running
                logger.info("Waiting for container %s to become ready...", service_name)
                start_time = asyncio.get_event_loop().time()

                while (
                    asyncio.get_event_loop().time() - start_time
                ) < CONTAINER_START_TIMEOUT:
                    if await check_container_running(service_name):
                        logger.info("Container %s is now running", service_name)
                        # Give the service a moment to initialize
                        await asyncio.sleep(5)
                        return True
                    await asyncio.sleep(2)

                # Timeout - container didn't start
                logger.error("Container %s did not start within timeout", service_name)
                msg = (
                    f"Container {service_name} did not start within "
                    f"{CONTAINER_START_TIMEOUT}s"
                )
                raise RuntimeError(msg)

            # Command failed for other reasons, save error and try next
            last_error = error_msg or "Unknown error"
            logger.debug(
                "Command %s failed for %s: %s, trying next",
                cmd[0:2],
                service_name,
                last_error,
            )
        except FileNotFoundError:
            # docker-compose binary not found, try next command
            logger.debug("Command %s not found, trying next", cmd[0])
            continue
        except RuntimeError:
            raise

    # All commands failed
    logger.error("Failed to start container %s: %s", service_name, last_error)
    msg = f"Failed to start {service_name}: {last_error}"
    raise RuntimeError(msg)


async def build_nominatim_data(
    pbf_path: str,
    *,
    label: str = "selected states",
    progress_callback: Callable[[float, str], Any] | None = None,
) -> bool:
    """
    Build Nominatim data from a downloaded PBF file.

    This executes the nominatim import command inside the Nominatim container.

    Args:
        pbf_path: Relative PBF path inside the osm extracts volume
        label: Human-readable label for logging
        progress_callback: Optional callback(progress_pct, message) for updates

    Returns:
        True if build succeeded

    Raises:
        ValueError: If region doesn't have a downloaded PBF
        RuntimeError: If build fails
    """
    pbf_full_path, pbf_relative = _resolve_pbf_path(pbf_path)

    if not os.path.exists(pbf_full_path):
        msg = f"PBF file not found: {pbf_full_path}"
        raise ValueError(msg)

    logger.info("Starting Nominatim build for %s", label)

    if progress_callback:
        await _safe_callback(progress_callback, 2, "Checking Nominatim container...")

    try:
        # Ensure the Nominatim container is running before we try to import
        if progress_callback:
            await _safe_callback(
                progress_callback,
                5,
                "Starting Nominatim container...",
            )

        await start_container_on_demand("nominatim")

        # The Nominatim container expects the PBF file at /nominatim/data/
        # Our docker-compose mounts osm_extracts:/nominatim/data:ro
        # So the file should be accessible inside the container

        # Note: Nominatim import is a blocking operation that can take hours
        # for large regions. We simulate progress updates here.

        if progress_callback:
            await _safe_callback(progress_callback, 10, "Starting Nominatim import...")

        # Execute nominatim import command
        # The container name is 'nominatim' based on docker-compose service name
        container_name = _get_container_name("nominatim")

        # Build the import command
        # The PBF path inside container is /nominatim/data/{filename}
        pbf_container_path = f"/nominatim/data/{pbf_relative}"

        import_cmd = [
            "docker",
            "exec",
            "--user",
            "nominatim",
            container_name,
            "nominatim",
            "import",
            "--osm-file",
            pbf_container_path,
            "--threads",
            "4",
        ]

        logger.info("Running Nominatim import: %s", " ".join(import_cmd))

        if progress_callback:
            await _safe_callback(
                progress_callback,
                15,
                "Running Nominatim import (this may take a while)...",
            )

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
                await _safe_callback(
                    progress_callback,
                    progress,
                    "Nominatim import in progress...",
                )

            await asyncio.sleep(PROGRESS_UPDATE_INTERVAL)

            # Poll for completion
            try:
                await asyncio.wait_for(process.wait(), timeout=PROGRESS_UPDATE_INTERVAL)
            except TimeoutError:
                continue

        # Get final output
        _stdout, stderr = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown error"
            logger.error("Nominatim import failed: %s", error_msg)
            msg = f"Nominatim import failed: {error_msg}"
            raise RuntimeError(msg)

        if progress_callback:
            await _safe_callback(
                progress_callback,
                95,
                "Restarting Nominatim service...",
            )

        await _mark_nominatim_import_finished(container_name)

        # Restart Nominatim to pick up new data
        await _restart_container("nominatim")

        if progress_callback:
            await _safe_callback(progress_callback, 100, "Nominatim build complete")

        logger.info("Nominatim build complete for %s", label)
        return True

    except Exception:
        logger.exception("Nominatim build failed for %s", label)
        raise


async def build_valhalla_tiles(
    pbf_path: str,
    *,
    label: str = "selected states",
    progress_callback: Callable[[float, str], Any] | None = None,
) -> bool:
    """
    Build Valhalla tiles from a downloaded PBF file.

    This executes the valhalla_build_tiles command inside the Valhalla container.

    Args:
        pbf_path: Relative PBF path inside the osm extracts volume
        label: Human-readable label for logging
        progress_callback: Optional callback(progress_pct, message) for updates

    Returns:
        True if build succeeded

    Raises:
        ValueError: If region doesn't have a downloaded PBF
        RuntimeError: If build fails
    """
    pbf_full_path, pbf_relative = _resolve_pbf_path(pbf_path)

    if not os.path.exists(pbf_full_path):
        msg = f"PBF file not found: {pbf_full_path}"
        raise ValueError(msg)

    logger.info("Starting Valhalla build for %s", label)

    if progress_callback:
        await _safe_callback(progress_callback, 2, "Checking Valhalla container...")

    try:
        # Ensure the Valhalla container is running before we try to build
        if progress_callback:
            await _safe_callback(progress_callback, 5, "Starting Valhalla container...")

        await start_container_on_demand("valhalla")

        # The Valhalla container expects PBF at /data/osm/
        # Our docker-compose mounts osm_extracts:/data/osm:ro

        if progress_callback:
            await _safe_callback(
                progress_callback,
                10,
                "Starting Valhalla tile build...",
            )

        container_name = _get_container_name("valhalla")

        # Build command for Valhalla
        # The PBF path inside container is /data/osm/{filename}
        pbf_container_path = f"/data/osm/{pbf_relative}"

        build_cmd = [
            "docker",
            "exec",
            container_name,
            "valhalla_build_tiles",
            "-c",
            "/custom_files/valhalla.json",
            pbf_container_path,
        ]

        logger.info("Running Valhalla build: %s", " ".join(build_cmd))

        if progress_callback:
            await _safe_callback(
                progress_callback,
                15,
                "Building Valhalla tiles (this may take a while)...",
            )

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
                await _safe_callback(
                    progress_callback,
                    progress,
                    "Building Valhalla tiles...",
                )

            await asyncio.sleep(PROGRESS_UPDATE_INTERVAL)

            try:
                await asyncio.wait_for(process.wait(), timeout=PROGRESS_UPDATE_INTERVAL)
            except TimeoutError:
                continue

        _stdout, stderr = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown error"
            logger.error("Valhalla build failed: %s", error_msg)
            msg = f"Valhalla build failed: {error_msg}"
            raise RuntimeError(msg)

        if progress_callback:
            await _safe_callback(
                progress_callback,
                95,
                "Restarting Valhalla service...",
            )

        # Restart Valhalla to pick up new tiles
        await _restart_container("valhalla")

        if progress_callback:
            await _safe_callback(progress_callback, 100, "Valhalla build complete")

        logger.info("Valhalla build complete for %s", label)
        return True

    except Exception:
        logger.exception("Valhalla build failed for %s", label)
        raise


def _resolve_pbf_path(pbf_path: str) -> tuple[str, str]:
    extracts_path = get_osm_extracts_path()
    if os.path.isabs(pbf_path):
        pbf_full_path = pbf_path
        pbf_relative = os.path.relpath(pbf_full_path, extracts_path)
    else:
        pbf_relative = pbf_path
        pbf_full_path = os.path.join(extracts_path, pbf_path)

    if pbf_relative.startswith(".."):
        msg = f"PBF path must be within extracts volume: {pbf_path}"
        raise ValueError(msg)

    return pbf_full_path, pbf_relative


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
            [
                "docker",
                "ps",
                "--filter",
                f"name={service_name}",
                "--format",
                "{{.Names}}",
            ],
            check=False,
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
            "docker",
            "restart",
            container_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        _stdout, stderr = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown error"
            logger.warning(
                "Failed to restart container %s: %s",
                container_name,
                error_msg,
            )
        else:
            logger.info("Container restarted: %s", container_name)

        # Wait for service to be ready
        await asyncio.sleep(5)

    except Exception as e:
        logger.warning("Error restarting container %s: %s", container_name, e)


async def _mark_nominatim_import_finished(container_name: str) -> None:
    marker_cmd = [
        "docker",
        "exec",
        container_name,
        "sh",
        "-c",
        "if [ -d /var/lib/postgresql/16/main ]; then "
        "touch /var/lib/postgresql/16/main/import-finished; "
        "elif [ -d /var/lib/postgresql/14/main ]; then "
        "touch /var/lib/postgresql/14/main/import-finished; "
        "else "
        "touch /var/lib/postgresql/import-finished; "
        "fi",
    ]

    try:
        process = await asyncio.create_subprocess_exec(
            *marker_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await process.communicate()
        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown error"
            logger.warning("Failed to set Nominatim import marker: %s", error_msg)
        else:
            logger.info("Set Nominatim import finished marker")
    except Exception as e:
        logger.warning("Error setting Nominatim import marker: %s", e)


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
            [
                "docker",
                "ps",
                "--filter",
                f"name={service_name}",
                "--filter",
                "status=running",
                "-q",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return bool(result.stdout.strip())
    except Exception as e:
        logger.warning("Failed to check container status: %s", e)
        return False
