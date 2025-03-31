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
    find_one_with_retry,  # Import if needed for final status check
    update_one_with_retry,  # Import if needed for final status check
)
from preprocess_streets import preprocess_streets as async_preprocess_streets
from street_coverage_calculation import (
    compute_coverage_for_location,
    compute_incremental_coverage,
    # generate_and_store_geojson # No need to call this directly here, it's called internally now
)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


# --- Helper Function ---
# Keep collect_street_type_stats as it might be useful elsewhere, but it's not strictly needed here anymore
def collect_street_type_stats(features: List[Dict]) -> List[Dict[str, Any]]:
    """
    Collect statistics about street types and their coverage from GeoJSON features.
    NOTE: This is less efficient than the aggregation pipeline used in the optimized calculation.
          Prefer using the stats returned directly from the calculation result.

    Args:
        features: List of GeoJSON features representing streets, expected to have
                  'highway', 'segment_length', and 'driven' properties.

    Returns:
        List of dictionaries with statistics for each street type, sorted by length desc.
    """
    street_types = defaultdict(
        lambda: {"total": 0, "covered": 0, "length": 0, "covered_length": 0}
    )

    for feature in features:
        properties = feature.get("properties", {})
        street_type = properties.get("highway", "unknown")
        # Use segment_length which should be pre-calculated in meters
        length = properties.get(
            "segment_length", 0
        )  # Make sure this property exists and is accurate
        is_covered = properties.get("driven", False)

        street_types[street_type]["total"] += 1
        street_types[street_type]["length"] += length

        if is_covered:
            street_types[street_type]["covered"] += 1
            street_types[street_type]["covered_length"] += length

    # Convert to list format for easier consumption
    result = []
    for street_type, stats in street_types.items():
        coverage_pct = (
            (stats["covered_length"] / stats["length"] * 100)
            if stats["length"] > 0
            else 0
        )
        result.append(
            {
                "type": street_type,
                "total": stats["total"],
                "covered": stats["covered"],
                "length": stats["length"],  # Length in meters
                "covered_length": stats["covered_length"],  # Length in meters
                "coverage_percentage": coverage_pct,
            }
        )

    # Sort by total length descending
    result.sort(key=lambda x: x["length"], reverse=True)
    return result


