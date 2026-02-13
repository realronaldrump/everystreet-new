"""
Valhalla tile build helpers.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
from pathlib import Path

from typing import TYPE_CHECKING, Any

from map_data.builders_common import (
    PROGRESS_UPDATE_INTERVAL,
    _OUTPUT_LINE_OVERFLOW_BYTES,
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
