"""API endpoints for viewing and managing server logs."""

import logging
from datetime import datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from db import ServerLog

logger = logging.getLogger(__name__)
router = APIRouter()


class LogsResponse(BaseModel):
    """Response model for logs endpoint."""

    logs: list[dict[str, Any]]
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
            query_filter["message"] = {"$regex": search, "$options": "i"}

        logs = (
            await ServerLog.find(query_filter).sort("-timestamp").limit(limit).to_list()
        )

        total_count = await ServerLog.find(query_filter).count()

        return {
            "logs": [log.model_dump(mode="json") for log in logs],
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
            cutoff_date = datetime.utcnow() - timedelta(days=older_than_days)
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

        return {
            "message": f"Successfully cleared {deleted_count} log entries",
            "deleted_count": deleted_count,
            "filter": delete_filter,
        }

    except Exception as e:
        logger.exception("Error clearing server logs")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to clear server logs: {e!s}",
        )


@router.get("/api/server-logs/stats", response_model=LogsStatsResponse)
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
        level_counts = await ServerLog.aggregate(pipeline).to_list()

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
