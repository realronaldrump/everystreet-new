"""
Container lifecycle helpers used by map-data builders.
"""

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
