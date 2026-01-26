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
                    "Docker Compose V2 not available, trying legacy docker-compose",
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

        # Wait for PostgreSQL to be ready inside the container
        if progress_callback:
            await _safe_callback(
                progress_callback,
                8,
                "Waiting for database to be ready...",
            )

        await _wait_for_nominatim_db_ready()

        if progress_callback:
            await _safe_callback(progress_callback, 10, "Starting Nominatim import...")

        container_name = _get_container_name("nominatim")
        pbf_container_path = f"/nominatim/data/{pbf_relative}"

        # First, check if the file is accessible in the container
        check_cmd = [
            "docker",
            "exec",
            container_name,
            "ls",
            "-la",
            pbf_container_path,
        ]
        check_result = subprocess.run(
            check_cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if check_result.returncode != 0:
            msg = f"PBF file not accessible in container: {pbf_container_path}"
            raise ValueError(msg)

        logger.info("PBF file verified in container: %s", pbf_container_path)

        # Build the import command
        # Note: We do NOT use -u nominatim here. The nominatim CLI handles
        # user switching internally when needed. Running as root allows
        # proper access to files and the PostgreSQL socket.
        import_cmd = [
            "docker",
            "exec",
            "-e",
            "NOMINATIM_QUERY_TIMEOUT=600",
            "-e",
            "NOMINATIM_REQUEST_TIMEOUT=600",
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
                "Importing map data (this may take a while)...",
            )

        # Run the import command with output streaming for better progress
        process = await asyncio.create_subprocess_exec(
            *import_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        # Monitor progress by reading output lines
        progress = 15
        last_log_time = asyncio.get_event_loop().time()
        output_lines = []

        while True:
            try:
                line = await asyncio.wait_for(
                    process.stdout.readline(),
                    timeout=PROGRESS_UPDATE_INTERVAL,
                )
                if line:
                    decoded = line.decode("utf-8", errors="replace").strip()
                    if decoded:
                        output_lines.append(decoded)
                        # Keep only last 50 lines
                        if len(output_lines) > 50:
                            output_lines.pop(0)

                        # Update progress based on Nominatim output stages
                        if "Importing OSM" in decoded or "Loading data" in decoded:
                            progress = max(progress, 25)
                        elif "Building index" in decoded or "Indexing" in decoded:
                            progress = max(progress, 50)
                        elif "Ranking" in decoded:
                            progress = max(progress, 70)
                        elif "Analysing" in decoded:
                            progress = max(progress, 80)

                        now = asyncio.get_event_loop().time()
                        if now - last_log_time >= PROGRESS_UPDATE_INTERVAL:
                            last_log_time = now
                            if progress_callback:
                                # Extract meaningful stage from output
                                stage = "Processing..."
                                for line_text in reversed(output_lines[-5:]):
                                    if any(
                                        kw in line_text.lower()
                                        for kw in [
                                            "import",
                                            "index",
                                            "load",
                                            "analys",
                                            "rank",
                                        ]
                                    ):
                                        stage = (
                                            line_text[:60] + "..."
                                            if len(line_text) > 60
                                            else line_text
                                        )
                                        break
                                await _safe_callback(progress_callback, progress, stage)
                elif process.returncode is not None:
                    break
            except TimeoutError:
                # Timeout just means no output, check if process is still running
                if process.returncode is not None:
                    break
                # Still running, update progress slowly
                progress = min(progress + 1, 88)
                if progress_callback:
                    await _safe_callback(
                        progress_callback,
                        progress,
                        "Import in progress...",
                    )

        # Wait for process to complete
        await process.wait()

        if process.returncode != 0:
            error_output = "\n".join(output_lines[-20:])
            logger.error("Nominatim import failed. Last output:\n%s", error_output)
            msg = f"Nominatim import failed (exit code {process.returncode})"
            raise RuntimeError(msg)

        if progress_callback:
            await _safe_callback(
                progress_callback,
                92,
                "Finalizing import...",
            )

        await _mark_nominatim_import_finished(container_name)

        if progress_callback:
            await _safe_callback(
                progress_callback,
                95,
                "Restarting Nominatim service...",
            )

        # Restart Nominatim to pick up new data
        await _restart_container("nominatim")

        # Wait for service to become healthy
        if progress_callback:
            await _safe_callback(
                progress_callback,
                98,
                "Verifying service is ready...",
            )

        await _wait_for_nominatim_healthy()

        if progress_callback:
            await _safe_callback(progress_callback, 100, "Nominatim build complete")

        logger.info("Nominatim build complete for %s", label)
        return True

    except Exception as e:
        logger.exception("Nominatim build failed for %s: %s", label, e)
        raise


async def _wait_for_nominatim_db_ready(timeout: int = 120) -> None:
    """
    Wait for PostgreSQL to be ready inside the Nominatim container.

    NOTE: This checks that PostgreSQL is accepting connections using the
    'postgres' database (which always exists), NOT the 'nominatim' database.
    The 'nominatim' database is created DURING the import process, so we
    cannot require it to exist before import.
    """
    container_name = _get_container_name("nominatim")
    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < timeout:
        try:
            # Check PostgreSQL readiness using the 'postgres' database
            # which always exists, not 'nominatim' which is created during import
            check_cmd = [
                "docker",
                "exec",
                container_name,
                "pg_isready",
                "-d",
                "postgres",
            ]
            result = subprocess.run(
                check_cmd,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                logger.info("PostgreSQL is accepting connections")

                # Verify the nominatim role exists (created by entrypoint)
                role_check = [
                    "docker",
                    "exec",
                    container_name,
                    "sudo",
                    "-u",
                    "postgres",
                    "psql",
                    "-d",
                    "postgres",
                    "-tAc",
                    "SELECT 1 FROM pg_roles WHERE rolname='nominatim'",
                ]
                role_result = subprocess.run(
                    role_check,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if role_result.stdout.strip() == "1":
                    logger.info("Nominatim role exists, PostgreSQL ready for import")
                    return
                logger.debug("Nominatim role not found yet, waiting...")
        except Exception as e:
            logger.debug("pg_isready check failed: %s", e)

        await asyncio.sleep(5)

    # If we timeout, log a warning but proceed - let the import try anyway
    logger.warning("Timeout waiting for PostgreSQL, proceeding with import attempt")


async def _wait_for_nominatim_healthy(timeout: int = 120) -> None:
    """Wait for Nominatim service to become healthy after restart."""
    import httpx

    from config import get_nominatim_base_url

    nominatim_url = get_nominatim_base_url()
    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < timeout:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{nominatim_url}/status")
                if response.status_code == 200:
                    logger.info("Nominatim service is healthy")
                    return
        except Exception as e:
            logger.debug("Nominatim health check failed: %s", e)

        await asyncio.sleep(5)

    logger.warning("Timeout waiting for Nominatim health, proceeding anyway")


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

        # Wait a moment for container to stabilize
        await asyncio.sleep(5)

        if progress_callback:
            await _safe_callback(
                progress_callback,
                8,
                "Verifying configuration...",
            )

        container_name = _get_container_name("valhalla")
        pbf_container_path = f"/data/osm/{pbf_relative}"

        # Verify PBF file is accessible
        check_cmd = [
            "docker",
            "exec",
            container_name,
            "ls",
            "-la",
            pbf_container_path,
        ]
        check_result = subprocess.run(
            check_cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if check_result.returncode != 0:
            msg = f"PBF file not accessible in Valhalla container: {pbf_container_path}"
            raise ValueError(msg)

        logger.info("PBF file verified in container: %s", pbf_container_path)

        # Ensure valhalla.json config exists
        config_check = [
            "docker",
            "exec",
            container_name,
            "ls",
            "/custom_files/valhalla.json",
        ]
        config_result = subprocess.run(
            config_check,
            capture_output=True,
            text=True,
            timeout=30,
        )

        if config_result.returncode != 0:
            # Generate config if missing
            logger.info("Generating Valhalla configuration...")
            if progress_callback:
                await _safe_callback(
                    progress_callback,
                    10,
                    "Generating routing configuration...",
                )

            gen_config = [
                "docker",
                "exec",
                container_name,
                "/bin/sh",
                "-c",
                "valhalla_build_config --mjolnir-tile-dir /custom_files/valhalla_tiles "
                "--mjolnir-timezone /custom_files/timezones.sqlite "
                "--mjolnir-admin /custom_files/admin_data.sqlite "
                "> /custom_files/valhalla.json",
            ]
            gen_result = subprocess.run(
                gen_config,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if gen_result.returncode != 0:
                logger.warning(
                    "Config generation returned non-zero, trying alternative method",
                )
                # Try running the configure script if available
                alt_config = [
                    "docker",
                    "exec",
                    container_name,
                    "/bin/sh",
                    "-c",
                    "[ -x /valhalla/scripts/configure_valhalla.sh ] && "
                    "/valhalla/scripts/configure_valhalla.sh || true",
                ]
                subprocess.run(alt_config, capture_output=True, timeout=60)

        if progress_callback:
            await _safe_callback(
                progress_callback,
                12,
                "Starting tile build...",
            )

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
                "Building routing tiles...",
            )

        # Run the build command with output streaming
        process = await asyncio.create_subprocess_exec(
            *build_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        # Monitor progress by reading output lines
        progress = 15
        last_log_time = asyncio.get_event_loop().time()
        output_lines = []

        while True:
            try:
                line = await asyncio.wait_for(
                    process.stdout.readline(),
                    timeout=PROGRESS_UPDATE_INTERVAL,
                )
                if line:
                    decoded = line.decode("utf-8", errors="replace").strip()
                    if decoded:
                        output_lines.append(decoded)
                        if len(output_lines) > 50:
                            output_lines.pop(0)

                        # Update progress based on Valhalla output stages
                        if "Parsing" in decoded:
                            progress = max(progress, 25)
                        elif "Building" in decoded:
                            progress = max(progress, 40)
                        elif "Adding" in decoded:
                            progress = max(progress, 55)
                        elif "Forming" in decoded:
                            progress = max(progress, 70)
                        elif "Enhancing" in decoded:
                            progress = max(progress, 80)
                        elif "Finished" in decoded:
                            progress = max(progress, 90)

                        now = asyncio.get_event_loop().time()
                        if now - last_log_time >= PROGRESS_UPDATE_INTERVAL:
                            last_log_time = now
                            if progress_callback:
                                stage = "Building tiles..."
                                for line_text in reversed(output_lines[-5:]):
                                    if any(
                                        kw in line_text
                                        for kw in [
                                            "Parsing",
                                            "Building",
                                            "Adding",
                                            "Forming",
                                            "Enhancing",
                                        ]
                                    ):
                                        stage = (
                                            line_text[:60] + "..."
                                            if len(line_text) > 60
                                            else line_text
                                        )
                                        break
                                await _safe_callback(progress_callback, progress, stage)
                elif process.returncode is not None:
                    break
            except TimeoutError:
                if process.returncode is not None:
                    break
                progress = min(progress + 1, 88)
                if progress_callback:
                    await _safe_callback(
                        progress_callback,
                        progress,
                        "Tile build in progress...",
                    )

        await process.wait()

        if process.returncode != 0:
            error_output = "\n".join(output_lines[-20:])
            logger.error("Valhalla build failed. Last output:\n%s", error_output)
            msg = f"Valhalla build failed (exit code {process.returncode})"
            raise RuntimeError(msg)

        if progress_callback:
            await _safe_callback(
                progress_callback,
                92,
                "Finalizing tiles...",
            )

        if progress_callback:
            await _safe_callback(
                progress_callback,
                95,
                "Restarting Valhalla service...",
            )

        # Restart Valhalla to pick up new tiles
        await _restart_container("valhalla")

        # Wait for service to become healthy
        if progress_callback:
            await _safe_callback(
                progress_callback,
                98,
                "Verifying service is ready...",
            )

        await _wait_for_valhalla_healthy()

        if progress_callback:
            await _safe_callback(progress_callback, 100, "Valhalla build complete")

        logger.info("Valhalla build complete for %s", label)
        return True

    except Exception as e:
        logger.exception("Valhalla build failed for %s: %s", label, e)
        raise


async def _wait_for_valhalla_healthy(timeout: int = 120) -> None:
    """Wait for Valhalla service to become healthy after restart."""
    import httpx

    from config import get_valhalla_base_url

    valhalla_url = get_valhalla_base_url()
    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < timeout:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{valhalla_url}/status")
                if response.status_code == 200:
                    data = response.json()
                    if (
                        isinstance(data, dict)
                        and data.get("tileset", {}).get("tile_count", 0) > 0
                    ):
                        logger.info("Valhalla service is healthy with tiles")
                        return
        except Exception as e:
            logger.debug("Valhalla health check failed: %s", e)

        await asyncio.sleep(5)

    logger.warning("Timeout waiting for Valhalla health, proceeding anyway")


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
