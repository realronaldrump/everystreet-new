"""API endpoints for viewing and managing server logs."""

import asyncio
import logging
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from core.api import api_route
from db import ServerLog
from db.aggregation import aggregate_to_list

logger = logging.getLogger(__name__)
router = APIRouter(tags=["logs"])


class LogsResponse(BaseModel):
    """Response model for logs endpoint."""

    logs: list[ServerLog]
    total_count: int
    returned_count: int
    limit: int


class ClearLogsResponse(BaseModel):
    """Response model for clearing logs."""

    message: str
    deleted_count: int
    filter: dict[str, Any]


class LogsStatsResponse(BaseModel):
    """Response model for logs statistics."""

    total_count: int
    by_level: dict[str, int]
    oldest_timestamp: str | None
    newest_timestamp: str | None


@router.get("/api/server-logs", response_model=LogsResponse)
@api_route(logger)
async def get_server_logs(
    limit: Annotated[int, Query(ge=1, le=5000)] = 500,
    level: Annotated[str | None, Query()] = None,
    search: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    """
    Get recent server logs from the database.

    Args:
        limit: Maximum number of logs to return (1-5000, default 500)
        level: Filter by log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        search: Search term to filter log messages

    Returns:
        Dictionary containing logs array and metadata
    """
    try:
        query_filter: dict[str, Any] = {}

        if level:
            query_filter["level"] = level.upper()

        if search:
            # Escape regex metacharacters to prevent regex injection attacks
            escaped_search = re.escape(search)
            query_filter["message"] = {"$regex": escaped_search, "$options": "i"}

        logs = (
            await ServerLog.find(query_filter).sort("-timestamp").limit(limit).to_list()
        )

        total_count = await ServerLog.find(query_filter).count()

        return {
            "logs": logs,
            "total_count": total_count,
            "returned_count": len(logs),
            "limit": limit,
        }

    except Exception as e:
        logger.exception("Error fetching server logs")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve server logs: {e!s}",
        )


@router.delete("/api/server-logs", response_model=ClearLogsResponse)
@api_route(logger)
async def clear_server_logs(
    level: Annotated[str | None, Query()] = None,
    older_than_days: Annotated[int | None, Query(ge=1)] = None,
) -> dict[str, Any]:
    """
    Clear server logs from the database.

    Args:
        level: Only delete logs of this level (optional)
        older_than_days: Only delete logs older than this many days (optional)

    Returns:
        Dictionary with deletion result
    """
    try:
        delete_filter: dict[str, Any] = {}

        if level:
            delete_filter["level"] = level.upper()

        if older_than_days:
            cutoff_date = datetime.now(UTC) - timedelta(days=older_than_days)
            delete_filter["timestamp"] = {"$lt": cutoff_date}

        # Use a single bulk delete instead of fetching and deleting documents
        # one-by-one. This keeps the endpoint fast even with 100k+ log rows.
        delete_result = await ServerLog.get_motor_collection().delete_many(
            delete_filter
        )
        deleted_count = int(getattr(delete_result, "deleted_count", 0))

        logger.info(
            "Cleared %d server log entries (filter: %s)",
            deleted_count,
            delete_filter,
        )

    except Exception as e:
        logger.exception("Error clearing server logs")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to clear server logs: {e!s}",
        )
    else:
        return {
            "message": f"Successfully cleared {deleted_count} log entries",
            "deleted_count": deleted_count,
            "filter": delete_filter,
        }


@router.get("/api/server-logs/stats", response_model=LogsStatsResponse)
@api_route(logger)
async def get_logs_stats() -> dict[str, Any]:
    """
    Get statistics about server logs.

    Returns:
        Dictionary containing log statistics
    """
    try:
        total_count = await ServerLog.find().count()

        pipeline = [
            {"$group": {"_id": "$level", "count": {"$sum": 1}}},
            {"$sort": {"_id": 1}},
        ]
        level_counts = await aggregate_to_list(ServerLog, pipeline)

        oldest_log = await ServerLog.find().sort("+timestamp").first_or_none()
        newest_log = await ServerLog.find().sort("-timestamp").first_or_none()

        return {
            "total_count": total_count,
            "by_level": {item["_id"]: item["count"] for item in level_counts},
            "oldest_timestamp": (
                oldest_log.timestamp.isoformat()
                if oldest_log and oldest_log.timestamp
                else None
            ),
            "newest_timestamp": (
                newest_log.timestamp.isoformat()
                if newest_log and newest_log.timestamp
                else None
            ),
        }

    except Exception as e:
        logger.exception("Error fetching server logs statistics")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve log statistics: {e!s}",
        )


