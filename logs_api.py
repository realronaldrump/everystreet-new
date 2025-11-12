"""Logs API endpoint for viewing Docker container logs remotely."""

import logging
import os
import subprocess

from fastapi import APIRouter, HTTPException, Query, status

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/logs")
async def get_logs(
    container: str = Query(
        "web", description="Container name (web, worker, beat, mongo, redis)"
    ),
    lines: int = Query(100, ge=1, le=1000, description="Number of lines to retrieve"),
    follow: bool = Query(False, description="Follow log output (streaming)"),
):
    """Get Docker container logs.

    Args:
        container: Name of the container (web, worker, beat, mongo, redis)
        lines: Number of log lines to retrieve (1-1000)
        follow: Whether to follow logs (streaming mode)

    Returns:
        JSON response with logs and metadata
    """
    # Validate container name
    valid_containers = ["web", "worker", "beat", "mongo", "redis"]
    if container not in valid_containers:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid container. Must be one of: {', '.join(valid_containers)}",
        )

    try:
        # Build docker-compose logs command
        cmd = ["docker-compose", "logs", "--tail", str(lines), container]

        # Execute command
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,  # 10 second timeout
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )

        if result.returncode != 0:
            logger.error("Failed to retrieve logs: %s", result.stderr)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to retrieve logs: {result.stderr}",
            )

        return {
            "container": container,
            "lines": lines,
            "logs": result.stdout,
            "error": result.stderr if result.stderr else None,
        }

    except subprocess.TimeoutExpired:
        logger.error("Timeout retrieving logs for container: %s", container)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timeout retrieving logs",
        )
    except FileNotFoundError:
        logger.error("docker-compose command not found")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="docker-compose command not found. Ensure Docker Compose is installed.",
        )
    except Exception as e:
        logger.exception("Unexpected error retrieving logs: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected error: {str(e)}",
        )


@router.get("/api/logs/containers")
async def list_containers():
    """List available Docker containers.

    Returns:
        List of available container names
    """
    return {
        "containers": ["web", "worker", "beat", "mongo", "redis"],
        "descriptions": {
            "web": "Main web application server",
            "worker": "Celery worker for background tasks",
            "beat": "Celery beat scheduler",
            "mongo": "MongoDB database",
            "redis": "Redis cache and message broker",
        },
    }
