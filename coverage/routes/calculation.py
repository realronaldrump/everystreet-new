"""Route handlers for coverage calculation operations.

Handles triggering coverage calculations and checking their status.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from bson import ObjectId
from fastapi import APIRouter, HTTPException, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from coverage.gridfs_service import gridfs_service
from coverage.serializers import serialize_progress
from coverage.services import coverage_stats_service
from coverage_tasks import (
    process_coverage_calculation,
    process_incremental_coverage_calculation,
)
from db import db_manager, find_one_with_retry, update_one_with_retry
from models import LocationModel

logger = logging.getLogger(__name__)
router = APIRouter()

progress_collection = db_manager.db["progress_status"]
coverage_metadata_collection = db_manager.db["coverage_metadata"]


@router.post("/api/street_coverage")
async def get_street_coverage(location: LocationModel):
    """Calculate street coverage for a location."""
    try:
        display_name = location.display_name or "Unknown Location"
        task_id = str(uuid.uuid4())

        await update_one_with_retry(
            progress_collection,
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Task queued, starting...",
                    "updated_at": datetime.now(UTC),
                    "location": display_name,
                    "status": "queued",
                },
            },
            upsert=True,
        )

        asyncio.create_task(
            process_coverage_calculation(location.dict(), task_id),
        )
        return {
            "task_id": task_id,
            "status": "processing",
        }
    except Exception as e:
        logger.exception(
            "Error in street coverage calculation: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/street_coverage/{task_id}")
async def get_coverage_status(task_id: str):
    """Get status of a coverage calculation task."""
    progress = await find_one_with_retry(progress_collection, {"_id": task_id})
    if not progress:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    # Return progress data even if in error state - let frontend handle it
    return serialize_progress(progress)


@router.post("/api/street_coverage/incremental")
async def get_incremental_street_coverage(location: LocationModel):
    """Update street coverage incrementally, processing only new trips."""
    try:
        display_name = location.display_name or "Unknown Location"
        task_id = str(uuid.uuid4())

        await update_one_with_retry(
            progress_collection,
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Task queued, starting...",
                    "updated_at": datetime.now(UTC),
                    "location": display_name,
                    "status": "queued",
                },
            },
            upsert=True,
        )

        asyncio.create_task(
            process_incremental_coverage_calculation(location.dict(), task_id),
        )
        return {
            "task_id": task_id,
            "status": "processing",
        }
    except Exception as e:
        logger.exception(
            "Error in incremental street coverage calculation: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/coverage_areas/{location_id}/refresh_stats")
async def refresh_coverage_stats(location_id: str):
    """Refresh statistics for a coverage area after manual modifications."""
    logger.info(
        "Received request to refresh stats for location_id: %s",
        location_id,
    )
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid location_id format",
        )

    updated_coverage_data = await coverage_stats_service.recalculate_stats(
        obj_location_id,
    )

    if updated_coverage_data is None:
        raise HTTPException(
            status_code=500,
            detail="Failed to recalculate statistics or coverage area not found.",
        )

    response_content = {
        "success": True,
        "coverage": updated_coverage_data,
    }

    encoded_content = jsonable_encoder(response_content)

    asyncio.create_task(gridfs_service.regenerate_streets_geojson(obj_location_id))

    return JSONResponse(content=encoded_content)
