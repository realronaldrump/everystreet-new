"""
Coverage calculation tasks.

This module provides Celery tasks for coverage operations.

In the new event-driven system, coverage updates happen automatically when trips
complete. This task is kept for manual/scheduled full refreshes of coverage statistics.
"""

from __future__ import annotations

from typing import Any

from celery import shared_task
from celery.utils.log import get_task_logger

from core.async_bridge import run_async_from_sync
from coverage.models import CoverageArea
from coverage.stats import update_area_stats
from tasks.core import task_runner

logger = get_task_logger(__name__)


@task_runner
async def update_coverage_for_new_trips_async(_self) -> dict[str, Any]:
    """
    Refresh coverage statistics for all areas.

    In the new event-driven system, coverage updates happen automatically
    when trips complete. This task recalculates stats for all areas,
    which is useful for:
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

        except Exception as e:
            logger.error(
                "Error refreshing stats for '%s': %s",
                display_name,
                e,
                exc_info=True,
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


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=300,
    time_limit=7200,
    soft_time_limit=7000,
    name="tasks.update_coverage_for_new_trips",
    queue="default",
)
def update_coverage_for_new_trips(_self, *_args, **_kwargs):
    """Celery task wrapper for refreshing coverage statistics."""
    return run_async_from_sync(update_coverage_for_new_trips_async(_self))
