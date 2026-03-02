"""
Coverage calculation tasks.

This module provides ARQ jobs for coverage operations.

Coverage updates run inline during trip ingestion. This task is kept for
manual/scheduled full refreshes of coverage statistics.
"""

from __future__ import annotations

import logging
from typing import Any

from db.models import CoverageArea
from geo_coverage.services.geo_coverage_service import run_scheduled_recalculate
from street_coverage.stats import update_area_stats
from tasks.ops import run_task_with_history

logger = logging.getLogger(__name__)


async def _update_coverage_for_new_trips_logic() -> dict[str, Any]:
    """
    Refresh coverage statistics for all areas.

    Coverage updates happen during trip ingestion. This task recalculates
    stats for all areas, which is useful for:
    - Fixing any inconsistencies
    - After manual data corrections
    - Scheduled maintenance
    """
    processed_areas = 0
    failed_areas = 0
    skipped_areas = 0

    # Fetch all coverage areas using new model
    coverage_areas = await CoverageArea.find_all().to_list()
    logger.info(
        "Found %d coverage areas to refresh statistics.",
        len(coverage_areas),
    )

    for area in coverage_areas:
        display_name = area.display_name or f"Unknown (ID: {area.id})"

        # Skip areas that aren't ready
        if area.status not in ("ready", "degraded"):
            logger.info(
                "Skipping area '%s' - status is '%s'",
                display_name,
                area.status,
            )
            skipped_areas += 1
            continue

        try:
            # Update statistics for this area
            updated_area = await update_area_stats(area.id)

            if updated_area:
                logger.info(
                    "Successfully refreshed stats for '%s'. Coverage: %.2f%%",
                    display_name,
                    updated_area.coverage_percentage,
                )
                processed_areas += 1
            else:
                logger.warning(
                    "Stats refresh returned no result for '%s'.",
                    display_name,
                )
                failed_areas += 1

        except Exception:
            logger.exception(
                "Error refreshing stats for '%s'",
                display_name,
            )
            failed_areas += 1

    logger.info(
        "Completed coverage stats refresh. Processed: %d, Failed: %d, Skipped: %d",
        processed_areas,
        failed_areas,
        skipped_areas,
    )

    return {
        "status": "success",
        "areas_processed": processed_areas,
        "areas_failed": failed_areas,
        "areas_skipped": skipped_areas,
        "message": (
            f"Completed stats refresh. Processed: {processed_areas}, "
            f"Failed: {failed_areas}, Skipped: {skipped_areas}"
        ),
    }


async def update_coverage_for_new_trips(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    """ARQ job for refreshing coverage statistics."""
    return await run_task_with_history(
        ctx,
        "update_coverage_for_new_trips",
        _update_coverage_for_new_trips_logic,
        manual_run=manual_run,
    )


async def _sync_geo_coverage_logic() -> dict[str, Any]:
    """
    Incrementally refresh geo coverage explorer caches.

    Uses the persisted last-processed checkpoint and only scans trips newer than
    that checkpoint unless there is no checkpoint yet (first run).
    """
    result = await run_scheduled_recalculate(mode="incremental")
    status = str(result.get("status") or "")
    if status == "skipped":
        logger.info(
            "Geo coverage sync skipped: %s",
            result.get("reason") or "already running",
        )
        return {
            "status": "skipped",
            "reason": result.get("reason"),
            "job_id": result.get("job_id"),
            "message": result.get("message") or "Geo coverage sync skipped.",
        }

    logger.info(
        "Geo coverage sync completed (mode=%s, job_id=%s)",
        result.get("mode"),
        result.get("job_id"),
    )
    return {
        "status": "success",
        "mode": result.get("mode") or "incremental",
        "job_id": result.get("job_id"),
        "result": result.get("result") or {},
        "message": result.get("message") or "Geo coverage sync completed.",
    }


async def sync_geo_coverage(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    """ARQ job for incremental geo coverage sync."""
    return await run_task_with_history(
        ctx,
        "sync_geo_coverage",
        _sync_geo_coverage_logic,
        manual_run=manual_run,
    )
