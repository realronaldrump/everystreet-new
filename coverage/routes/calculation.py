"""Route handlers for coverage calculation operations.

Handles triggering coverage calculations and checking their status.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from models import LocationModel

from coverage.gridfs_service import gridfs_service
from coverage.services import coverage_stats_service
from coverage_tasks import (
    process_coverage_calculation,
    process_incremental_coverage_calculation,
)
from db import ProgressStatus

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/street_coverage")
async def get_street_coverage(location: LocationModel):
    """Calculate street coverage for a location."""
    try:
        display_name = location.display_name or "Unknown Location"
        task_id = str(uuid.uuid4())

        # Create progress status using Beanie
        progress = ProgressStatus(
            id=task_id,
            operation_type="initializing",
            progress=0,
            message="Task queued, starting...",
            updated_at=datetime.now(UTC),
            status="queued",
            result={"location": display_name},
        )
        await progress.insert()

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
    progress = await ProgressStatus.find_one({"_id": task_id})
    if not progress:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    # Return progress data even if in error state - let frontend handle it
    return progress.model_dump()


@router.post("/api/street_coverage/incremental")
async def get_incremental_street_coverage(location: LocationModel):
    """Update street coverage incrementally, processing only new trips."""
    try:
        display_name = location.display_name or "Unknown Location"
        task_id = str(uuid.uuid4())

        # Create progress status using Beanie
        progress = ProgressStatus(
            id=task_id,
            operation_type="initializing",
            progress=0,
            message="Task queued, starting...",
            updated_at=datetime.now(UTC),
            status="queued",
            result={"location": display_name},
        )
        await progress.insert()

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
async def refresh_coverage_stats(location_id: PydanticObjectId):
    """Refresh statistics for a coverage area after manual modifications."""
    logger.info(
        "Received request to refresh stats for location_id: %s",
        location_id,
    )

    updated_coverage_data = await coverage_stats_service.recalculate_stats(
        location_id,
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

    asyncio.create_task(gridfs_service.regenerate_streets_geojson(location_id))

    return JSONResponse(content=response_content)
