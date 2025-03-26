"""
Module for orchestrating street coverage preprocessing and calculation tasks.

This module contains functions that manage the workflow of fetching street data,
segmenting it, calculating coverage based on trip data, and updating database
status and results. These functions are typically called asynchronously from API endpoints.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List
from collections import defaultdict

# Local module imports
from db import progress_collection, coverage_metadata_collection
from preprocess_streets import preprocess_streets as async_preprocess_streets
from street_coverage_calculation import (
    compute_coverage_for_location,
    compute_incremental_coverage,
)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


# --- Helper Function ---
def collect_street_type_stats(features: List[Dict]) -> List[Dict[str, Any]]:
    """
    Collect statistics about street types and their coverage from GeoJSON features.

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
        length = properties.get("segment_length", 0)
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
async def process_coverage_calculation(location: Dict[str, Any], task_id: str) -> None:
    """
    Orchestrates the full coverage calculation process in the background.

    Manages progress updates and handles final status/result updates in the database.

    Args:
        location: Dictionary with location data (e.g., display_name, osm_id).
        task_id: Unique identifier for tracking this specific task run.
    """
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        f"Starting full coverage calculation task {task_id} for {display_name}"
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
        # This function now includes progress updates via the task_id
        result = await compute_coverage_for_location(location, task_id)

        if result and result.get("streets_data"):
            logger.info(
                f"Coverage calculation successful for {display_name}. Updating metadata."
            )

            # Recalculate street type stats from the final GeoJSON if needed,
            # though compute_coverage_for_location should ideally return it.
            # Ensure the structure returned by compute_coverage matches expectations.
            street_types_stats = result.get("street_types")
            if not street_types_stats and result.get("streets_data"):
                logger.warning(
                    f"Street type stats missing in result for {display_name}, calculating now."
                )
                street_types_stats = collect_street_type_stats(
                    result["streets_data"].get("features", [])
                )

            # Update coverage metadata with the final results
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": result["total_length"],
                        "driven_length": result["driven_length"],
                        "coverage_percentage": result["coverage_percentage"],
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",
                        "last_error": None,  # Clear any previous error
                        "streets_data": result["streets_data"],  # Store the GeoJSON
                        "total_segments": result.get("total_segments", 0),
                        "street_types": street_types_stats,
                    }
                },
                upsert=True,  # Use upsert=True cautiously, ensure display_name is unique key
            )

            # Update progress status to complete
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "complete",
                        "progress": 100,
                        "message": "Coverage calculation completed successfully.",
                        "result": {  # Store key metrics in progress result
                            "total_length": result["total_length"],
                            "driven_length": result["driven_length"],
                            "coverage_percentage": result["coverage_percentage"],
                            "total_segments": result.get("total_segments", 0),
                        },
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
            logger.info(f"Task {task_id} completed for {display_name}.")

        elif result is None:
            # The compute_coverage_for_location function likely handled error logging and status updates already.
            # We just log here that the task didn't return a result.
            logger.error(
                f"Coverage calculation task {task_id} for {display_name} returned None (likely an error occurred)."
            )

        else:  # Result exists but streets_data might be missing or empty
            error_msg = "Coverage calculation finished but returned no street data."
            logger.error(f"Task {task_id} for {display_name}: {error_msg}")

            # Update coverage metadata with error status
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": error_msg,
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
                upsert=True,
            )
            # Update progress status with error
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 0,  # Or some relevant progress value if partial failure
                        "message": error_msg,
                        "error": error_msg,
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )

    except Exception as e:
        error_msg = f"Unhandled error in coverage calculation task {task_id} for {display_name}: {str(e)}"
        logger.exception(error_msg)  # Log the full traceback

        try:
            # Attempt to update metadata and progress with error state
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
                        "message": f"Error: {str(e)}",
                        "error": str(e),
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as inner_e:
            logger.error(
                f"Task {task_id}: Failed to update status after primary error: {str(inner_e)}"
            )


