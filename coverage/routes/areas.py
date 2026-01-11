"""
Route handlers for coverage area management.

Handles CRUD operations for coverage areas and their details.
"""

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse

from coverage.location_settings import normalize_location_settings
from coverage_tasks import process_area
from db import CoverageMetadata, OsmData, ProgressStatus, Street
from db.schemas import DeleteCoverageAreaModel, LocationModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/coverage_areas")
async def get_coverage_areas():
    """Get all coverage areas."""
    try:
        areas = await CoverageMetadata.find_all().to_list()
        processed_areas = []
        for area in areas:
            area_dict = area.model_dump(by_alias=True)
            # Ensure _id is serialized as string
            if area.id is not None:
                area_dict["_id"] = str(area.id)
            processed_areas.append(area_dict)

        return {"success": True, "areas": processed_areas}
    except Exception as e:
        logger.error(
            "Error fetching coverage areas: %s",
            str(e),
            exc_info=True,
        )
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)},
        )


@router.get("/api/coverage_areas/{location_id}")
async def get_coverage_area_details(location_id: PydanticObjectId):
    """Get detailed information about a coverage area."""
    overall_start_time = time.perf_counter()
    logger.info("[%s] Request received for coverage area details.", location_id)

    t_start_find_meta = time.perf_counter()
    coverage_doc = await CoverageMetadata.get(location_id)
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

    location_info = coverage_doc.location
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

    coverage_dict = coverage_doc.model_dump(by_alias=True)
    # Ensure _id is serialized as string
    if coverage_doc.id is not None:
        coverage_dict["_id"] = str(coverage_doc.id)

    result = {
        "success": True,
        "coverage": coverage_dict,
    }

    overall_end_time = time.perf_counter()
    logger.info(
        "[%s] Total processing time for get_coverage_area_details: %.4fs.",
        location_id,
        overall_end_time - overall_start_time,
    )
    return result


@router.post("/api/preprocess_streets")
async def preprocess_streets_route(location_data: LocationModel):
    """Preprocess streets data for a validated location."""
    display_name = None
    try:
        validated_location_dict = normalize_location_settings(location_data.dict())
        display_name = validated_location_dict.get("display_name")

        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location data provided (missing display_name).",
            )

        existing = await CoverageMetadata.find_one(
            {"location.display_name": display_name},
        )
        if existing and existing.status in {
            "processing",
            "preprocessing",
            "calculating",
            "queued",
        }:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This area is already being processed",
            )

        # Upsert coverage metadata
        if existing:
            existing.location = validated_location_dict
            existing.status = "processing"
            existing.last_error = None
            existing.last_updated = datetime.now(UTC)
            existing.total_length_miles = 0
            existing.driven_length_miles = 0
            existing.total_length_m = 0.0
            existing.driven_length_m = 0.0
            existing.coverage_percentage = 0
            existing.total_streets = 0
            await existing.save()
        else:
            new_coverage = CoverageMetadata(
                location=validated_location_dict,
                status="processing",
                last_updated=datetime.now(UTC),
                total_length_miles=0,
                driven_length_miles=0,
                total_length_m=0.0,
                driven_length_m=0.0,
                coverage_percentage=0,
                total_streets=0,
            )
            await new_coverage.insert()

        task_id = str(uuid.uuid4())

        # Create or update progress status
        progress = await ProgressStatus.find_one({"_id": task_id})
        if progress:
            progress.operation_type = "initializing"
            progress.progress = 0
            progress.message = "Task queued, starting..."
            progress.updated_at = datetime.now(UTC)
            progress.status = "queued"
            await progress.save()
        else:
            progress = ProgressStatus(
                id=task_id,
                operation_type="initializing",
                progress=0,
                message="Task queued, starting...",
                updated_at=datetime.now(UTC),
                status="queued",
            )
            # Store location in result dict for reference
            progress.result = {"location": display_name}
            await progress.insert()

        asyncio.create_task(process_area(validated_location_dict, task_id))
        return {
            "status": "success",
            "task_id": task_id,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "Error in preprocess_streets_route for %s: %s",
            display_name,
            e,
        )
        try:
            if display_name:
                existing = await CoverageMetadata.find_one(
                    {"location.display_name": display_name},
                )
                if existing:
                    existing.status = "error"
                    existing.last_error = str(e)
                    await existing.save()
        except Exception as db_err:
            logger.exception(
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

        coverage_metadata = await CoverageMetadata.find_one(
            {"location.display_name": display_name},
        )

        if not coverage_metadata:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage area not found",
            )

        # Delete GridFS files
        from coverage.gridfs_service import gridfs_service

        if gridfs_id := coverage_metadata.streets_geojson_id:
            await gridfs_service.delete_file(gridfs_id, display_name)

        # Delete all GridFS files tagged with this location
        await gridfs_service.delete_files_by_location(display_name)

        # Delete progress data
        try:
            await ProgressStatus.find({"result.location": display_name}).delete()
            logger.info("Deleted progress data for %s", display_name)
        except Exception as progress_err:
            logger.warning(
                "Error deleting progress data for %s: %s",
                display_name,
                progress_err,
            )

        # Delete cached OSM data
        try:
            await OsmData.find({"location": display_name}).delete()
            logger.info("Deleted cached OSM data for %s", display_name)
        except Exception as osm_err:
            logger.warning(
                "Error deleting OSM data for %s: %s",
                display_name,
                osm_err,
            )

        # Delete street segments
        await Street.find({"properties.location": display_name}).delete()
        logger.info("Deleted street segments for %s", display_name)

        # Delete coverage metadata
        await coverage_metadata.delete()
        logger.info("Deleted coverage metadata for %s", display_name)

        return {
            "status": "success",
            "message": "Coverage area and all associated data deleted successfully",
        }

    except HTTPException:
        raise
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

        coverage = await CoverageMetadata.find_one(
            {"location.display_name": display_name},
        )
        if coverage:
            coverage.status = "canceled"
            coverage.last_error = "Task was canceled by user."
            await coverage.save()

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
