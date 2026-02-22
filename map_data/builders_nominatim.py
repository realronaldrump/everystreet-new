"""Nominatim import helpers."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from map_data.builders_common import (
    _OUTPUT_LINE_OVERFLOW_BYTES,
    PROGRESS_UPDATE_INTERVAL,
    _get_int_env,
    _raise_error,
    _resolve_pbf_path,
    _safe_callback,
    _safe_readline,
)
from map_data.builders_container import _restart_container, start_container_on_demand
from map_data.docker import get_container_name

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)


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
