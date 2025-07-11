"""Module for orchestrating street coverage preprocessing and calculation
tasks.

This module contains functions that manage the workflow of fetching street
data, segmenting it, calculating coverage based on trip data, and updating
database status and results. These functions are typically called
asynchronously from API endpoints.
"""

import logging
from datetime import datetime, timezone
from typing import Any

from db import (
    coverage_metadata_collection,
    find_one_with_retry,
    progress_collection,
    update_one_with_retry,
)
from preprocess_streets import preprocess_streets as async_preprocess_streets
from street_coverage_calculation import (
    compute_coverage_for_location,
    compute_incremental_coverage,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def process_coverage_calculation(
    location: dict[str, Any],
    task_id: str,
) -> None:
    """Orchestrates the full coverage calculation process in the background.

    Delegates the core calculation, progress updates, and result handling to
    `compute_coverage_for_location`. This function primarily initializes the
    task and handles top-level errors.

    Args:
        location: Dictionary with location data (e.g., display_name, osm_id).
        task_id: Unique identifier for tracking this specific task run.

    """
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Starting full coverage calculation task %s for %s",
        task_id,
        display_name,
    )
    try:
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Starting coverage calculation orchestration...",
                    "updated_at": datetime.now(timezone.utc),
                    "location": display_name,
                    "status": "processing",
                },
            },
            upsert=True,
        )

        result = await compute_coverage_for_location(location, task_id)

        if result is None:
            logger.error(
                "Coverage calculation task %s for %s ended with an error (result is None). Status should be updated by the calculation function.",
                task_id,
                display_name,
            )
        elif result.get("status") == "error":
            logger.error(
                "Coverage calculation task %s for %s completed with an error state: %s. Status should be updated by the calculation function.",
                task_id,
                display_name,
                result.get("last_error", "Unknown error"),
            )
        else:
            logger.info(
                "Coverage calculation task %s for %s completed successfully. Final status updates handled by the calculation function.",
                task_id,
                display_name,
            )

    except Exception as e:
        error_msg = f"Unhandled error in coverage task orchestration {task_id} for {display_name}: {e!s}"
        logger.exception(error_msg)

        try:
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Orchestration Error: {str(e)[:200]}",
                        "last_updated": datetime.now(timezone.utc),
                    },
                },
                upsert=True,
            )
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 0,
                        "message": f"Orchestration Error: {str(e)[:500]}",
                        "error": str(e)[:200],
                        "updated_at": datetime.now(timezone.utc),
                        "status": "error",
                    },
                },
            )
        except Exception as inner_e:
            logger.error(
                "Task %s: Failed to update status after primary orchestration error: %s",
                task_id,
                str(inner_e),
            )


async def process_incremental_coverage_calculation(
    location: dict[str, Any],
    task_id: str,
) -> None:
    """Orchestrates the incremental coverage calculation process.

    Delegates the core calculation, progress updates, and result handling to
    `compute_incremental_coverage`.

    Args:
        location: Dictionary with location data (must include display_name).
        task_id: Unique identifier for tracking this specific task run.

    """
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Starting incremental coverage calculation task %s for %s",
        task_id,
        display_name,
    )
    try:
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Starting incremental coverage orchestration...",
                    "updated_at": datetime.now(timezone.utc),
                    "location": display_name,
                    "status": "processing",
                },
            },
            upsert=True,
        )

        result = await compute_incremental_coverage(location, task_id)

        if result is None:
            logger.error(
                "Incremental coverage task %s for %s ended with an error (result is None). Status should be updated by the calculation function.",
                task_id,
                display_name,
            )
        elif result.get("status") == "error":
            logger.error(
                "Incremental coverage task %s for %s completed with an error state: %s. Status should be updated by the calculation function.",
                task_id,
                display_name,
                result.get("last_error", "Unknown error"),
            )
        else:
            logger.info(
                "Incremental coverage task %s for %s completed successfully. Final status updates handled by the calculation function.",
                task_id,
                display_name,
            )

    except Exception as e:
        error_msg = f"Unhandled error in incremental coverage task orchestration {task_id} for {display_name}: {e!s}"
        logger.exception(error_msg)

        try:
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Orchestration Error: {str(e)[:200]}",
                        "last_updated": datetime.now(timezone.utc),
                    },
                },
                upsert=True,
            )
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 0,
                        "message": f"Orchestration Error: {str(e)[:500]}",
                        "error": str(e)[:200],
                        "updated_at": datetime.now(timezone.utc),
                        "status": "error",
                    },
                },
            )
        except Exception as inner_e:
            logger.error(
                "Task %s: Failed to update status after primary incremental orchestration error: %s",
                task_id,
                str(inner_e),
            )