# =============================================================================
# Docker Container Logs API
# =============================================================================


class ContainerInfo(BaseModel):
    """Information about a Docker container."""

    name: str
    status: str
    image: str
    created: str | None = None


class ContainersResponse(BaseModel):
    """Response model for listing Docker containers."""

    containers: list[ContainerInfo]


class DockerLogsResponse(BaseModel):
    """Response model for Docker container logs."""

    container: str
    logs: list[str]
    line_count: int
    truncated: bool


class DockerClearResponse(BaseModel):
    """Response model for clearing Docker container logs."""

    container: str
    log_driver: str
    cleared: bool


def _raise_container_not_found(container_name: str) -> None:
    """Raise HTTPException for container not found."""
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Container '{container_name}' not found",
    )


def _raise_docker_command_failed(stderr: str) -> None:
    """Raise HTTPException for docker command failure."""
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Docker command failed: {stderr or 'Unknown error'}",
    )


def _raise_docker_logs_failed(stderr: str) -> None:
    """Raise HTTPException for docker logs command failure."""
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Docker logs command failed: {stderr or 'Unknown error'}",
    )


def _raise_docker_inspect_failed(stderr: str) -> None:
    """Raise HTTPException for docker inspect command failure."""
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Docker inspect command failed: {stderr or 'Unknown error'}",
    )


def _raise_log_config_error() -> None:
    """Raise HTTPException for log configuration error."""
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="Failed to determine container log configuration",
    )


def _raise_unsupported_log_driver(log_driver: str) -> None:
    """Raise HTTPException for unsupported log driver."""
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            "Clearing logs is only supported for json-file or local log drivers "
            f"(found '{log_driver}')"
        ),
    )


def _raise_log_path_unavailable() -> None:
    """Raise HTTPException for unavailable log path."""
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Log path not available for this container",
    )


def _raise_log_file_not_found() -> None:
    """Raise HTTPException for missing log file."""
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Log file not found for this container",
    )


