"""Background tasks for mobility profile synchronization."""

from __future__ import annotations

import logging
import os
from typing import Any

from analytics.services.mobility_insights_service import (
    MAX_SYNC_TRIPS_PER_REQUEST,
    MobilityInsightsService,
)
from tasks.ops import run_task_with_history

logger = logging.getLogger(__name__)

MOBILITY_SYNC_BATCH_SIZE = max(
    1,
    int(
        os.getenv(
            "MOBILITY_INSIGHTS_SYNC_BATCH_SIZE",
            str(MAX_SYNC_TRIPS_PER_REQUEST),
        ),
    ),
)
MOBILITY_SYNC_BATCHES_PER_RUN = max(
    1,
    int(
        os.getenv(
            "MOBILITY_INSIGHTS_SYNC_BATCHES_PER_RUN",
            "2",
        ),
    ),
)


async def _sync_mobility_profiles_logic() -> dict[str, Any]:
    """Drain unsynced trip mobility profiles in bounded batches."""
    synced_total = 0
    pending_unsynced = 0
    batches_processed = 0

    for _ in range(MOBILITY_SYNC_BATCHES_PER_RUN):
        (
            synced_count,
            pending_count,
        ) = await MobilityInsightsService.sync_unsynced_trips_for_query(
            {},
            limit=MOBILITY_SYNC_BATCH_SIZE,
        )
        synced_total += int(synced_count or 0)
        pending_unsynced = int(pending_count or 0)
        batches_processed += 1
        if synced_count <= 0 or pending_unsynced <= 0:
            break

    logger.info(
        "Mobility profile sync finished: synced=%d pending=%d batches=%d",
        synced_total,
        pending_unsynced,
        batches_processed,
    )

    return {
        "status": "success",
        "synced_trips": synced_total,
        "pending_trip_sync_count": pending_unsynced,
        "batches_processed": batches_processed,
        "batch_size": MOBILITY_SYNC_BATCH_SIZE,
        "max_batches_per_run": MOBILITY_SYNC_BATCHES_PER_RUN,
        "message": (
            "Mobility profile sync completed. "
            f"Synced {synced_total} trips; {pending_unsynced} remain unsynced."
        ),
    }


async def sync_mobility_profiles(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    """ARQ job that keeps trip mobility profiles up-to-date."""
    return await run_task_with_history(
        ctx,
        "sync_mobility_profiles",
        _sync_mobility_profiles_logic,
        manual_run=manual_run,
    )
