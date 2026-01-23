"""System status API endpoints."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, UTC
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from core.repo_info import get_repo_version_info
from db.models import ServerLog, TaskHistory
from map_data.services import check_service_health, get_map_services_status
from tasks.arq import get_arq_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/status", tags=["status"])


async def get_worker_status() -> dict[str, Any]:
    """Check ARQ worker status."""
    try:
        pool = await get_arq_pool()
        # ARQ doesn't have a direct "ping", but we can check if connection is open
        # or list jobs. A simple check is to ask for job statistics if possible
        # or just assume healthy if pool is connected.
        # For now, we'll return a placeholder healthy status if pool exists.
        if pool:
            return {"status": "healthy", "message": "Worker pool connected"}
        return {"status": "error", "message": "Worker pool disconnected"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


async def get_db_status() -> dict[str, Any]:
    """Check MongoDB status."""
    from db import db_manager

    try:
        # Check if connected
        if db_manager.client:
            # Simple ping
            await db_manager.client.admin.command("ping")
            return {"status": "healthy", "message": "Connected"}
        return {"status": "error", "message": "Not connected"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


async def get_redis_status() -> dict[str, Any]:
    """Check Redis status."""
    try:
        from core.redis import get_redis

        redis = await get_redis()
        if await redis.ping():
            return {"status": "healthy", "message": "Connected"}
        return {"status": "error", "message": "Ping failed"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/health")
async def system_health() -> dict[str, Any]:
    """Get overall system health."""
    try:
        # Get map services status (Nominatim, Valhalla)
        map_status = await get_map_services_status()
        map_services = map_status.get("services", {})

        # Get other components
        db_stat = await get_db_status()
        redis_stat = await get_redis_status()
        worker_stat = await get_worker_status()

        # Fetch recent errors
        recent_errors = []
        try:
            # Last 24 hours
            since = datetime.now(UTC) - timedelta(hours=24)
            errors = (
                await TaskHistory.find(
                    TaskHistory.status == "failed", TaskHistory.timestamp >= since
                )
                .sort("-timestamp")
                .limit(5)
                .to_list()
            )

            for err in errors:
                recent_errors.append(
                    {
                        "task_id": err.task_id,
                        "timestamp": err.timestamp.isoformat()
                        if err.timestamp
                        else None,
                        "error": err.error or "Unknown error",
                    }
                )
        except Exception as e:
            logger.warning("Failed to fetch recent errors: %s", e)

        return {
            "services": {
                "mongodb": {
                    "status": "healthy" if db_stat["status"] == "healthy" else "error",
                    "label": "MongoDB",
                    "message": db_stat["message"],
                    "detail": "",
                },
                "redis": {
                    "status": "healthy"
                    if redis_stat["status"] == "healthy"
                    else "error",
                    "label": "Redis",
                    "message": redis_stat["message"],
                    "detail": "",
                },
                "worker": {
                    "status": "healthy"
                    if worker_stat["status"] == "healthy"
                    else "error",
                    "label": "Worker",
                    "message": worker_stat["message"],
                    "detail": "",
                },
                "nominatim": {
                    "status": "healthy"
                    if map_services.get("nominatim", {}).get("healthy")
                    else "error",
                    "label": "Nominatim",
                    "message": "Healthy"
                    if map_services.get("nominatim", {}).get("healthy")
                    else "Unhealthy",
                    "detail": map_services.get("nominatim", {}).get("error") or "",
                },
                "valhalla": {
                    "status": "healthy"
                    if map_services.get("valhalla", {}).get("healthy")
                    else "error",
                    "label": "Valhalla",
                    "message": "Healthy"
                    if map_services.get("valhalla", {}).get("healthy")
                    else "Unhealthy",
                    "detail": map_services.get("valhalla", {}).get("error") or "",
                },
            },
            "recent_errors": recent_errors,
            "overall": {
                "last_updated": datetime.now(UTC).isoformat(),
                "version": get_repo_version_info().get("commit_short", "unknown"),
            },
        }
    except Exception as exc:
        logger.exception("Failed to fetch system health")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch health: {exc!s}",
        )


@router.get("/logs/{service_name}")
async def get_service_logs(service_name: str) -> dict[str, Any]:
    """Get logs for a specific service."""
    # This is a bit tricky as logs are in Docker.
    # We can peek at MongoDB logs if service matches 'server'
    # Or return a message saying 'Log viewing not implemented for container'
    # But since we have ServerLog model, maybe we can return those?

    try:
        # For now, just return server logs from DB if service is 'server' or 'worker'
        # For 'nominatim', etc., we might can't easily get them without Docker access here
        # But we can query ServerLog for logger_name matching service?

        limit = 100
        logs = []

        # Mapping service names to logger names or queries
        query = {}
        if service_name == "server":
            pass  # All logs
        elif service_name == "worker":
            # Worker logs usually go to stdout, intercepted?
            # Or task history?
            pass

        # Fallback to ServerLog - this only captures Python logs that go through the handler
        db_logs = (
            await ServerLog.find(
                ServerLog.level != "DEBUG"  # Filter out debug noise
            )
            .sort("-timestamp")
            .limit(limit)
            .to_list()
        )

        log_lines = []
        for log in reversed(db_logs):  # Oldest first
            log_lines.append(f"[{log.timestamp}] {log.level}: {log.message}")

        return {
            "success": True,
            "logs": "\n".join(log_lines)
            if log_lines
            else "No recent logs found in database.",
            "timestamp": datetime.now(UTC).isoformat(),
        }
    except Exception as exc:
        logger.exception("Failed to fetch logs")
        return {
            "success": False,
            "logs": f"Error fetching logs: {exc}",
            "timestamp": datetime.now(UTC).isoformat(),
        }