async def _run_docker_command(args: list[str]) -> tuple[str, str, int]:
    """Run a docker command and return stdout, stderr, and return code."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        return (
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
            proc.returncode or 0,
        )
    except FileNotFoundError:
        return "", "Docker command not found", 1
    except Exception as e:
        return "", str(e), 1


COMPOSE_SERVICES = (
    "mongo-init",
    "nominatim",
    "valhalla",
    "watchtower",
    "worker",
    "redis",
    "mongo",
    "web",
)


async def _infer_compose_project() -> str | None:
    """Infer the docker compose project name for this app."""
    env_project = os.getenv("COMPOSE_PROJECT_NAME", "").strip()
    if env_project:
        return env_project

    for service in COMPOSE_SERVICES:
        stdout, _, returncode = await _run_docker_command(
            [
                "ps",
                "-a",
                "--filter",
                f"label=com.docker.compose.service={service}",
                "--format",
                '{{.Label "com.docker.compose.project"}}',
            ],
        )
        if returncode != 0:
            continue
        for line in stdout.splitlines():
            value = line.strip()
            if value:
                return value

    return None


def _extract_compose_index(container_name: str) -> str | None:
    """Extract the trailing compose index from a container name."""
    parts = container_name.split("-")
    if parts and parts[-1].isdigit():
        return parts[-1]
    return None


def _extract_compose_service(container_name: str) -> str | None:
    """Infer service name from a container name using known service list."""
    lower_name = container_name.lower()
    for service in COMPOSE_SERVICES:
        token = service.lower()
        if (
            lower_name == token
            or lower_name.startswith(f"{token}-")
            or lower_name.endswith(f"-{token}")
            or f"-{token}-" in lower_name
        ):
            return service
    return None


async def _list_container_names(filter_args: list[str] | None = None) -> list[str]:
    """List container names via docker ps."""
    cmd = ["ps", "-a", "--format", "{{.Names}}"]
    if filter_args:
        cmd.extend(filter_args)

    stdout, _, returncode = await _run_docker_command(cmd)
    if returncode != 0:
        return []
    return [line.strip() for line in stdout.splitlines() if line.strip()]


async def _resolve_container_name(container_name: str) -> str | None:
    """Resolve a possibly stale container name to an existing container."""
    names = await _list_container_names()
    if container_name in names:
        return container_name

    service = _extract_compose_service(container_name)
    if service:
        candidates = await _list_container_names(
            ["--filter", f"label=com.docker.compose.service={service}"],
        )
        if candidates:
            index = _extract_compose_index(container_name)
            if index:
                for candidate in candidates:
                    if candidate.endswith(f"-{index}"):
                        return candidate

            project = await _infer_compose_project()
            if project:
                for candidate in candidates:
                    if candidate.startswith(f"{project}-"):
                        return candidate

            return candidates[0]

    return None


@router.get("/api/docker-logs/containers", response_model=ContainersResponse)
@api_route(logger)
async def list_docker_containers() -> dict[str, Any]:
    """
    List available Docker containers.

    Returns:
        Dictionary containing list of containers with their info
    """
    try:
        # Get container info in JSON format
        project = await _infer_compose_project()
        cmd = [
            "ps",
            "-a",
            "--format",
            "{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.CreatedAt}}",
        ]
        if project:
            cmd.extend(["--filter", f"label=com.docker.compose.project={project}"])

        stdout, stderr, returncode = await _run_docker_command(cmd)

        if returncode != 0:
            logger.warning("Docker ps command failed: %s", stderr)
            _raise_docker_command_failed(stderr)
        else:
            containers = []
            for line in stdout.strip().split("\n"):
                if not line.strip():
                    continue
                parts = line.split("\t")
                if len(parts) >= 3:
                    containers.append(
                        ContainerInfo(
                            name=parts[0],
                            status=parts[1],
                            image=parts[2],
                            created=parts[3] if len(parts) > 3 else None,
                        ),
                    )

            return {"containers": containers}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error listing Docker containers")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list containers: {e!s}",
        )


@router.get("/api/docker-logs/{container_name}", response_model=DockerLogsResponse)
@api_route(logger)
async def get_docker_container_logs(
    container_name: str,
    tail: Annotated[int, Query(ge=1, le=10000)] = 500,
    since: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    """
    Get logs for a specific Docker container.

    Args:
        container_name: Name of the container to get logs from
        tail: Number of lines to return from the end (1-10000, default 500)
        since: Only return logs since this timestamp (e.g., "1h", "30m", "2024-01-01")

    Returns:
        Dictionary containing container logs and metadata
    """
    try:
        resolved_name = await _resolve_container_name(container_name) or container_name

        # Build docker logs command
        args = ["logs", "--tail", str(tail), "--timestamps"]

        if since:
            args.extend(["--since", since])

        args.append(resolved_name)

        stdout, stderr, returncode = await _run_docker_command(args)

        if returncode != 0:
            # Check if container doesn't exist
            if "No such container" in stderr or "no such container" in stderr.lower():
                _raise_container_not_found(container_name)
            _raise_docker_logs_failed(stderr)

        # Docker logs may output to stdout or stderr depending on the container
        # Combine both and split into lines
        combined_output = stdout + stderr
        lines = [line for line in combined_output.split("\n") if line.strip()]

        # Limit to requested tail (docker might return more due to timing)
        truncated = len(lines) > tail
        if truncated:
            lines = lines[-tail:]

        return {
            "container": resolved_name,
            "logs": lines,
            "line_count": len(lines),
            "truncated": truncated,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error fetching Docker container logs for %s", container_name)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve container logs: {e!s}",
        )


@router.delete("/api/docker-logs/{container_name}", response_model=DockerClearResponse)
@api_route(logger)
async def clear_docker_container_logs(container_name: str) -> dict[str, Any]:
    """
    Clear logs for a specific Docker container.

    Args:
        container_name: Name of the container to clear logs for

    Returns:
        Dictionary containing clear status metadata
    """
    try:
        resolved_name = await _resolve_container_name(container_name) or container_name

        stdout, stderr, returncode = await _run_docker_command(
            [
                "inspect",
                "--format",
                "{{.HostConfig.LogConfig.Type}}\t{{.LogPath}}",
                resolved_name,
            ],
        )

        if returncode != 0:
            if "No such container" in stderr or "no such container" in stderr.lower():
                _raise_container_not_found(container_name)
            _raise_docker_inspect_failed(stderr)
        else:
            parts = stdout.strip().split("\t")
            if len(parts) < 2:
                _raise_log_config_error()

            log_driver = parts[0].strip()
            log_path = parts[1].strip()

            if log_driver not in {"json-file", "local"}:
                _raise_unsupported_log_driver(log_driver)

            if not log_path:
                _raise_log_path_unavailable()

            log_file = Path(log_path)
            if not log_file.exists():
                _raise_log_file_not_found()

            try:
                log_file.write_bytes(b"")
            except OSError as exc:
                logger.exception("Error clearing Docker logs for %s", container_name)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Failed to clear container logs: {exc!s}",
                )
            else:
                return {
                    "container": resolved_name,
                    "log_driver": log_driver,
                    "cleared": True,
                }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error clearing Docker container logs for %s", container_name)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to clear container logs: {e!s}",
        )
