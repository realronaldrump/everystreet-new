"""
Build orchestration for Nominatim and Valhalla.

Handles triggering and monitoring builds using Docker SDK.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shlex
from pathlib import Path
from typing import TYPE_CHECKING, Any

from config import get_osm_extracts_path
from map_data.docker import get_container_name

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)


def _raise_error(msg: str, exc_type: type[Exception] = RuntimeError) -> None:
    raise exc_type(msg)


# Build configuration
BUILD_TIMEOUT = 7200  # 2 hours max build time
PROGRESS_UPDATE_INTERVAL = 5.0  # Update progress every 5 seconds
CONTAINER_START_TIMEOUT = 120  # seconds to wait for container to start
_OUTPUT_LINE_OVERFLOW_TEXT = "Output line exceeded buffer; skipping"
_OUTPUT_LINE_OVERFLOW_BYTES = _OUTPUT_LINE_OVERFLOW_TEXT.encode("utf-8")


def _get_int_env(name: str, default: int) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    else:
        return parsed if parsed > 0 else default


async def _safe_readline(
    stream: asyncio.StreamReader,
    *,
    wait_timeout: float,
    label: str,
) -> bytes:
    try:
        return await asyncio.wait_for(stream.readline(), timeout=wait_timeout)
    except asyncio.LimitOverrunError as exc:
        consumed = int(getattr(exc, "consumed", 0) or 0)
        if consumed > 0:
            with contextlib.suppress(Exception):
                await stream.readexactly(consumed)
        logger.warning(
            "%s output line exceeded buffer; skipped %s bytes",
            label,
            consumed,
        )
        return _OUTPUT_LINE_OVERFLOW_BYTES
    except ValueError as exc:
        if "Separator is found, but chunk is longer than limit" in str(
            exc
        ) or "Separator is not found, and chunk exceed the limit" in str(exc):
            logger.warning(
                "%s output line exceeded buffer (ValueError); skipping",
                label,
            )
            return _OUTPUT_LINE_OVERFLOW_BYTES
        raise


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

    # If a stopped container exists, start it directly (avoid docker compose dependency)
    container_name = await get_container_name(service_name)
    if container_name:
        exists_cmd = [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"name={container_name}",
            "--format",
            "{{.Names}}",
        ]
        try:
            exists_process = await asyncio.create_subprocess_exec(
                *exists_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await exists_process.communicate()
            container_exists = bool(stdout.decode().strip())
        except Exception:
            container_exists = False
    else:
        container_exists = False

    if container_exists:
        try:
            process = await asyncio.create_subprocess_exec(
                "docker",
                "start",
                container_name,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await process.communicate()
            if process.returncode == 0:
                logger.info("Started existing container %s", container_name)
                start_time = asyncio.get_event_loop().time()
                while (
                    asyncio.get_event_loop().time() - start_time
                ) < CONTAINER_START_TIMEOUT:
                    if await check_container_running(service_name):
                        logger.info("Container %s is now running", service_name)
                        await asyncio.sleep(5)
                        return True
                    await asyncio.sleep(2)
            else:
                logger.warning(
                    "docker start failed for %s: %s",
                    container_name,
                    stderr.decode(errors="replace").strip() if stderr else "unknown",
                )
        except Exception as exc:
            logger.warning("Failed to docker start %s: %s", container_name, exc)

    logger.info("Starting container %s on demand...", service_name)

    # Try modern docker compose first, then fall back to legacy docker-compose
    compose_commands = [
        # Docker Compose v2 (plugin): docker compose
        ["docker", "compose", "-f", compose_file, "up", "-d", service_name],
        # Docker Compose v1 (standalone): docker-compose
        ["docker-compose", "-f", compose_file, "up", "-d", service_name],
    ]

    last_error = "No docker compose command found"
    for cmd in compose_commands:
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            _, stderr = await process.communicate()

            if stderr:
                error_msg = stderr.decode(errors="replace").strip()
            else:
                error_msg = "No error output from docker command"

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
                _raise_error(msg)

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

    # All commands failed, try direct docker start as fallback
    # This handles cases where docker-compose/plugin is not installed (like in the worker)
    # but the container was already created by the main deployment.
    container_name = await get_container_name(service_name)
    logger.info(
        "Docker compose commands failed, trying fallback: docker start %s",
        container_name,
    )

    try:
        process = await asyncio.create_subprocess_exec(
            "docker",
            "start",
            container_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()

        if process.returncode == 0:
            logger.info("Fallback: Started container %s", container_name)
            # Wait for container to be ready
            start_time = asyncio.get_event_loop().time()
            while (
                asyncio.get_event_loop().time() - start_time
            ) < CONTAINER_START_TIMEOUT:
                if await check_container_running(service_name):
                    logger.info("Container %s is now running", service_name)
                    await asyncio.sleep(5)
                    return True
                await asyncio.sleep(2)

        if stderr:
            fallback_error = stderr.decode(errors="replace").strip()
        else:
            fallback_error = "No error output from docker start"

        last_error = f"Fallback failed: {fallback_error}"

    except Exception as e:
        last_error = f"Fallback error: {e}"

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

    if not Path(pbf_full_path).exists():
        msg = f"PBF file not found: {pbf_full_path}"
        _raise_error(msg, ValueError)

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

        container_name = await get_container_name("nominatim")
        pbf_container_path = f"/nominatim/data/{pbf_relative}"

        # Stop Nominatim web workers and clear marker to avoid DB locks during re-import.
        await _stop_nominatim_service(container_name)
        await _terminate_nominatim_connections(container_name)
        await _clear_nominatim_import_marker(container_name)

        # Ensure flatnode dir is writable for postgres (Nominatim import needs it).
        fix_perm_cmd = [
            "docker",
            "exec",
            container_name,
            "sh",
            "-c",
            "if [ -d /nominatim/flatnode ]; then chown -R postgres:postgres /nominatim/flatnode 2>/dev/null || true; chmod -R u+rwX /nominatim/flatnode 2>/dev/null || true; fi",
        ]
        fix_perm_proc = await asyncio.create_subprocess_exec(
            *fix_perm_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await fix_perm_proc.wait()
        if fix_perm_proc.returncode != 0:
            logger.warning("Could not adjust flatnode permissions before import")

        # First, check if the file is accessible in the container
        check_cmd = [
            "docker",
            "exec",
            container_name,
            "ls",
            "-la",
            pbf_container_path,
        ]
        check_result = await asyncio.create_subprocess_exec(
            *check_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await check_result.wait()

        if check_result.returncode != 0:
            msg = f"PBF file not accessible in container: {pbf_container_path}"
            _raise_error(msg, ValueError)

        logger.info("PBF file verified in container: %s", pbf_container_path)

        # Drop existing database if it exists (to ensure clean import)
        logger.info(
            "Ensuring clean state: Dropping existing 'nominatim' database if present...",
        )
        drop_cmd = [
            "docker",
            "exec",
            "-u",
            "postgres",
            container_name,
            "dropdb",
            "--if-exists",
            "nominatim",
        ]
        drop_process = await asyncio.create_subprocess_exec(
            *drop_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await drop_process.wait()
        if drop_process.returncode == 0:
            logger.info("Database drop command completed successfully")
        else:
            logger.warning("Database drop command returned non-zero (may be benign)")

        # Build the import command
        # Note: We run as the postgres OS user because the container uses peer
        # auth on the local socket.
        threads = _get_int_env("NOMINATIM_IMPORT_THREADS", 2)
        import_cmd = [
            "docker",
            "exec",
            "-u",
            "postgres",
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
            str(threads),
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
        quiet_ticks = 0
        last_log_time = asyncio.get_event_loop().time()
        output_lines = []

        while True:
            try:
                line = await _safe_readline(
                    process.stdout,
                    wait_timeout=PROGRESS_UPDATE_INTERVAL,
                    label="Nominatim import",
                )
                if line:
                    overflow = line == _OUTPUT_LINE_OVERFLOW_BYTES
                    decoded = line.decode("utf-8", errors="replace").strip()
                    if decoded:
                        quiet_ticks = 0
                        if not overflow:
                            output_lines.append(decoded)
                            # Keep only last 50 lines
                            if len(output_lines) > 50:
                                output_lines.pop(0)

                        # Update progress based on Nominatim output stages
                        if overflow:
                            if progress_callback:
                                await _safe_callback(
                                    progress_callback,
                                    progress,
                                    "Import in progress...",
                                )
                        else:
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
                                    await _safe_callback(
                                        progress_callback,
                                        progress,
                                        stage,
                                    )
                elif process.returncode is not None:
                    break
            except TimeoutError:
                # Timeout just means no output, check if process is still running
                if process.returncode is not None:
                    break
                # Still running, update progress slowly unless we're in a long quiet phase
                quiet_ticks += 1
                if progress >= 80 and quiet_ticks >= 3:
                    if progress_callback:
                        await _safe_callback(
                            progress_callback,
                            -1,
                            "Import in progress (quiet period)...",
                        )
                else:
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
            _raise_error(msg)

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

    except Exception:
        logger.exception("Nominatim build failed for %s", label)
        raise
    else:
        return True


async def _wait_for_nominatim_db_ready(wait_timeout: int = 120) -> None:
    """
    Wait for PostgreSQL to be ready inside the Nominatim container.

    NOTE: This checks that PostgreSQL is accepting connections using the
    'postgres' database (which always exists), NOT the 'nominatim' database.
    The 'nominatim' database is created DURING the import process, so we
    cannot require it to exist before import.
    """
    container_name = await get_container_name("nominatim")
    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < wait_timeout:
        try:
            # Check PostgreSQL readiness using the 'postgres' database
            # which always exists, not 'nominatim' which is created during import
            check_cmd = [
                "docker",
                "exec",
                "-u",
                "postgres",
                container_name,
                "pg_isready",
                "-d",
                "postgres",
            ]
            process = await asyncio.create_subprocess_exec(
                *check_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await process.wait()

            if process.returncode == 0:
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
                role_process = await asyncio.create_subprocess_exec(
                    *role_check,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await role_process.communicate()

                if role_process.returncode == 0 and stdout.decode().strip() == "1":
                    logger.info("Nominatim role exists, PostgreSQL ready for import")
                    return
                logger.debug("Nominatim role not found yet, waiting...")
        except Exception as e:
            logger.debug("pg_isready check failed: %s", e)

        await asyncio.sleep(5)

    # If we timeout, log a warning but proceed - let the import try anyway
    logger.warning("Timeout waiting for PostgreSQL, proceeding with import attempt")


async def _stop_nominatim_service(container_name: str) -> None:
    """Stop Nominatim web workers if running to release DB locks."""
    stop_cmd = [
        "docker",
        "exec",
        container_name,
        "sh",
        "-c",
        "if [ -f /tmp/gunicorn.pid ]; then kill -TERM $(cat /tmp/gunicorn.pid) 2>/dev/null || true; fi",
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *stop_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await process.wait()
    except Exception as e:
        logger.debug("Failed to stop Nominatim service: %s", e)


async def _terminate_nominatim_connections(container_name: str) -> None:
    """Terminate active connections to the Nominatim database to allow dropdb."""
    term_cmd = [
        "docker",
        "exec",
        "-u",
        "postgres",
        container_name,
        "psql",
        "-d",
        "postgres",
        "-tAc",
        (
            "SELECT pg_terminate_backend(pid) "
            "FROM pg_stat_activity "
            "WHERE datname='nominatim' AND pid <> pg_backend_pid();"
        ),
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *term_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await process.wait()
    except Exception as e:
        logger.debug("Failed to terminate Nominatim connections: %s", e)


async def _clear_nominatim_import_marker(container_name: str) -> None:
    """Remove import marker so the entrypoint doesn't assume data is ready."""
    clear_cmd = [
        "docker",
        "exec",
        container_name,
        "sh",
        "-c",
        "rm -f /var/lib/postgresql/16/main/import-finished "
        "/var/lib/postgresql/14/main/import-finished "
        "/var/lib/postgresql/import-finished",
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *clear_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await process.wait()
    except Exception as e:
        logger.debug("Failed to clear Nominatim import marker: %s", e)


async def _wait_for_nominatim_healthy(wait_timeout: int = 120) -> None:
    """Wait for Nominatim service to become healthy after restart."""
    import httpx

    from config import get_nominatim_base_url

    nominatim_url = get_nominatim_base_url()
    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < wait_timeout:
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

    if not Path(pbf_full_path).exists():
        msg = f"PBF file not found: {pbf_full_path}"
        _raise_error(msg, ValueError)

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

        container_name = await get_container_name("valhalla")
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
        check_result = await asyncio.create_subprocess_exec(
            *check_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await check_result.wait()

        if check_result.returncode != 0:
            msg = f"PBF file not accessible in Valhalla container: {pbf_container_path}"
            _raise_error(msg, ValueError)

        logger.info("PBF file verified in container: %s", pbf_container_path)

        # Ensure valhalla.json config exists
        config_check = [
            "docker",
            "exec",
            container_name,
            "ls",
            "/custom_files/valhalla.json",
        ]
        config_result = await asyncio.create_subprocess_exec(
            *config_check,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await config_result.wait()

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
            gen_process = await asyncio.create_subprocess_exec(
                *gen_config,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await gen_process.wait()

            if gen_process.returncode != 0:
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
                alt_process = await asyncio.create_subprocess_exec(
                    *alt_config,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await alt_process.wait()

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
        ]
        extra_args = os.getenv("VALHALLA_BUILD_TILES_ARGS", "").strip()
        if extra_args:
            build_cmd.extend(shlex.split(extra_args))
        build_cmd.append(pbf_container_path)

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
        quiet_ticks = 0
        last_log_time = asyncio.get_event_loop().time()
        output_lines = []

        while True:
            try:
                line = await _safe_readline(
                    process.stdout,
                    wait_timeout=PROGRESS_UPDATE_INTERVAL,
                    label="Valhalla build",
                )
                if line:
                    overflow = line == _OUTPUT_LINE_OVERFLOW_BYTES
                    decoded = line.decode("utf-8", errors="replace").strip()
                    if decoded:
                        quiet_ticks = 0
                        if not overflow:
                            output_lines.append(decoded)
                            if len(output_lines) > 50:
                                output_lines.pop(0)

                        # Update progress based on Valhalla output stages
                        if overflow:
                            if progress_callback:
                                await _safe_callback(
                                    progress_callback,
                                    progress,
                                    "Tile build in progress...",
                                )
                        else:
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
                                    await _safe_callback(
                                        progress_callback,
                                        progress,
                                        stage,
                                    )
                elif process.returncode is not None:
                    break
            except TimeoutError:
                if process.returncode is not None:
                    break
                quiet_ticks += 1
                if progress >= 80 and quiet_ticks >= 3:
                    if progress_callback:
                        await _safe_callback(
                            progress_callback,
                            -1,
                            "Tile build in progress (quiet period)...",
                        )
                else:
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
            _raise_error(msg)

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

    except Exception:
        logger.exception("Valhalla build failed for %s", label)
        raise
    else:
        return True


async def _wait_for_valhalla_healthy(wait_timeout: int = 120) -> None:
    """Wait for Valhalla service to become healthy after restart."""
    import httpx

    from config import get_valhalla_base_url

    valhalla_url = get_valhalla_base_url()
    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < wait_timeout:
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
    if Path(pbf_path).is_absolute():
        pbf_full_path = pbf_path
        pbf_relative = os.path.relpath(pbf_full_path, extracts_path)
    else:
        pbf_relative = pbf_path
        pbf_full_path = str(Path(extracts_path) / pbf_path)

    if pbf_relative.startswith(".."):
        msg = f"PBF path must be within extracts volume: {pbf_path}"
        raise ValueError(msg)

    return pbf_full_path, pbf_relative


async def _restart_container(service_name: str) -> None:
    """
    Restart a Docker container.

    Args:
        service_name: The service name to restart
    """
    container_name = await get_container_name(service_name)

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
        if isinstance(e, asyncio.CancelledError):
            raise
        if e.__class__.__name__ == "MapSetupCancelled":
            raise
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
        process = await asyncio.create_subprocess_exec(
            "docker",
            "ps",
            "--filter",
            f"name={service_name}",
            "--filter",
            "status=running",
            "-q",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=10)
        except TimeoutError:
            process.kill()
            await process.communicate()
            logger.warning("Timed out checking container status for %s", service_name)
            return False
        if process.returncode != 0:
            return False
        return bool(stdout.decode().strip())
    except Exception as e:
        logger.warning("Failed to check container status: %s", e)
        return False
