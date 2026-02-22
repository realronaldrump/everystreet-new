"""Container lifecycle helpers used by map-data builders."""

from __future__ import annotations

import asyncio
import logging

from map_data.builders_common import CONTAINER_START_TIMEOUT, _raise_error
from map_data.docker import get_container_name

logger = logging.getLogger(__name__)


async def start_container_on_demand(
    service_name: str,
    compose_file: str = "docker-compose.yml",
) -> bool:
    """
    Start a Docker container using Docker Compose v2.

    This is used to start Nominatim/Valhalla containers on-demand before builds.
    Even with restart policies, containers may be stopped between imports, so we
    explicitly start them when needed.

    Args:
        service_name: The service name from docker-compose.yml
        compose_file: Path to docker-compose.yml

    Returns:
        True if container is running (started or was already running)

    Raises:
        RuntimeError: If container fails to start
    """
    if await check_container_running(service_name):
        logger.info("Container %s is already running", service_name)
        return True

    logger.info("Starting container %s on demand...", service_name)
    cmd = ["docker", "compose", "-f", compose_file, "up", "-d", service_name]
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await process.communicate()
    except FileNotFoundError as exc:
        msg = "Docker Compose v2 is required but unavailable."
        raise RuntimeError(msg) from exc

    if process.returncode != 0:
        error_msg = (
            stderr.decode(errors="replace").strip() if stderr else "unknown error"
        )
        msg = f"Failed to start {service_name}: {error_msg}"
        raise RuntimeError(msg)

    logger.info("Waiting for container %s to become ready...", service_name)
    start_time = asyncio.get_event_loop().time()
    while (asyncio.get_event_loop().time() - start_time) < CONTAINER_START_TIMEOUT:
        if await check_container_running(service_name):
            logger.info("Container %s is now running", service_name)
            await asyncio.sleep(5)
            return True
        await asyncio.sleep(2)

    msg = f"Container {service_name} did not start within {CONTAINER_START_TIMEOUT}s"
    _raise_error(msg)
    return None


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