# --- Coverage Calculation Orchestration ---
async def process_coverage_calculation(
    location: Dict[str, Any], task_id: str
) -> None:
    """Orchestrates the full coverage calculation process in the background.

    Manages progress updates and handles final status/result updates in the database.
    This function now expects the calculation result to be a dictionary of statistics
    or None on failure. GeoJSON generation is handled separately by the calculation module.

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
        # Initialize progress tracking
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Starting coverage calculation...",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        # Call the core calculation function from street_coverage_calculation.py
        # This function now includes progress updates via the task_id and returns stats or None
        result = await compute_coverage_for_location(location, task_id)

        # --- Check Result ---
        # A successful calculation returns a dictionary with statistics.
        # None indicates an error occurred during calculation (already logged/status updated by calc function).
        if result:
            logger.info(
                "Coverage calculation successful for %s. Updating metadata with final stats.",
                display_name,
            )

            # Stats are directly available in the result dictionary
            street_types_stats = result.get("street_types", [])

            # Update coverage metadata with the final results (excluding streets_data)
            # The 'status' should be 'completed' as set by the calculation function on success.
            # The 'streets_data' field will be updated later by generate_and_store_geojson.
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": result["total_length"],
                        "driven_length": result["driven_length"],
                        "coverage_percentage": result["coverage_percentage"],
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",  # Should be already set by calculator on success
                        "last_error": None,  # Clear any previous error
                        # DO NOT set streets_data here
                        "total_segments": result.get("total_segments", 0),
                        "street_types": street_types_stats,
                    }
                },
                upsert=True,
            )

            # Update progress status to complete (or reflect GeoJSON generation start)
            # The calculation function already sets progress to 100 and stage to 'complete'.
            # We can optionally add a note about GeoJSON generation here.
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "complete",  # Keep as complete
                        "progress": 100,
                        "message": "Coverage calculation complete. GeoJSON generation started.",
                        "result": {  # Store key metrics in progress result
                            "total_length": result["total_length"],
                            "driven_length": result["driven_length"],
                            "coverage_percentage": result[
                                "coverage_percentage"
                            ],
                            "total_segments": result.get("total_segments", 0),
                        },
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
            logger.info(
                "Task %s calculation part completed for %s.",
                task_id,
                display_name,
            )

        else:  # result is None
            # The compute_coverage_for_location function handled error logging and status updates already.
            # We just log here that the task didn't return a result.
            logger.error(
                "Coverage calculation task %s for %s returned None (error occurred during calculation).",
                task_id,
                display_name,
            )
            # No need to update metadata/progress here, calculator should have set it to 'error'

    except Exception as e:
        error_msg = f"Unhandled error in coverage calculation task orchestration {task_id} for {display_name}: {str(e)}"
        logger.exception(error_msg)  # Log the full traceback

        try:
            # Attempt to update metadata and progress with error state as a fallback
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": str(e),
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
                        "progress": 0,  # Or current progress if available
                        "message": f"Orchestration Error: {str(e)}",
                        "error": str(e),
                        "updated_at": datetime.now(timezone.utc),
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
    """Orchestrates the incremental coverage calculation process in the
    background.

    Manages progress updates and handles final status/result updates in the database.
    Expects calculation result to be stats dict or None.

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
        # Initialize progress tracking
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Starting incremental coverage calculation...",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        # Call the core incremental calculation function
        # This function handles its own progress updates and metadata updates
        result = await compute_incremental_coverage(location, task_id)

        if result:
            # Incremental function already updated metadata and progress on success
            logger.info(
                "Incremental coverage task %s for %s completed successfully (calculation part).",
                task_id,
                display_name,
            )
            # Progress/metadata should reflect 'complete' state from the calculator function.
            # GeoJSON generation is triggered separately within compute_incremental_coverage.
        else:
            # The compute_incremental_coverage function handled error reporting.
            logger.error(
                "Incremental coverage task %s for %s failed or returned no result.",
                task_id,
                display_name,
            )
            # Progress/metadata should reflect 'error' state from the calculator function.

    except Exception as e:
        error_msg = f"Unhandled error in incremental coverage task orchestration {task_id} for {display_name}: {str(e)}"
        logger.exception(error_msg)

        try:
            # Attempt to update metadata and progress with error state as fallback
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": str(e),
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
                        "progress": 0,  # Or current progress
                        "message": f"Orchestration Error: {str(e)}",
                        "error": str(e),
                        "updated_at": datetime.now(timezone.utc),
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
    try:
        # 1. Initialize Progress and Metadata Status
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "preprocessing",
                    "progress": 0,
                    "message": "Initializing area processing...",
                    "updated_at": datetime.now(timezone.utc),
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
                    # Reset stats, they will be calculated later
                    "total_length": 0,
                    "driven_length": 0,
                    "coverage_percentage": 0,
                    "total_segments": 0,
                    "street_types": [],
                    "streets_data": None,  # Clear old GeoJSON if any
                }
            },
            upsert=True,  # Create metadata entry if it doesn't exist
        )

        # 2. Preprocess Streets
        await progress_collection.update_one(
            {"_id": task_id},
            {"$set": {"progress": 5, "message": "Preprocessing streets..."}},
        )
        # Call the preprocessing function from preprocess_streets.py
        # This function updates metadata status internally on success/error
        await async_preprocess_streets(location)

        # Check status after preprocessing
        # Use retry wrapper for DB operation
        metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        # Preprocessing sets status to 'processing' on success, 'error' on failure
        if not metadata or metadata.get("status") == "error":
            error_msg = (
                metadata.get(
                    "last_error", "Preprocessing failed (unknown reason)"
                )
                if metadata
                else "Preprocessing failed (metadata not found)"
            )
            logger.error(
                "Task %s: Preprocessing failed for %s: %s",
                task_id,
                display_name,
                error_msg,
            )
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 10,  # Indicate some progress was made
                        "message": f"Preprocessing failed: {error_msg}",
                        "error": error_msg,
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
            return  # Stop processing

        logger.info(
            "Task %s: Preprocessing completed for %s.", task_id, display_name
        )
        # Update metadata status to 'calculating' before starting calculation
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {"$set": {"status": "calculating"}},
        )

        # 3. Calculate Coverage
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "calculating",
                    "progress": 50,  # Set progress before calling calculation
                    "message": "Calculating coverage...",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )
        # Call the full coverage calculation orchestration function
        # This now handles its own progress/metadata updates for the calculation part
        await process_coverage_calculation(location, task_id)

        # Final check on status (process_coverage_calculation updates status via compute_coverage_for_location)
        # Use retry wrapper for DB operation
        final_metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        final_status = (
            final_metadata.get("status") if final_metadata else "unknown"
        )
        final_error = (
            final_metadata.get("last_error")
            if final_metadata
            else "Unknown error"
        )

        if final_status == "completed":
            logger.info(
                "Full area processing task %s completed successfully for %s.",
                task_id,
                display_name,
            )
            # Progress should already be 100% from process_coverage_calculation
        elif final_status == "error":
            logger.error(
                "Full area processing task %s failed during coverage calculation for %s: %s",
                task_id,
                display_name,
                final_error,
            )
            # Ensure progress reflects the error state if process_coverage_calculation didn't finalize it
            # (It should have, but this is a safety check)
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "message": f"Coverage calculation failed: {final_error}",
                        "error": final_error,
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
                # Don't upsert here, if progress doc is missing something is very wrong
            )
        else:
            logger.warning(
                "Full area processing task %s for %s finished with unexpected status: %s.",
                task_id,
                display_name,
                final_status,
            )
            # Update progress to reflect unexpected state
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "warning",  # Or keep as 'calculating' if unsure?
                        "message": f"Task finished with unexpected status: {final_status}",
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )

    except Exception as e:
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
                        "last_error": str(e),
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
                        "progress": 0,  # Or current progress
                        "message": f"Orchestration Error: {str(e)}",
                        "error": str(e),
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as inner_e:
            logger.error(
                "Task %s: Failed to update status after primary area processing error: %s",
                task_id,
                str(inner_e),
            )
