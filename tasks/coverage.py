"""Coverage calculation tasks.

This module provides Celery tasks for updating street coverage calculations:
- update_coverage_for_new_trips: Incrementally updates coverage for all areas
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

from celery import shared_task
from celery.utils.log import get_task_logger

from db import (coverage_metadata_collection, find_with_retry,
                progress_collection, update_one_with_retry)
from street_coverage_calculation import compute_incremental_coverage
from tasks.core import task_runner
from utils import run_async_from_sync

logger = get_task_logger(__name__)


@task_runner
async def update_coverage_for_new_trips_async(_self) -> dict[str, Any]:
    """Async logic for updating coverage incrementally."""
    processed_areas = 0
    failed_areas = 0
    skipped_areas = 0

    coverage_areas = await find_with_retry(coverage_metadata_collection, {})
    logger.info(
        "Found %d coverage areas to check for incremental updates.",
        len(coverage_areas),
    )

    for area in coverage_areas:
        location = area.get("location")
        area_id_str = str(area.get("_id"))
        display_name = (
            location.get("display_name", "Unknown")
            if location
            else f"Unknown (ID: {area_id_str})"
        )

        if not location:
            logger.warning(
                "Skipping area %s due to missing location data.",
                area_id_str,
            )
            skipped_areas += 1
            continue

        sub_task_id = f"incr_update_{area_id_str}_{uuid.uuid4()}"
        logger.info(
            "Processing incremental update for '%s' (SubTask: %s)",
            display_name,
            sub_task_id,
        )

        try:
            result = await compute_incremental_coverage(location, sub_task_id)

            if result:
                logger.info(
                    "Successfully updated coverage for '%s'. New coverage: %.2f%%",
                    display_name,
                    result.get("coverage_percentage", 0),
                )
                processed_areas += 1
            else:
                logger.warning(
                    "Incremental update failed or returned no result for "
                    "'%s' (SubTask: %s). Check previous logs.",
                    display_name,
                    sub_task_id,
                )
                failed_areas += 1

            await asyncio.sleep(0.5)

        except Exception as inner_e:
            logger.error(
                "Error during incremental update for '%s': %s",
                display_name,
                inner_e,
                exc_info=True,
            )
            failed_areas += 1
            try:
                await update_one_with_retry(
                    progress_collection,
                    {"_id": sub_task_id},
                    {
                        "$set": {
                            "stage": "error",
                            "error": str(inner_e),
                            "updated_at": datetime.now(UTC),
                        }
                    },
                    upsert=True,
                )
            except Exception as prog_err:
                logger.error(
                    "Failed to update progress status for failed sub-task %s: %s",
                    sub_task_id,
                    prog_err,
                )
            continue

    logger.info(
        "Completed automated incremental updates. Processed: %d, "
        "Failed: %d, Skipped: %d",
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
            f"Completed incremental updates. Processed: {processed_areas}, "
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
    """Celery task wrapper for updating coverage incrementally."""
    return run_async_from_sync(update_coverage_for_new_trips_async(_self))
