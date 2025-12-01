"""API endpoints for viewing and managing server logs."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status

from db import db_manager

logger = logging.getLogger(__name__)
router = APIRouter()

# MongoDB collection for server logs
logs_collection = db_manager.db["server_logs"]


@router.get("/api/server-logs")
async def get_server_logs(
    limit: int = Query(default=500, ge=1, le=5000),
    level: str | None = Query(default=None),
    search: str | None = Query(default=None),
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
        # Build query filter
        query_filter: dict[str, Any] = {}

        if level:
            query_filter["level"] = level.upper()

        if search:
            query_filter["message"] = {"$regex": search, "$options": "i"}

        # Get logs from database
        cursor = logs_collection.find(query_filter).sort("timestamp", -1).limit(limit)
        logs = await cursor.to_list(length=limit)

        # Convert ObjectId to string for JSON serialization
        for log in logs:
            if "_id" in log:
                log["_id"] = str(log["_id"])
            # Convert datetime to ISO format string
            if "timestamp" in log:
                log["timestamp"] = log["timestamp"].isoformat()

        # Get total count for pagination info
        total_count = await logs_collection.count_documents(query_filter)

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
            detail=f"Failed to retrieve server logs: {str(e)}",
        )


@router.delete("/api/server-logs")
async def clear_server_logs(
    level: str | None = Query(default=None),
    older_than_days: int | None = Query(default=None, ge=1),
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
        # Build delete filter
        delete_filter: dict[str, Any] = {}

        if level:
            delete_filter["level"] = level.upper()

        if older_than_days:
            from datetime import datetime, timedelta

            cutoff_date = datetime.utcnow() - timedelta(days=older_than_days)
            delete_filter["timestamp"] = {"$lt": cutoff_date}

        # Delete logs
        result = await logs_collection.delete_many(delete_filter)

        logger.info(
            "Cleared %d server log entries (filter: %s)",
            result.deleted_count,
            delete_filter,
        )

        return {
            "message": f"Successfully cleared {result.deleted_count} log entries",
            "deleted_count": result.deleted_count,
            "filter": delete_filter,
        }

    except Exception as e:
        logger.exception("Error clearing server logs")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to clear server logs: {str(e)}",
        )


@router.get("/api/server-logs/stats")
async def get_logs_stats() -> dict[str, Any]:
    """
    Get statistics about server logs.

    Returns:
        Dictionary containing log statistics
    """
    try:
        # Get total count
        total_count = await logs_collection.count_documents({})

        # Get count by level
        pipeline = [
            {"$group": {"_id": "$level", "count": {"$sum": 1}}},
            {"$sort": {"_id": 1}},
        ]
        level_counts = await logs_collection.aggregate(pipeline).to_list(length=None)

        # Get oldest and newest log timestamps
        oldest_log = await logs_collection.find_one({}, sort=[("timestamp", 1)])
        newest_log = await logs_collection.find_one({}, sort=[("timestamp", -1)])

        return {
            "total_count": total_count,
            "by_level": {item["_id"]: item["count"] for item in level_counts},
            "oldest_timestamp": (
                oldest_log["timestamp"].isoformat() if oldest_log else None
            ),
            "newest_timestamp": (
                newest_log["timestamp"].isoformat() if newest_log else None
            ),
        }

    except Exception as e:
        logger.exception("Error fetching server logs statistics")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve log statistics: {str(e)}",
        )
