"""Route handlers for coverage area management.

Handles CRUD operations for coverage areas and their details.
"""

import logging
import time
import uuid
from datetime import UTC, datetime

from bson import ObjectId
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse

from coverage.serializers import serialize_coverage_area, serialize_coverage_details
from coverage_tasks import process_area
from db import (
    db_manager,
    delete_many_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    update_one_with_retry,
)
from models import DeleteCoverageAreaModel, LocationModel

logger = logging.getLogger(__name__)
router = APIRouter()

coverage_metadata_collection = db_manager.db["coverage_metadata"]
streets_collection = db_manager.db["streets"]
progress_collection = db_manager.db["progress_status"]
osm_data_collection = db_manager.db["osm_data"]


@router.get("/api/coverage_areas")
async def get_coverage_areas():
    """Get all coverage areas."""
    try:
        areas = await find_with_retry(coverage_metadata_collection, {})
        processed_areas = [serialize_coverage_area(area) for area in areas]

        return {
            "success": True,
            "areas": processed_areas,
        }
    except Exception as e:
        logger.error(
            "Error fetching coverage areas: %s",
            str(e),
            exc_info=True,
        )
        return JSONResponse(
            status_code=500, content={"success": False, "error": str(e)}
        )


@router.get("/api/coverage_areas/{location_id}")
async def get_coverage_area_details(location_id: str):
    """Get detailed information about a coverage area."""
    overall_start_time = time.perf_counter()
    logger.info("[%s] Request received for coverage area details.", location_id)

    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    t_start_find_meta = time.perf_counter()
    coverage_doc = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
    )
    t_end_find_meta = time.perf_counter()
    logger.info(
        "[%s] Found coverage_doc in %.4fs.",
        location_id,
        t_end_find_meta - t_start_find_meta,
    )

    if not coverage_doc:
        raise HTTPException(
            status_code=404,
            detail="Coverage area not found",
        )

    location_info = coverage_doc.get("location")
    if not isinstance(location_info, dict) or not location_info.get("display_name"):
        logger.error(
            "Coverage area %s has malformed or missing 'location' data.",
            location_id,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"Coverage area with ID '{location_id}' was found but "
                "contains incomplete or malformed internal location "
                "information. Please check data integrity."
            ),
        )

    result = {
        "success": True,
        "coverage": serialize_coverage_details(coverage_doc),
    }

    overall_end_time = time.perf_counter()
    logger.info(
        "[%s] Total processing time for get_coverage_area_details: %.4fs.",
        location_id,
        overall_end_time - overall_start_time,
    )
    return JSONResponse(content=result)


@router.post("/api/preprocess_streets")
async def preprocess_streets_route(location_data: LocationModel):
    """Preprocess streets data for a validated location."""
    display_name = None
    try:
        validated_location_dict = location_data.dict()
        display_name = validated_location_dict.get("display_name")

        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location data provided (missing display_name).",
            )

        existing = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        if existing and existing.get("status") == "processing":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This area is already being processed",
            )

        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {
                "$set": {
                    "location": validated_location_dict,
                    "status": "processing",
                    "last_error": None,
                    "last_updated": datetime.now(UTC),
                    "total_length": 0,
                    "driven_length": 0,
                    "coverage_percentage": 0,
                    "total_segments": 0,
                },
            },
            upsert=True,
        )

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

        import asyncio

        asyncio.create_task(process_area(validated_location_dict, task_id))
        return {
            "status": "success",
            "task_id": task_id,
        }

    except Exception as e:
        logger.exception(
            "Error in preprocess_streets_route for %s: %s",
            display_name,
            e,
        )
        try:
            if display_name:
                await coverage_metadata_collection.update_one(
                    {"location.display_name": display_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": str(e),
                        },
                    },
                )
        except Exception as db_err:
            logger.error(
                "Failed to update error status for %s: %s",
                display_name,
                db_err,
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/coverage_areas/delete")
async def delete_coverage_area(location: DeleteCoverageAreaModel):
    """Delete a coverage area and all associated data."""
    try:
        display_name = location.display_name
        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location display name",
            )

        coverage_metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )

        if not coverage_metadata:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage area not found",
            )

        # Delete GridFS files
        from coverage.gridfs_service import gridfs_service

        if gridfs_id := coverage_metadata.get("streets_geojson_gridfs_id"):
            await gridfs_service.delete_file(gridfs_id, display_name)

        # Delete all GridFS files tagged with this location
        await gridfs_service.delete_files_by_location(display_name)

        # Delete progress data
        try:
            await delete_many_with_retry(
                progress_collection,
                {"location": display_name},
            )
            logger.info("Deleted progress data for %s", display_name)
        except Exception as progress_err:
            logger.warning(
                "Error deleting progress data for %s: %s",
                display_name,
                progress_err,
            )

        # Delete cached OSM data
        try:
            await delete_many_with_retry(
                osm_data_collection,
                {"location.display_name": display_name},
            )
            logger.info("Deleted cached OSM data for %s", display_name)
        except Exception as osm_err:
            logger.warning(
                "Error deleting OSM data for %s: %s",
                display_name,
                osm_err,
            )

        # Delete street segments
        await delete_many_with_retry(
            streets_collection,
            {"properties.location": display_name},
        )
        logger.info("Deleted street segments for %s", display_name)

        # Delete coverage metadata
        await delete_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        logger.info("Deleted coverage metadata for %s", display_name)

        return {
            "status": "success",
            "message": "Coverage area and all associated data deleted successfully",
        }

    except Exception as e:
        logger.exception(
            "Error deleting coverage area: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/coverage_areas/cancel")
async def cancel_coverage_area(location: DeleteCoverageAreaModel):
    """Cancel processing of a coverage area."""
    try:
        display_name = location.display_name
        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location display name",
            )

        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {
                "$set": {
                    "status": "canceled",
                    "last_error": "Task was canceled by user.",
                },
            },
        )

        return {
            "status": "success",
            "message": "Coverage area processing canceled",
        }

    except Exception as e:
        logger.exception(
            "Error canceling coverage area: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
