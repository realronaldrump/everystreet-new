"""
Module for orchestrating street coverage preprocessing and calculation.

tasks.

This module contains functions that manage the workflow of fetching street data,
segmenting it, calculating coverage based on trip data, and updating database status and
results. These functions are typically called asynchronously from API endpoints.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from coverage import compute_coverage_for_location, compute_incremental_coverage
from coverage.location_settings import normalize_location_settings
from coverage.streets_preprocessor import build_street_segments
from db.models import CoverageMetadata, ProgressStatus
from preprocess_streets import preprocess_streets as async_preprocess_streets

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def _update_progress(
    task_id: str,
    update_data: dict[str, Any],
    upsert: bool = True,
) -> None:
    """Helper to update progress status using Beanie."""
    # Ensure updated_at is set if not present (though usually passed in update_data)
    # Beanie doesn't strictly require on_insert if we are just setting fields that match the model
    # But for upsert we need the base document if inserting.

    # Using find_one(...).upsert() with Beanie:
    # update query is required.

    # Simpler approach matching calculator.py:
    doc = await ProgressStatus.get(task_id)
    if doc:
        await doc.set(update_data)
    elif upsert:
        # Create new
        # Need to ensure all required fields are present or defaults are used
        # ProgressStatus model has optional fields mostly?
        # Assuming task_id is the _id
        # We need to construct the object
        # update_data might contain "$set", strip it if present
        data = update_data.get("$set", update_data)
        doc = ProgressStatus(id=task_id, **data)
        await doc.insert()
    else:
        logger.warning("Task %s not found for update and upsert=False", task_id)


async def _update_coverage_metadata(
    display_name: str,
    update_data: dict[str, Any],
) -> None:
    """Helper to update coverage metadata using Beanie."""
    data = update_data.get("$set", update_data)
    unset_data = update_data.get("$unset")

    # Use Beanie's native find/update pattern
    doc = await CoverageMetadata.find_one({"location.display_name": display_name})
    if doc:
        # Construct update query
        req = {}
        if data:
            req["$set"] = data
        if unset_data:
            req["$unset"] = unset_data

        if req:
            await doc.update(req)
    # Create new document if it doesn't exist (upsert behavior)
    elif "location" in data:
        new_doc = CoverageMetadata(**data)
        await new_doc.insert()


async def process_coverage_calculation(
    location: dict[str, Any],
    task_id: str,
) -> None:
    """
    Orchestrates the full coverage calculation process in the background.

    Delegates the core calculation, progress updates, and result handling to
    `compute_coverage_for_location`. This function primarily initializes the
    task and handles top-level errors.

    Args:
        location: Dictionary with location data (e.g., display_name, osm_id).
        task_id: Unique identifier for tracking this specific task run.
    """
    location = normalize_location_settings(location)
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Starting full coverage calculation task %s for %s",
        task_id,
        display_name,
    )
    try:
        await _update_progress(
            task_id,
            {
                "stage": "initializing",
                "progress": 0,
                "message": "Starting coverage calculation orchestration...",
                "updated_at": datetime.now(UTC),
                "location": display_name,
                "status": "processing",
            },
        )

        result = await compute_coverage_for_location(location, task_id)

        if result is None:
            logger.error(
                "Coverage calculation task %s for %s ended with an error (result is None). Status should be updated by the calculation function.",
                task_id,
                display_name,
            )
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Coverage calculation failed",
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
        elif result.get("status") == "error":
            logger.error(
                "Coverage calculation task %s for %s completed with an error state: %s. Status should be updated by the calculation function.",
                task_id,
                display_name,
                result.get("last_error", "Unknown error"),
            )
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": result.get("last_error", "Coverage error"),
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
        else:
            logger.info(
                "Coverage calculation task %s for %s completed successfully. Final status updates handled by the calculation function.",
                task_id,
                display_name,
            )

    except Exception as e:
        logger.exception(
            "Unhandled error in coverage task orchestration %s for %s",
            task_id,
            display_name,
        )

        try:
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Orchestration Error: {str(e)[:200]}",
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
            await _update_progress(
                task_id,
                {
                    "stage": "error",
                    "progress": 0,
                    "message": f"Orchestration Error: {str(e)[:500]}",
                    "error": str(e)[:200],
                    "updated_at": datetime.now(UTC),
                    "status": "error",
                },
            )
        except Exception:
            logger.exception(
                "Task %s: Failed to update status after primary orchestration error",
                task_id,
            )


async def process_incremental_coverage_calculation(
    location: dict[str, Any],
    task_id: str,
) -> None:
    """
    Orchestrates the incremental coverage calculation process.

    Delegates the core calculation, progress updates, and result handling to
    `compute_incremental_coverage`.

    Args:
        location: Dictionary with location data (must include display_name).
        task_id: Unique identifier for tracking this specific task run.
    """
    location = normalize_location_settings(location)
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Starting incremental coverage calculation task %s for %s",
        task_id,
        display_name,
    )
    try:
        await _update_progress(
            task_id,
            {
                "stage": "initializing",
                "progress": 0,
                "message": "Starting incremental coverage orchestration...",
                "updated_at": datetime.now(UTC),
                "location": display_name,
                "status": "processing",
            },
        )

        result = await compute_incremental_coverage(location, task_id)

        if result is None:
            logger.error(
                "Incremental coverage task %s for %s ended with an error (result is None). Status should be updated by the calculation function.",
                task_id,
                display_name,
            )
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Incremental coverage calculation failed",
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
        elif result.get("status") == "error":
            logger.error(
                "Incremental coverage task %s for %s completed with an error state: %s. Status should be updated by the calculation function.",
                task_id,
                display_name,
                result.get("last_error", "Unknown error"),
            )
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": result.get("last_error", "Coverage error"),
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
        else:
            logger.info(
                "Incremental coverage task %s for %s completed successfully. Final status updates handled by the calculation function.",
                task_id,
                display_name,
            )

    except Exception as e:
        logger.exception(
            "Unhandled error in incremental coverage task orchestration %s for %s",
            task_id,
            display_name,
        )

        try:
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Orchestration Error: {str(e)[:200]}",
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
            await _update_progress(
                task_id,
                {
                    "stage": "error",
                    "progress": 0,
                    "message": f"Orchestration Error: {str(e)[:500]}",
                    "error": str(e)[:200],
                    "updated_at": datetime.now(UTC),
                    "status": "error",
                },
            )
        except Exception:
            logger.exception(
                "Task %s: Failed to update status after primary incremental orchestration error",
                task_id,
            )


async def process_area(
    location: dict[str, Any],
    task_id: str,
) -> None:
    """Orchestrates the processing of a full area: preprocess streets.

    then calculate coverage.

    Manages progress updates and status throughout the combined process.

    Args:
        location: Dictionary with location data.
        task_id: Unique identifier for tracking this combined task run.
    """
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Starting full area processing task %s for %s",
        task_id,
        display_name,
    )
    overall_status = "processing"

    try:
        await _update_progress(
            task_id,
            {
                "stage": "preprocessing",
                "progress": 0,
                "message": "Initializing area processing...",
                "updated_at": datetime.now(UTC),
                "location": display_name,
                "status": "processing",
            },
        )
        await _update_coverage_metadata(
            display_name,
            {
                "$set": {
                    "location": location,
                    "status": "preprocessing",
                    "last_updated": datetime.now(UTC),
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
                "$unset": {"streets_data": "", "processed_trips": ""},
            },
        )

        # Retrieve ID if it exists to ensure consistency
        metadata = await CoverageMetadata.find_one(
            CoverageMetadata.location.display_name == display_name,
        )
        if metadata and metadata.id:
            location["_id"] = str(metadata.id)

        await _update_progress(
            task_id,
            {
                "progress": 5,
                "message": "Preprocessing streets (fetching OSM data)...",
            },
        )

        # Preprocess streets (defaults or feet overrides handled internally)
        graph, _ = await async_preprocess_streets(location, task_id)

        await _update_progress(
            task_id,
            {
                "stage": "indexing",
                "progress": 10,
                "message": "Segmenting streets for coverage analysis...",
                "updated_at": datetime.now(UTC),
            },
        )

        try:
            segment_stats = await build_street_segments(
                location,
                task_id=task_id,
                graph=graph,
            )
        except Exception as seg_err:
            error_msg = f"Street segmentation failed: {seg_err}"
            logger.exception(
                "Task %s: Segmentation failed for %s: %s",
                task_id,
                display_name,
                error_msg,
            )
            overall_status = "error"
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": error_msg,
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
            await _update_progress(
                task_id,
                {
                    "stage": "error",
                    "progress": 20,
                    "message": error_msg,
                    "error": error_msg,
                    "updated_at": datetime.now(UTC),
                    "status": "error",
                },
            )
            return

        if not segment_stats.get("segment_count"):
            error_msg = "Street segmentation produced no segments"
            logger.error(
                "Task %s: %s for %s.",
                task_id,
                error_msg,
                display_name,
            )
            overall_status = "error"
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": error_msg,
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
            await _update_progress(
                task_id,
                {
                    "stage": "error",
                    "progress": 20,
                    "message": error_msg,
                    "error": error_msg,
                    "updated_at": datetime.now(UTC),
                    "status": "error",
                },
            )
            return

        logger.info(
            "Task %s: Preprocessing completed for %s. Proceeding to coverage calculation.",
            task_id,
            display_name,
        )
        await _update_coverage_metadata(
            display_name,
            {"$set": {"status": "calculating"}},
        )

        await _update_progress(
            task_id,
            {
                "stage": "post_preprocessing",
                "progress": 40,
                "message": "Street preprocessing complete. Initializing coverage calculation...",
                "updated_at": datetime.now(UTC),
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
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": final_error,
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
            # Ensure progress is updated to error state so frontend stops polling
            await _update_progress(
                task_id,
                {
                    "stage": "error",
                    "status": "error",
                    "error": final_error,
                    "message": f"Coverage calculation failed: {final_error}",
                    "updated_at": datetime.now(UTC),
                },
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
        logger.exception(
            "Unhandled error during area processing task %s for %s",
            task_id,
            display_name,
        )

        try:
            await _update_coverage_metadata(
                display_name,
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Area Processing Error: {str(e)[:200]}",
                        "last_updated": datetime.now(UTC),
                    },
                },
            )
            await _update_progress(
                task_id,
                {
                    "stage": "error",
                    "message": f"Area Processing Error: {str(e)[:500]}",
                    "error": str(e)[:200],
                    "updated_at": datetime.now(UTC),
                    "status": "error",
                },
            )
        except Exception:
            logger.exception(
                "Task %s: Failed to update status after primary area processing error",
                task_id,
            )
    finally:
        logger.info(
            "Task %s orchestration for %s finished with final status: %s",
            task_id,
            display_name,
            overall_status,
        )
