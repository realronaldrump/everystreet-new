"""API endpoints for viewing and managing server logs."""

import asyncio
import logging
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
router = APIRouter()


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

        logs_to_delete = await ServerLog.find(delete_filter).to_list()
        deleted_count = len(logs_to_delete)

        for log in logs_to_delete:
            await log.delete()

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
        stdout, stderr, returncode = await _run_docker_command(
            [
                "ps",
                "-a",
                "--format",
                "{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.CreatedAt}}",
            ],
        )

        if returncode != 0:
            logger.warning("Docker ps command failed: %s", stderr)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Docker command failed: {stderr or 'Unknown error'}",
            )

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
        # Build docker logs command
        args = ["logs", "--tail", str(tail), "--timestamps"]

        if since:
            args.extend(["--since", since])

        args.append(container_name)

        stdout, stderr, returncode = await _run_docker_command(args)

        if returncode != 0:
            # Check if container doesn't exist
            if "No such container" in stderr or "no such container" in stderr.lower():
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Container '{container_name}' not found",
                )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Docker logs command failed: {stderr or 'Unknown error'}",
            )

        # Docker logs may output to stdout or stderr depending on the container
        # Combine both and split into lines
        combined_output = stdout + stderr
        lines = [line for line in combined_output.split("\n") if line.strip()]

        # Limit to requested tail (docker might return more due to timing)
        truncated = len(lines) > tail
        if truncated:
            lines = lines[-tail:]

        return {
            "container": container_name,
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
        stdout, stderr, returncode = await _run_docker_command(
            [
                "inspect",
                "--format",
                "{{.HostConfig.LogConfig.Type}}\t{{.LogPath}}",
                container_name,
            ],
        )

        if returncode != 0:
            if "No such container" in stderr or "no such container" in stderr.lower():
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Container '{container_name}' not found",
                )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Docker inspect command failed: {stderr or 'Unknown error'}",
            )

        parts = stdout.strip().split("\t")
        if len(parts) < 2:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to determine container log configuration",
            )

        log_driver = parts[0].strip()
        log_path = parts[1].strip()

        if log_driver not in {"json-file", "local"}:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Clearing logs is only supported for json-file or local log drivers "
                    f"(found '{log_driver}')"
                ),
            )

        if not log_path:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Log path not available for this container",
            )

        log_file = Path(log_path)
        if not log_file.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Log file not found for this container",
            )

        try:
            log_file.write_bytes(b"")
        except OSError as exc:
            logger.exception("Error clearing Docker logs for %s", container_name)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to clear container logs: {exc!s}",
            )

        return {
            "container": container_name,
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