async def process_area(
    location: dict[str, Any],
    task_id: str,
    segment_length_meters: float | None = None,
) -> None:
    """Orchestrates the processing of a full area: preprocess streets
    then calculate coverage.

    Manages progress updates and status throughout the combined process.

    Args:
        location: Dictionary with location data.
        task_id: Unique identifier for tracking this combined task run.
        segment_length_meters: Optional segment length in meters.

    """
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Starting full area processing task %s for %s",
        task_id,
        display_name,
    )
    overall_status = "processing"

    try:
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "preprocessing",
                    "progress": 0,
                    "message": "Initializing area processing...",
                    "updated_at": datetime.now(timezone.utc),
                    "location": display_name,
                    "status": "processing",
                },
            },
            upsert=True,
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {
                "$set": {
                    "location": location,
                    "status": "preprocessing",
                    "last_updated": datetime.now(timezone.utc),
                    "last_error": None,
                    "needs_stats_update": False,
                    "total_length_m": 0.0,
                    "driven_length_m": 0.0,
                    "coverage_percentage": 0.0,
                    "total_segments": 0,
                    "covered_segments": 0,
                    "driveable_length_m": 0.0,
                    "street_types": [],
                    "streets_geojson_gridfs_id": None,
                },
                "$unset": {"streets_data": ""},
            },
            upsert=True,
        )

        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "progress": 5,
                    "message": "Preprocessing streets (fetching OSM data)...",
                },
            },
        )
        # Determine segment length (defaults handled downstream)
        seg_len = (
            segment_length_meters
            if segment_length_meters is not None
            else location.get("segment_length_meters")
        )

        await async_preprocess_streets(location, task_id, seg_len or 100)

        metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        preprocessing_status = metadata.get("status") if metadata else "error"

        if preprocessing_status == "error":
            error_msg = metadata.get(
                "last_error",
                "Preprocessing failed (unknown reason)",
            )
            logger.error(
                "Task %s: Preprocessing failed for %s: %s",
                task_id,
                display_name,
                error_msg,
            )
            overall_status = "error"
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 10,
                        "message": f"Preprocessing failed: {error_msg}",
                        "error": error_msg,
                        "updated_at": datetime.now(timezone.utc),
                        "status": "error",
                    },
                },
            )
            return

        logger.info(
            "Task %s: Preprocessing completed for %s. Proceeding to coverage calculation.",
            task_id,
            display_name,
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {"$set": {"status": "calculating"}},
        )

        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "post_preprocessing",
                    "progress": 40,
                    "message": "Street preprocessing complete. Initializing coverage calculation...",
                    "updated_at": datetime.now(timezone.utc),
                },
            },
        )
        calculation_result = await compute_coverage_for_location(
            location,
            task_id,
        )

        if calculation_result is None or calculation_result.get("status") == "error":
            overall_status = "error"
            final_error = (
                calculation_result.get(
                    "last_error",
                    "Calculation failed",
                )
                if calculation_result
                else "Calculation function returned None"
            )
            logger.error(
                "Full area processing task %s failed during coverage calculation for %s: %s",
                task_id,
                display_name,
                final_error,
            )
        else:
            overall_status = "complete"
            logger.info(
                "Full area processing task %s completed successfully for %s.",
                task_id,
                display_name,
            )

    except Exception as e:
        overall_status = "error"
        error_msg = f"Unhandled error during area processing task {task_id} for {display_name}: {e!s}"
        logger.exception(error_msg)

        try:
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Area Processing Error: {str(e)[:200]}",
                        "last_updated": datetime.now(timezone.utc),
                    },
                },
                upsert=True,
            )
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "message": f"Area Processing Error: {str(e)[:500]}",
                        "error": str(e)[:200],
                        "updated_at": datetime.now(timezone.utc),
                        "status": "error",
                    },
                },
            )
        except Exception as inner_e:
            logger.error(
                "Task %s: Failed to update status after primary area processing error: %s",
                task_id,
                str(inner_e),
            )
    finally:
        logger.info(
            "Task %s orchestration for %s finished with final status: %s",
            task_id,
            display_name,
            overall_status,
        )
