"""
System status API endpoints.

Note: The /health endpoint is defined in setup/api/configuration.py
which provides a more comprehensive health check. This module only
provides the logs endpoint.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter

from db.models import AppSettings, ServerLog

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/status", tags=["status"])


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

        # Mapping service names to logger names or queries
        if service_name == "server":
            pass  # All logs
        elif service_name == "worker":
            # Worker logs usually go to stdout, intercepted?
            # Or task history?
            pass

        query_filter: dict[str, Any] = {"level": {"$ne": "DEBUG"}}
        try:
            settings = await AppSettings.find_one()
            cutoff = getattr(settings, "serverLogsCutoff", None) if settings else None
            if cutoff:
                query_filter["timestamp"] = {"$gte": cutoff}
        except Exception:
            logger.exception("Failed to load server log cutoff")

        # Fallback to ServerLog - this only captures Python logs that go through the handler
        db_logs = await (
            ServerLog.find(query_filter).sort("-timestamp").limit(limit).to_list()
        )

        log_lines = [
            f"[{log.timestamp}] {log.level}: {log.message}" for log in reversed(db_logs)
        ]

        return {
            "success": True,
            "logs": (
                "\n".join(log_lines)
                if log_lines
                else "No recent logs found in database."
            ),
            "timestamp": datetime.now(UTC).isoformat(),
        }
    except Exception as exc:
        logger.exception("Failed to fetch logs")
        return {
            "success": False,
            "logs": f"Error fetching logs: {exc}",
            "timestamp": datetime.now(UTC).isoformat(),
        }
