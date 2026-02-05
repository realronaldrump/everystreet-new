"""ARQ jobs for log maintenance."""

from __future__ import annotations

import logging
from typing import Any

from core.date_utils import parse_timestamp
from db.models import ServerLog

logger = logging.getLogger(__name__)


async def purge_server_logs_before(
    _ctx: dict[str, Any],
    cutoff_iso: str,
    manual_run: bool = False,  # kept for consistency with other tasks
) -> dict[str, Any]:
    """Delete server logs older than the provided cutoff timestamp."""
    cutoff_dt = parse_timestamp(cutoff_iso)
    if not cutoff_dt:
        msg = f"Invalid cutoff_iso: {cutoff_iso}"
        raise ValueError(msg)

    delete_result = await ServerLog.get_pymongo_collection().delete_many(
        {"timestamp": {"$lt": cutoff_dt}},
    )
    deleted_count = int(getattr(delete_result, "deleted_count", 0))

    logger.info(
        "Purged %d server log entries older than %s (manual_run=%s)",
        deleted_count,
        cutoff_dt.isoformat(),
        manual_run,
    )

    return {
        "status": "success",
        "deleted_count": deleted_count,
        "cutoff_timestamp": cutoff_dt.isoformat(),
        "manual_run": bool(manual_run),
    }
