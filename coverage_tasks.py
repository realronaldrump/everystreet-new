# coverage_tasks.py
"""Module for orchestrating street coverage preprocessing and calculation
tasks.

This module contains functions that manage the workflow of fetching street
data, segmenting it, calculating coverage based on trip data, and updating
database status and results. These functions are typically called
asynchronously from API endpoints.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List
from collections import defaultdict

# Local module imports
from db import (
    progress_collection,
    coverage_metadata_collection,
    find_one_with_retry,
    update_one_with_retry,
)
from preprocess_streets import preprocess_streets as async_preprocess_streets
from street_coverage_calculation import (
    compute_coverage_for_location,
    compute_incremental_coverage,
    # generate_and_store_geojson # No longer called directly from here
)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


# --- Helper Function ---
# Keep collect_street_type_stats but update docstring to reflect its status
def collect_street_type_stats(features: List[Dict]) -> List[Dict[str, Any]]:
    """
    Collect statistics about street types and their coverage from GeoJSON features.

    NOTE: This function may be less efficient than the aggregation logic within
          the primary coverage calculation. It's primarily useful for ad-hoc analysis
          or if detailed stats are needed from raw GeoJSON features. The main
          calculation flow now returns pre-computed stats.

    Args:
        features: List of GeoJSON features representing streets, expected to have
                  'highway', 'segment_length', and 'driven' properties.

    Returns:
        List of dictionaries with statistics for each street type, sorted by length desc.
    """
    street_types = defaultdict(
        lambda: {
            "total": 0,
            "covered": 0,
            "length": 0.0, # Assume meters from segment_length
            "covered_length": 0.0, # Assume meters
            "undriveable_length": 0.0, # Track undriveable separately
            "driveable_length": 0.0, # Calculated
        }
    )

    for feature in features:
        properties = feature.get("properties", {})
        street_type = properties.get("highway", "unknown")
        # Use segment_length which should be pre-calculated in meters
        length = properties.get("segment_length", 0.0) or 0.0 # Ensure float
        is_covered = properties.get("driven", False)
        is_undriveable = properties.get("undriveable", False)

        street_types[street_type]["total"] += 1
        street_types[street_type]["length"] += length

        if is_undriveable:
            street_types[street_type]["undriveable_length"] += length
        else:
            # Calculate driveable length only for non-undriveable segments
            street_types[street_type]["driveable_length"] += length
            if is_covered:
                street_types[street_type]["covered"] += 1
                street_types[street_type]["covered_length"] += length

    # Convert to list format for easier consumption
    result = []
    for street_type, stats in street_types.items():
        coverage_pct = (
            (stats["covered_length"] / stats["driveable_length"] * 100) # Use driveable_length for percentage
            if stats["driveable_length"] > 0
            else 0
        )
        result.append(
            {
                "type": street_type,
                "total_segments": stats["total"],
                "covered_segments": stats["covered"], # Covered and driveable
                "total_length_m": round(stats["length"], 2),
                "covered_length_m": round(stats["covered_length"], 2),
                "driveable_length_m": round(stats["driveable_length"], 2),
                "undriveable_length_m": round(stats["undriveable_length"], 2),
                "coverage_percentage": round(coverage_pct, 2),
            }
        )

    # Sort by total length descending
    result.sort(key=lambda x: x["total_length_m"], reverse=True)
    return result


# --- Coverage Calculation Orchestration ---
async def process_coverage_calculation(
    location: Dict[str, Any], task_id: str
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
        # Initialize progress tracking (minimal, as calculation function takes over)
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Starting coverage calculation orchestration...",
                    "updated_at": datetime.now(timezone.utc),
                    "location": display_name, # Add location context
                    "status": "processing", # Initial status
                }
            },
            upsert=True,
        )

        # Call the core calculation function from street_coverage_calculation.py
        # This function now handles internal progress, metadata updates, and returns stats/None
        result = await compute_coverage_for_location(location, task_id)

        # --- Check Final Outcome ---
        # The 'compute_coverage_for_location' function should have updated
        # the progress and metadata collections to reflect the final state ('complete' or 'error').
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
                result.get("last_error", "Unknown error")
            )
        else:
            logger.info(
                "Coverage calculation task %s for %s completed successfully. Final status updates handled by the calculation function.",
                task_id,
                display_name,
            )
            # Optional: Log key results if needed for orchestration layer
            # logger.info(f"Task {task_id} Result: {result.get('coverage_percentage')}% coverage")

    except Exception as e:
        # This catches errors in the orchestration layer itself (e.g., initial progress update failed)
        error_msg = f"Unhandled error in coverage task orchestration {task_id} for {display_name}: {str(e)}"
        logger.exception(error_msg)

        try:
            # Attempt to update metadata and progress with error state as a fallback
            # It's possible the calculation function already did this if it reached its own error handler
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Orchestration Error: {str(e)[:200]}",
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
                upsert=True,
            )
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 0, # Reset progress on orchestration error
                        "message": f"Orchestration Error: {str(e)[:500]}",
                        "error": str(e)[:200],
                        "updated_at": datetime.now(timezone.utc),
                        "status": "error",
                    }
                },
            )
        except Exception as inner_e:
            logger.error(
                "Task %s: Failed to update status after primary orchestration error: %s",
                task_id,
                str(inner_e),
            )


async def process_incremental_coverage_calculation(
    location: Dict[str, Any], task_id: str
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
        # Initialize progress tracking (minimal)
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
                }
            },
            upsert=True,
        )

        # Call the core incremental calculation function
        # This function handles its own progress updates and metadata updates
        result = await compute_incremental_coverage(location, task_id)

        # --- Check Final Outcome ---
        # Similar to full calculation, the incremental function handles final status updates.
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
                result.get("last_error", "Unknown error")
            )
        else:
            logger.info(
                "Incremental coverage task %s for %s completed successfully. Final status updates handled by the calculation function.",
                task_id,
                display_name,
            )

    except Exception as e:
        error_msg = f"Unhandled error in incremental coverage task orchestration {task_id} for {display_name}: {str(e)}"
        logger.exception(error_msg)

        try:
            # Fallback error state update
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Orchestration Error: {str(e)[:200]}",
                        "last_updated": datetime.now(timezone.utc),
                    }
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
                    }
                },
            )
        except Exception as inner_e:
            logger.error(
                "Task %s: Failed to update status after primary incremental orchestration error: %s",
                task_id,
                str(inner_e),
            )


async def process_area(location: Dict[str, Any], task_id: str) -> None:
    """
    Orchestrates the processing of a full area: preprocess streets then calculate coverage.

    Manages progress updates and status throughout the combined process.

    Args:
        location: Dictionary with location data.
        task_id: Unique identifier for tracking this combined task run.
    """
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        "Starting full area processing task %s for %s", task_id, display_name
    )
    overall_status = "processing" # Track overall task status

    try:
        # 1. Initialize Progress and Metadata Status for Preprocessing
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
                }
            },
            upsert=True,
        )
        # Use retry wrapper for DB operation
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {
                "$set": {
                    "location": location,
                    "status": "preprocessing",  # Mark as preprocessing
                    "last_updated": datetime.now(timezone.utc),
                    "last_error": None,  # Clear previous errors
                    "needs_stats_update": False, # Reset flag
                    # Reset stats, they will be calculated later
                    "total_length_m": 0.0,
                    "driven_length_m": 0.0,
                    "coverage_percentage": 0.0,
                    "total_segments": 0,
                    "covered_segments": 0,
                    "driveable_length_m": 0.0,
                    "street_types": [],
                    "streets_geojson_gridfs_id": None, # Clear old GeoJSON ref
                },
                "$unset": {"streets_data": ""} # Remove legacy field if present
            },
            upsert=True,
        )

        # 2. Preprocess Streets
        await progress_collection.update_one(
            {"_id": task_id},
            {"$set": {"progress": 5, "message": "Preprocessing streets (fetching OSM data)..."}},
        )
        # Call the preprocessing function from preprocess_streets.py
        # This function updates metadata status internally on success/error
        await async_preprocess_streets(location)

        # Check status after preprocessing
        metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        # async_preprocess_streets should set status to 'completed' on success, 'error' on failure
        preprocessing_status = metadata.get("status") if metadata else "error"

        if preprocessing_status == "error":
            error_msg = metadata.get("last_error", "Preprocessing failed (unknown reason)")
            logger.error(
                "Task %s: Preprocessing failed for %s: %s",
                task_id, display_name, error_msg,
            )
            overall_status = "error"
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 10, # Indicate some progress
                        "message": f"Preprocessing failed: {error_msg}",
                        "error": error_msg,
                        "updated_at": datetime.now(timezone.utc),
                        "status": "error",
                    }
                },
            )
            return # Stop processing

        logger.info(
            "Task %s: Preprocessing completed for %s. Proceeding to coverage calculation.",
            task_id, display_name
        )
        # Update metadata status to 'calculating' before starting calculation
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {"$set": {"status": "calculating"}},
        )

        # 3. Calculate Coverage
        # Update progress *before* calling the potentially long calculation
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "calculating",
                    "progress": 25, # Arbitrary progress point after preprocessing
                    "message": "Starting coverage calculation...",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )
        # Call the full coverage calculation orchestration function
        # This now handles its own progress/metadata updates for the calculation part
        # and returns the final stats dict or None
        calculation_result = await compute_coverage_for_location(location, task_id)

        # Check the final outcome based on the result from the calculation function
        if calculation_result is None or calculation_result.get("status") == "error":
            overall_status = "error"
            final_error = (
                 calculation_result.get("last_error", "Calculation failed")
                 if calculation_result else "Calculation function returned None"
            )
            logger.error(
                "Full area processing task %s failed during coverage calculation for %s: %s",
                task_id, display_name, final_error,
            )
            # The calculation function should have updated the final progress/metadata status to error.
            # No further updates needed here unless we want to overwrite.
        else:
             overall_status = "complete"
             logger.info(
                "Full area processing task %s completed successfully for %s.",
                task_id, display_name,
             )
             # The calculation function should have updated the final progress/metadata status to complete.

    except Exception as e:
        overall_status = "error"
        error_msg = f"Unhandled error during area processing task {task_id} for {display_name}: {str(e)}"
        logger.exception(error_msg)

        try:
            # Attempt to update metadata and progress with error state
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Area Processing Error: {str(e)[:200]}",
                        "last_updated": datetime.now(timezone.utc),
                    }
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
                    }
                },
            )
        except Exception as inner_e:
            logger.error(
                "Task %s: Failed to update status after primary area processing error: %s",
                task_id,
                str(inner_e),
            )
    finally:
         logger.info(f"Task {task_id} orchestration for {display_name} finished with final status: {overall_status}")