async def process_incremental_coverage_calculation(
    location: Dict[str, Any], task_id: str
) -> None:
    """
    Orchestrates the incremental coverage calculation process in the background.

    Manages progress updates and handles final status/result updates in the database.

    Args:
        location: Dictionary with location data (must include display_name).
        task_id: Unique identifier for tracking this specific task run.
    """
    display_name = location.get("display_name", "Unknown Location")
    logger.info(
        f"Starting incremental coverage calculation task {task_id} for {display_name}"
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
                f"Incremental coverage task {task_id} for {display_name} completed successfully."
            )
        else:
            # The compute_incremental_coverage function handled error reporting.
            logger.error(
                f"Incremental coverage task {task_id} for {display_name} failed or returned no result."
            )

    except Exception as e:
        error_msg = f"Unhandled error in incremental coverage task {task_id} for {display_name}: {str(e)}"
        logger.exception(error_msg)

        try:
            # Attempt to update metadata and progress with error state
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": str(e),
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
                # Ensure this update doesn't accidentally create a new record if it fails early
                # upsert=False might be safer if the record should exist
                upsert=True,
            )
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 0,  # Or current progress
                        "message": f"Error: {str(e)}",
                        "error": str(e),
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as inner_e:
            logger.error(
                f"Task {task_id}: Failed to update status after primary error: {str(inner_e)}"
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
    logger.info(f"Starting full area processing task {task_id} for {display_name}")
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
        await coverage_metadata_collection.update_one(
            {"location.display_name": display_name},
            {
                "$set": {
                    "location": location,
                    "status": "processing",  # Mark as processing
                    "last_updated": datetime.now(timezone.utc),
                    "last_error": None,  # Clear previous errors
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
        await async_preprocess_streets(location)

        # Check status after preprocessing
        metadata = await coverage_metadata_collection.find_one(
            {"location.display_name": display_name}
        )
        if metadata and metadata.get("status") == "error":
            error_msg = metadata.get("last_error", "Preprocessing failed")
            logger.error(
                f"Task {task_id}: Preprocessing failed for {display_name}: {error_msg}"
            )
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "message": f"Preprocessing failed: {error_msg}",
                        "error": error_msg,
                    }
                },
            )
            return  # Stop processing

        logger.info(f"Task {task_id}: Preprocessing completed for {display_name}.")

        # 3. Calculate Coverage
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "calculating",
                    "progress": 50,
                    "message": "Calculating coverage...",
                }
            },
        )
        # Call the full coverage calculation orchestration function (which handles its own progress/metadata updates)
        await process_coverage_calculation(location, task_id)

        # Final check on status (process_coverage_calculation updates status)
        final_metadata = await coverage_metadata_collection.find_one(
            {"location.display_name": display_name}
        )
        if final_metadata and final_metadata.get("status") == "completed":
            logger.info(
                f"Full area processing task {task_id} completed successfully for {display_name}."
            )
        elif final_metadata and final_metadata.get("status") == "error":
            logger.error(
                f"Full area processing task {task_id} failed during coverage calculation for {display_name}."
            )
            # Ensure progress reflects the error state if process_coverage_calculation didn't finalize it
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "message": f"Coverage calculation failed: {final_metadata.get('last_error')}",
                        "error": final_metadata.get("last_error"),
                    }
                },
                upsert=True,  # Ensure update happens
            )
        else:
            logger.warning(
                f"Full area processing task {task_id} for {display_name} finished with unexpected status: {final_metadata.get('status') if final_metadata else 'Unknown'}."
            )

    except Exception as e:
        error_msg = f"Unhandled error during area processing task {task_id} for {display_name}: {str(e)}"
        logger.exception(error_msg)

        try:
            # Attempt to update metadata and progress with error state
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
                        "message": f"Error: {str(e)}",
                        "error": str(e),
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as inner_e:
            logger.error(
                f"Task {task_id}: Failed to update status after primary error: {str(inner_e)}"
            )
