import asyncio
import json
import logging
import time  # Added for timing
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

import bson  # For bson.json_util
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.encoders import jsonable_encoder  # <--- ADDED THIS IMPORT
from fastapi.responses import JSONResponse, StreamingResponse
from gridfs import errors
from motor.motor_asyncio import AsyncIOMotorGridFSBucket
from shapely.geometry import shape

from coverage_tasks import (
    process_area,
    process_coverage_calculation,
    process_incremental_coverage_calculation,
)
from db import (
    aggregate_with_retry,
    batch_cursor,
    count_documents_with_retry,
    db_manager,
    delete_many_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    update_one_with_retry,
)
from models import (
    CustomBoundaryModel,
    DeleteCoverageAreaModel,
    LocationModel,
    ValidateCustomBoundaryModel,
)

logger = logging.getLogger(__name__)
router = APIRouter()

coverage_metadata_collection = db_manager.db["coverage_metadata"]
streets_collection = db_manager.db["streets"]
progress_collection = db_manager.db["progress_status"]
osm_data_collection = db_manager.db["osm_data"]


async def _recalculate_coverage_stats(
    location_id: ObjectId,
) -> dict | None:
    """Internal helper to recalculate stats for a coverage area based on
    streets_collection.
    """
    try:
        coverage_area = await find_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
            {"location.display_name": 1},
        )
        if not coverage_area or not coverage_area.get("location", {}).get(
            "display_name",
        ):
            logger.error(
                "Cannot recalculate stats: Coverage area %s or its "
                "display_name not found.",
                location_id,
            )
            return None

        location_name = coverage_area["location"]["display_name"]

        pipeline = [
            {"$match": {"properties.location": location_name}},
            {
                "$group": {
                    "_id": None,
                    "total_segments": {"$sum": 1},
                    "driveable_segments": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$properties.undriveable", True]},
                                0,
                                1,
                            ]
                        }
                    },
                    "total_length": {"$sum": "$properties.segment_length"},
                    "driveable_length": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$properties.undriveable", True]},
                                0,
                                "$properties.segment_length",
                            ]
                        }
                    },
                    "driven_length": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$properties.driven", True]},
                                "$properties.segment_length",
                                0,
                            ]
                        }
                    },
                    "street_types_data": {
                        "$push": {
                            "type": "$properties.highway",
                            "length": "$properties.segment_length",
                            "driven": "$properties.driven",
                            "undriveable": "$properties.undriveable",
                        },
                    },
                },
            },
        ]

        results = await aggregate_with_retry(streets_collection, pipeline)

        if not results:
            stats = {
                "total_length": 0.0,
                "driven_length": 0.0,
                "driveable_length": 0.0,
                "coverage_percentage": 0.0,
                "total_segments": 0,
                "street_types": [],
            }
        else:
            agg_result = results[0]
            total_length = agg_result.get("total_length", 0.0) or 0.0
            driven_length = agg_result.get("driven_length", 0.0) or 0.0
            driveable_length = agg_result.get("driveable_length", 0.0) or 0.0
            total_segments = agg_result.get("total_segments", 0) or 0
            driveable_segments = agg_result.get("driveable_segments", 0) or 0

            coverage_percentage = (
                (driven_length / driveable_length * 100)
                if driveable_length > 0
                else 0.0
            )

            street_types_summary = defaultdict(
                lambda: {
                    "length": 0.0,
                    "covered_length": 0.0,
                    "undriveable_length": 0.0,
                    "total": 0,
                    "covered": 0,
                },
            )
            for item in agg_result.get("street_types_data", []):
                stype = item.get("type", "unknown")
                length = item.get("length", 0.0) or 0.0
                is_driven = item.get("driven", False)
                is_undriveable = item.get("undriveable", False)

                street_types_summary[stype]["length"] += length
                street_types_summary[stype]["total"] += 1

                if is_undriveable:
                    street_types_summary[stype]["undriveable_length"] += length
                elif is_driven:
                    street_types_summary[stype]["covered_length"] += length
                    street_types_summary[stype]["covered"] += 1

            final_street_types = []
            for (
                stype,
                data,
            ) in street_types_summary.items():
                type_driveable_length = data["length"] - data["undriveable_length"]
                type_coverage_pct = (
                    (data["covered_length"] / type_driveable_length * 100)
                    if type_driveable_length > 0
                    else 0.0
                )
                final_street_types.append(
                    {
                        "type": stype,
                        "length": data["length"],
                        "covered_length": data["covered_length"],
                        "coverage_percentage": type_coverage_pct,
                        "total": data["total"],
                        "covered": data["covered"],
                        "undriveable_length": data["undriveable_length"],
                    },
                )
            final_street_types.sort(
                key=lambda x: x["length"],
                reverse=True,
            )

            stats = {
                "total_length": total_length,
                "driven_length": driven_length,
                "driveable_length": driveable_length,
                "total_segments": total_segments,
                "driveable_segments": driveable_segments,
                "coverage_percentage": coverage_percentage,
                "street_types": final_street_types,
            }

        update_result = await update_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
            {
                "$set": {
                    **stats,
                    "needs_stats_update": False,
                    "last_stats_update": datetime.now(UTC),
                    "last_modified": datetime.now(UTC),
                },
            },
        )

        if update_result.modified_count == 0:
            logger.warning(
                "Stats recalculated for %s, but metadata document was not "
                "modified (maybe no change or error?).",
                location_id,
            )
        else:
            logger.info(
                "Successfully recalculated and updated stats for %s.",
                location_id,
            )

        updated_coverage_area = await find_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
        )
        if updated_coverage_area:
            updated_coverage_area["_id"] = str(
                updated_coverage_area["_id"]
            )  # Ensure _id is string for JSON
            if "last_updated" in updated_coverage_area and isinstance(
                updated_coverage_area["last_updated"], datetime
            ):
                updated_coverage_area["last_updated"] = updated_coverage_area[
                    "last_updated"
                ].isoformat()
            if "last_stats_update" in updated_coverage_area and isinstance(
                updated_coverage_area["last_stats_update"], datetime
            ):
                updated_coverage_area["last_stats_update"] = updated_coverage_area[
                    "last_stats_update"
                ].isoformat()
            if "last_modified" in updated_coverage_area and isinstance(
                updated_coverage_area["last_modified"], datetime
            ):  # Explicitly convert last_modified
                updated_coverage_area["last_modified"] = updated_coverage_area[
                    "last_modified"
                ].isoformat()
            if "streets_geojson_gridfs_id" in updated_coverage_area and isinstance(
                updated_coverage_area["streets_geojson_gridfs_id"],
                ObjectId,
            ):  # Convert ObjectId to string
                updated_coverage_area["streets_geojson_gridfs_id"] = str(
                    updated_coverage_area["streets_geojson_gridfs_id"]
                )

            return updated_coverage_area

        # If find_one_with_retry returns None after update (should not happen
        # if update succeeded) or if we want to return the calculated stats
        # directly if the re-fetch fails for some reason.
        # Construct a basic response with the calculated stats.
        base_response = {
            **stats,
            "_id": str(location_id),
            "location": coverage_area.get("location", {}),  # from initial fetch
            "last_updated": datetime.now(UTC).isoformat(),
            "last_stats_update": datetime.now(UTC).isoformat(),
        }
        return base_response

    except Exception as e:
        logger.error(
            "Error recalculating stats for %s: %s",
            location_id,
            e,
            exc_info=True,
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"Stats recalc failed: {e}",
                },
            },
        )
        return None


@router.post("/api/street_coverage")
async def get_street_coverage(
    location: LocationModel,
):
    """Calculate street coverage for a location."""
    try:
        task_id = str(uuid.uuid4())
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
    if progress.get("stage") == "error":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=progress.get("error", "Unknown error"),
        )

    # Ensure datetime is serializable
    if "updated_at" in progress and isinstance(progress["updated_at"], datetime):
        progress["updated_at"] = progress["updated_at"].isoformat()

    return {
        "_id": str(progress.get("_id")),  # Ensure _id is string
        "stage": progress.get("stage", "unknown"),
        "progress": progress.get("progress", 0),
        "message": progress.get("message", ""),
        "error": progress.get("error"),
        "result": progress.get(
            "result"
        ),  # This might contain complex objects; ensure serializable if issues arise
        "metrics": progress.get("metrics", {}),
        "updated_at": progress.get("updated_at"),
        "location": progress.get("location"),
    }


@router.post("/api/street_coverage/incremental")
async def get_incremental_street_coverage(
    location: LocationModel,
):
    """Update street coverage incrementally, processing only new trips since
    last update.
    """
    try:
        task_id = str(uuid.uuid4())
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


@router.post("/api/preprocess_streets")
async def preprocess_streets_route(
    location_data: LocationModel,
):
    """Preprocess streets data for a validated location received in the request
    body.
    """
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
                    # Direct call, consider retry wrapper if needed
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


@router.get("/api/coverage_areas")
async def get_coverage_areas():
    """Get all coverage areas."""
    try:
        areas = await find_with_retry(coverage_metadata_collection, {})

        processed_areas = []
        for area in areas:
            processed_area = {
                "_id": str(area["_id"]),
                "location": area["location"],
                "total_length": area.get(
                    "total_length_m",
                    area.get("total_length", 0),
                ),
                "driven_length": area.get(
                    "driven_length_m",
                    area.get("driven_length", 0),
                ),
                "coverage_percentage": area.get("coverage_percentage", 0),
                "last_updated": area.get("last_updated"),
                "total_segments": area.get("total_segments", 0),
                "status": area.get("status", "completed"),
                "last_error": area.get("last_error"),
            }
            if isinstance(processed_area["last_updated"], datetime):
                processed_area["last_updated"] = processed_area[
                    "last_updated"
                ].isoformat()
            processed_areas.append(processed_area)

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


@router.post("/api/coverage_areas/delete")
async def delete_coverage_area(
    location: DeleteCoverageAreaModel,
):
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

        if gridfs_id := coverage_metadata.get("streets_geojson_gridfs_id"):
            try:
                fs = AsyncIOMotorGridFSBucket(db_manager.db)
                # Delete the specific referenced file first (backward compatibility)
                await fs.delete(gridfs_id)
                logger.info("Deleted GridFS file %s for %s", gridfs_id, display_name)
            except errors.NoFile:
                logger.warning(
                    "Referenced GridFS file %s not found for %s, continuing.",
                    gridfs_id,
                    display_name,
                )
            except Exception as gridfs_err:
                logger.warning(
                    "Error deleting referenced GridFS file for %s: %s",
                    display_name,
                    gridfs_err,
                )

            # Additionally, delete ANY GridFS files that were tagged with
            # this location name
            try:
                cursor = db_manager.db["fs.files"].find(
                    {"metadata.location": display_name}, {"_id": 1}
                )
                async for file_doc in cursor:
                    try:
                        await fs.delete(file_doc["_id"])
                        logger.info(
                            "Deleted extra GridFS file %s for %s",
                            file_doc["_id"],
                            display_name,
                        )
                    except errors.NoFile:
                        pass
            except Exception as extra_del_err:
                logger.warning(
                    "Error purging additional GridFS files for %s: %s",
                    display_name,
                    extra_del_err,
                )

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

        await delete_many_with_retry(
            streets_collection,
            {"properties.location": display_name},
        )
        logger.info("Deleted street segments for %s", display_name)

        _ = await delete_one_with_retry(
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
async def cancel_coverage_area(
    location: DeleteCoverageAreaModel,
):
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


@router.get("/api/coverage_areas/{location_id}")
async def get_coverage_area_details(location_id: str):
    """Get detailed information about a coverage area, fetching GeoJSON from GridFS."""
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
            "Coverage area %s (ID: %s) has malformed or missing 'location' "
            "data. Location data: %s. Full document: %s",
            location_id,
            obj_location_id,
            location_info,
            coverage_doc,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"Coverage area with ID '{location_id}' was found but "
                "contains incomplete or malformed internal location "
                "information. Please check data integrity."
            ),
        )

    last_updated_iso = None
    if isinstance(coverage_doc.get("last_updated"), datetime):
        last_updated_iso = coverage_doc["last_updated"].isoformat()
    elif coverage_doc.get("last_updated"):  # if it's already a string
        last_updated_iso = coverage_doc.get("last_updated")

    result = {
        "success": True,
        "coverage": {
            "_id": str(coverage_doc["_id"]),
            "location": location_info,
            "location_name": location_info.get("display_name"),
            "total_length": coverage_doc.get(
                "total_length_m",
                coverage_doc.get("total_length", 0),
            ),
            "driven_length": coverage_doc.get(
                "driven_length_m",
                coverage_doc.get("driven_length", 0),
            ),
            "coverage_percentage": coverage_doc.get("coverage_percentage", 0.0),
            "last_updated": last_updated_iso,
            "total_segments": coverage_doc.get("total_segments", 0),
            "streets_geojson_gridfs_id": (
                str(coverage_doc.get("streets_geojson_gridfs_id"))
                if coverage_doc.get("streets_geojson_gridfs_id")
                else None
            ),
            "street_types": coverage_doc.get("street_types", []),
            "status": coverage_doc.get("status", "completed"),
            "has_error": coverage_doc.get("status") == "error",
            "error_message": (
                coverage_doc.get("last_error")
                if coverage_doc.get("status") == "error"
                else None
            ),
            "needs_reprocessing": coverage_doc.get("needs_stats_update", False),
        },
    }
    overall_end_time = time.perf_counter()
    logger.info(
        "[%s] Total processing time for get_coverage_area_details: %.4fs.",
        location_id,
        overall_end_time - overall_start_time,
    )
    return JSONResponse(content=result)


@router.get("/api/coverage_areas/{location_id}/geojson/gridfs")
async def get_coverage_area_geojson_from_gridfs(location_id: str, response: Response):
    """Stream raw GeoJSON from GridFS for a given coverage area."""
    logger.info("[%s] Request received for GridFS GeoJSON stream.", location_id)
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    coverage_doc = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {
            "streets_geojson_gridfs_id": 1,
            "location.display_name": 1,
        },  # Only fetch needed fields
    )

    if not coverage_doc:
        logger.warning("[%s] Coverage area metadata not found for ID.", location_id)
        raise HTTPException(
            status_code=404,
            detail="Coverage area metadata not found",
        )

    gridfs_id = coverage_doc.get("streets_geojson_gridfs_id")
    location_name = coverage_doc.get("location", {}).get(
        "display_name", "UnknownLocation"
    )

    if (
        not gridfs_id
    ):  # No GridFS ID, fallback to direct streets and schedule regeneration
        logger.warning(
            "[%s] No streets_geojson_gridfs_id found for %s, falling back.",
            location_id,
            location_name,
        )
        # Trigger background regeneration of GridFS geojson
        asyncio.create_task(_regenerate_streets_geojson(obj_location_id))
        # Return streets directly
        streets_data = await get_coverage_area_streets(location_id)
        return JSONResponse(content=streets_data, media_type="application/json")

    # Ensure gridfs_id is an ObjectId if it's a string (it should be ObjectId from DB)
    if isinstance(gridfs_id, str):
        try:
            gridfs_id = ObjectId(gridfs_id)
        except Exception:
            logger.error("[%s] Invalid GridFS ID format: %s", location_id, gridfs_id)
            raise HTTPException(status_code=400, detail="Invalid GridFS ID format.")

    try:
        fs = AsyncIOMotorGridFSBucket(db_manager.db)
        # Correct way to check metadata using the bucket instance
        grid_out_file_metadata = await db_manager.db["fs.files"].find_one(
            {"_id": gridfs_id}
        )

        if not grid_out_file_metadata:
            logger.warning(
                "[%s] GridFS ID %s exists in metadata but file not found in GridFS, falling back.",
                location_id,
                gridfs_id,
            )
            # Trigger background regeneration of GridFS geojson
            asyncio.create_task(_regenerate_streets_geojson(obj_location_id))
            # Fallback to direct streets
            streets_data = await get_coverage_area_streets(location_id)
            return JSONResponse(content=streets_data, media_type="application/json")

        # Set headers for streaming
        response.headers["Content-Type"] = "application/json"
        response.headers["Content-Disposition"] = (
            f'attachment; filename="{location_name}_streets.geojson"'
        )
        if "length" in grid_out_file_metadata:
            response.headers["Content-Length"] = str(grid_out_file_metadata["length"])

        async def stream_geojson_data():
            grid_out_stream = None  # Initialize to None
            try:
                logger.debug(
                    "[%s] Attempting to open download stream for %s.",
                    location_id,
                    gridfs_id,
                )
                grid_out_stream = await fs.open_download_stream(gridfs_id)
                logger.info(
                    "[%s] Successfully opened download stream for %s. Type: %s",
                    location_id,
                    gridfs_id,
                    type(grid_out_stream),
                )

                if grid_out_stream is None:
                    # This case should ideally be covered by NoFile or other
                    # exceptions from Motor
                    logger.error(
                        "[%s] fs.open_download_stream unexpectedly returned None for %s.",
                        location_id,
                        gridfs_id,
                    )
                    return  # Ends the generator, resulting in an empty response body

                chunk_size = 8192
                while True:
                    logger.debug(
                        "[%s] Attempting to read chunk from stream for %s.",
                        location_id,
                        gridfs_id,
                    )
                    chunk = await grid_out_stream.read(chunk_size)
                    logger.debug(
                        "[%s] Read %d bytes for %s.",
                        location_id,
                        len(chunk),
                        gridfs_id,
                    )
                    if not chunk:  # End of file
                        logger.info(
                            "[%s] EOF reached for stream %s.",
                            location_id,
                            gridfs_id,
                        )
                        break
                    yield chunk

                logger.info(
                    "[%s] Finished reading and yielding all chunks for %s.",
                    location_id,
                    gridfs_id,
                )

            except errors.NoFile:
                logger.warning(
                    "[%s] NoFile error during GridFS streaming for %s.",
                    location_id,
                    gridfs_id,
                    exc_info=True,
                )
                # This exception will propagate to the outer try/except in the
                # route handler
                raise
            except Exception as e_stream:
                logger.error(
                    "[%s] Exception during GridFS stream processing for %s: %s",
                    location_id,
                    gridfs_id,
                    e_stream,
                    exc_info=True,
                )
                # This exception will propagate to the outer try/except in the
                # route handler
                raise
            finally:
                if grid_out_stream is not None:
                    logger.info(
                        "[%s] In finally block: Attempting to close stream for %s. Stream object: %s, Type: %s",
                        location_id,
                        gridfs_id,
                        grid_out_stream,
                        type(grid_out_stream),
                    )
                    try:
                        await (
                            grid_out_stream.close()
                        )  # This is where the original error occurred (line 826)
                        logger.info(
                            "[%s] Successfully closed GridFS stream %s for %s.",
                            location_id,
                            gridfs_id,
                            location_name,
                        )
                    except Exception as e_close:
                        logger.error(
                            "[%s] Error closing GridFS stream %s: %s",
                            location_id,
                            gridfs_id,
                            e_close,
                            exc_info=True,
                        )
                        # Depending on policy, you might want to raise this
                        # or just log it
                else:
                    logger.warning(
                        "[%s] In finally block: grid_out_stream was None for %s, cannot close. This indicates an issue with stream opening or an earlier error.",
                        location_id,
                        gridfs_id,
                    )

        return StreamingResponse(stream_geojson_data(), media_type="application/json")

    except errors.NoFile:  # GridFS file not found, fallback
        logger.warning(
            "[%s] NoFile error for GridFS ID %s, falling back.",
            location_id,
            gridfs_id,
            exc_info=True,
        )
        # Trigger background regeneration
        asyncio.create_task(_regenerate_streets_geojson(obj_location_id))
        # Fallback to direct streets
        streets_data = await get_coverage_area_streets(location_id)
        return JSONResponse(content=streets_data, media_type="application/json")
    except Exception as e:  # Catch other potential errors
        logger.error(
            "[%s] General error streaming GridFS file %s for %s: %s",
            location_id,
            gridfs_id,
            location_name,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"Error streaming GeoJSON data: {str(e)}"
        )


@router.get("/api/coverage_areas/{location_id}/streets")
async def get_coverage_area_streets(
    location_id: str, undriven: bool = Query(False), driven: bool = Query(False)
):
    """Get updated street GeoJSON for a coverage area, including manual overrides."""
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    meta = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {"location.display_name": 1},
    )
    if not meta:
        raise HTTPException(
            status_code=404,
            detail="Coverage area not found",
        )
    name = meta["location"]["display_name"]
    query = {"properties.location": name}
    if undriven:
        query["properties.driven"] = False
        query["properties.undriveable"] = {
            "$ne": True
        }  # Don't show undriveable streets
    elif driven:
        query["properties.driven"] = True
    # If neither undriven nor driven is specified, return all streets

    cursor = streets_collection.find(
        query,
        {
            "_id": 0,
            "geometry": 1,
            "properties.segment_id": 1,
            "properties.street_name": 1,
            "properties.highway": 1,
            "properties.segment_length": 1,
            "properties.driven": 1,
            "properties.undriveable": 1,
        },
    )
    features = await cursor.to_list(length=None)
    return {"type": "FeatureCollection", "features": features}


@router.get("/api/coverage_areas/{location_id}/streets/viewport")
async def get_coverage_area_streets_viewport(
    location_id: str,
    west: float = Query(..., description="Viewport min longitude"),
    south: float = Query(..., description="Viewport min latitude"),
    east: float = Query(..., description="Viewport max longitude"),
    north: float = Query(..., description="Viewport max latitude"),
    undriven: bool = Query(False),
    driven: bool = Query(False),
):
    """Return streets intersecting the current map viewport for the location.

    This significantly reduces payload size vs. sending entire city GeoJSON.
    """
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid location_id format")

    meta = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {"location.display_name": 1},
    )
    if not meta:
        raise HTTPException(status_code=404, detail="Coverage area not found")
    name = meta["location"]["display_name"]

    # Build viewport polygon
    viewport_poly = {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ]
        ],
    }

    query: dict[str, Any] = {
        "properties.location": name,
        "geometry": {"$geoIntersects": {"$geometry": viewport_poly}},
    }
    if undriven:
        query["properties.driven"] = False
        query["properties.undriveable"] = {"$ne": True}
    elif driven:
        query["properties.driven"] = True

    projection = {
        "_id": 0,
        "geometry": 1,
        "properties.segment_id": 1,
        "properties.street_name": 1,
        "properties.highway": 1,
        "properties.segment_length": 1,
        "properties.driven": 1,
        "properties.undriveable": 1,
    }

    cursor = streets_collection.find(query, projection).limit(5000)
    features = await cursor.to_list(length=5000)

    return {"type": "FeatureCollection", "features": features}


@router.post("/api/coverage_areas/{location_id}/refresh_stats")
async def refresh_coverage_stats(
    location_id: str,
):
    """Refresh statistics for a coverage area after manual street modifications."""
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

    updated_coverage_data = await _recalculate_coverage_stats(
        obj_location_id,
    )

    if updated_coverage_data is None:
        raise HTTPException(
            status_code=500,
            detail="Failed to recalculate statistics or coverage area not found.",
        )

    # Prepare the full content payload
    response_content = {
        "success": True,
        "coverage": updated_coverage_data,
    }

    # Explicitly encode the content to handle all types (like datetime)
    encoded_content = jsonable_encoder(response_content)

    # Schedule static GeoJSON regeneration in GridFS
    asyncio.create_task(_regenerate_streets_geojson(obj_location_id))

    return JSONResponse(content=encoded_content)


@router.post("/api/undriven_streets")
async def get_undriven_streets(
    location: LocationModel,
):
    """Get undriven streets for a specific location."""
    location_name = "UNKNOWN"
    try:
        location_name = location.display_name
        logger.info(
            "Request received for undriven streets for '%s'.",
            location_name,
        )

        coverage_metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
        )

        if not coverage_metadata:
            logger.warning(
                "No coverage metadata found for location: '%s'. Raising 404.",
                location_name,
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No coverage data found for location: {location_name}",
            )

        query = {
            "properties.location": location_name,
            "properties.driven": False,
        }

        count = await count_documents_with_retry(streets_collection, query)
        logger.info(
            "Found %d undriven street documents for '%s'.",
            count,
            location_name,
        )

        if count == 0:
            return JSONResponse(
                content={
                    "type": "FeatureCollection",
                    "features": [],
                },
            )

        features = []
        # Directly use the collection object from db_manager
        cursor = streets_collection.find(query)

        async for street_batch in batch_cursor(cursor):
            for street_doc in street_batch:
                if "geometry" in street_doc and "properties" in street_doc:
                    features.append(street_doc)

        content_to_return = {
            "type": "FeatureCollection",
            "features": features,
        }
        # bson.json_util.dumps handles MongoDB specific types like ObjectId, datetime
        return JSONResponse(
            content=json.loads(bson.json_util.dumps(content_to_return)),
        )

    except Exception as e:
        logger.error(
            "Unexpected error getting undriven streets for '%s': %s",
            location_name,
            str(e),
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error retrieving undriven streets.",
        )


async def _mark_segment(
    location_id_str: str,
    segment_id: str,
    updates: dict,
    action_name: str,
):
    """Helper function to mark a street segment."""
    if not location_id_str or not segment_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing location_id or segment_id",
        )

    try:
        obj_location_id = ObjectId(location_id_str)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid location_id format",
        )

    segment_doc = await find_one_with_retry(
        streets_collection,
        {"properties.segment_id": segment_id},
    )

    if not segment_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Street segment not found",
        )

    coverage_meta = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {"location.display_name": 1},
    )
    if not coverage_meta or not coverage_meta.get("location", {}).get("display_name"):
        # This case should ideally be caught if location_id is invalid,
        # but good to have a fallback if DB state is inconsistent.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage location metadata not found for the given ID.",
        )

    expected_location_name = coverage_meta["location"]["display_name"]
    segment_location_name = segment_doc.get("properties", {}).get("location")

    if segment_location_name != expected_location_name:
        logger.warning(
            "Segment %s (in location '%s') does not appear to belong to the "
            "target location '%s' (ID: %s). "
            "This might indicate a mismatch or data issue. Proceeding with "
            "update based on segment_id.",
            segment_id,
            segment_location_name,
            expected_location_name,
            location_id_str,
        )
        # The original code proceeded with a warning. If strict matching is
        # required, raise HTTPException here.

    update_payload = {f"properties.{key}": value for key, value in updates.items()}
    update_payload["properties.manual_override"] = True
    update_payload["properties.last_manual_update"] = datetime.now(
        UTC,
    )

    result = await update_one_with_retry(
        streets_collection,
        {"_id": segment_doc["_id"]},  # Use the actual _id of the segment document
        {"$set": update_payload},
    )

    if (
        result.modified_count == 0 and result.matched_count > 0
    ):  # Matched but not modified
        logger.info(
            "Segment %s already had the desired state for action '%s'. "
            "No DB change made.",
            segment_id,
            action_name,
        )
    elif result.matched_count == 0:
        logger.warning(
            "Segment %s with _id %s not found during update for action '%s'. "
            "This is unexpected.",
            segment_id,
            segment_doc["_id"],
            action_name,
        )

    await update_one_with_retry(
        coverage_metadata_collection,
        {"_id": obj_location_id},
        {
            "$set": {
                "needs_stats_update": True,
                "last_modified": datetime.now(UTC),
            },
        },
    )

    # Recalculate stats & regenerate GeoJSON asynchronously (don't block response)
    try:
        await _recalculate_coverage_stats(obj_location_id)
        await _regenerate_streets_geojson(obj_location_id)
    except Exception as bg_err:
        logger.warning(
            "Post-mark background update failed for %s: %s",
            expected_location_name,
            bg_err,
        )

    return {
        "success": True,
        "message": f"Segment marked as {action_name}",
    }


@router.post("/api/street_segments/mark_driven")
async def mark_street_segment_as_driven(
    request: Request,
):
    """Mark a street segment as manually driven."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "driven": True,
            "undriveable": False,
            # Explicitly set undriveable to false if marking as driven
            "manually_marked_driven": True,
            "manually_marked_undriven": False,
            "manually_marked_undriveable": False,
            "manually_marked_driveable": False,  # Reset other manual flags
        }
        return await _mark_segment(
            location_id,
            segment_id,
            updates,
            "driven",
        )
    except Exception as e:
        logger.error(
            "Error marking street segment as driven: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.post("/api/street_segments/mark_undriven")
async def mark_street_segment_as_undriven(
    request: Request,
):
    """Mark a street segment as manually undriven (not driven)."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "driven": False,
            "manually_marked_undriven": True,
            "manually_marked_driven": False,
            # Does not change 'undriveable' status by itself
        }
        return await _mark_segment(
            location_id,
            segment_id,
            updates,
            "undriven",
        )
    except Exception as e:
        logger.error(
            "Error marking street segment as undriven: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.post("/api/street_segments/mark_undriveable")
async def mark_street_segment_as_undriveable(
    request: Request,
):
    """Mark a street segment as undriveable (cannot be driven)."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "undriveable": True,
            "driven": False,  # If undriveable, it cannot be driven
            "manually_marked_undriveable": True,
            "manually_marked_driveable": False,
            "manually_marked_driven": False,  # Reset other manual flags
            "manually_marked_undriven": False,
        }
        return await _mark_segment(
            location_id,
            segment_id,
            updates,
            "undriveable",
        )
    except Exception as e:
        logger.error(
            "Error marking street segment as undriveable: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.post("/api/street_segments/mark_driveable")
async def mark_street_segment_as_driveable(
    request: Request,
):
    """Mark a street segment as driveable (removing undriveable status)."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "undriveable": False,
            "manually_marked_driveable": True,
            "manually_marked_undriveable": False,
            # Does not change 'driven' status by itself
        }
        return await _mark_segment(
            location_id,
            segment_id,
            updates,
            "driveable",
        )
    except Exception as e:
        logger.error(
            "Error marking street segment as driveable: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/api/street_segment/{segment_id}")
async def get_street_segment_details(
    segment_id: str,
):
    """Get details for a specific street segment."""
    try:
        # The projection {"_id": 0} ensures the MongoDB internal _id is not returned.
        segment = await find_one_with_retry(
            streets_collection,
            {"properties.segment_id": segment_id},
            projection={"_id": 0},
        )
        if not segment:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Segment not found",
            )
        return segment  # FastAPI will automatically convert to JSONResponse
    except Exception as e:
        logger.exception(
            "Error fetching segment details for segment_id %s: %s",
            segment_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error fetching segment details: {str(e)}",
        )


async def _regenerate_streets_geojson(location_id: ObjectId):
    """Helper to regenerate and store streets GeoJSON in GridFS."""
    coverage_doc = await find_one_with_retry(
        coverage_metadata_collection,
        {"_id": location_id},
        {"location.display_name": 1, "streets_geojson_gridfs_id": 1},
    )
    if not coverage_doc or not coverage_doc.get("location", {}).get("display_name"):
        logger.warning(
            "Cannot regenerate GeoJSON: missing coverage metadata for %s",
            location_id,
        )
        return
    location_name = coverage_doc["location"]["display_name"]
    # Stream and clean features to include only minimal properties for performance
    raw_features = await streets_collection.find(
        {"properties.location": location_name},
        {
            "_id": 0,
            "geometry": 1,
            "properties.segment_id": 1,
            "properties.street_name": 1,
            "properties.highway": 1,
            "properties.segment_length": 1,
            "properties.driven": 1,
            "properties.undriveable": 1,
        },
    ).to_list(length=None)
    # Build a clean GeoJSON without extra metadata
    clean_features = []
    for f in raw_features:
        props = f.get("properties", {})
        clean_props = {
            "segment_id": props.get("segment_id"),
            "street_name": props.get("street_name"),
            "highway": props.get("highway"),
            "segment_length": props.get("segment_length"),
            "driven": props.get("driven"),
            "undriveable": props.get("undriveable"),
        }
        clean_features.append(
            {
                "type": "Feature",
                "geometry": f.get("geometry"),
                "properties": clean_props,
            }
        )
    geojson = {"type": "FeatureCollection", "features": clean_features}
    bucket = AsyncIOMotorGridFSBucket(db_manager.db)
    # Delete old GridFS file if present
    old_id = coverage_doc.get("streets_geojson_gridfs_id")
    if isinstance(old_id, ObjectId):
        try:
            await bucket.delete(old_id)
            logger.info("Deleted old GridFS geojson %s for %s", old_id, location_name)
        except Exception as e:
            logger.warning("Error deleting old GridFS file %s: %s", old_id, e)
    # Serialize using FastAPI encoder to handle datetime conversion
    safe_geojson = jsonable_encoder(geojson)
    data_bytes = json.dumps(safe_geojson).encode("utf-8")
    new_id = await bucket.upload_from_stream(
        f"{location_name}_streets.geojson", data_bytes
    )
    await update_one_with_retry(
        coverage_metadata_collection,
        {"_id": location_id},
        {"$set": {"streets_geojson_gridfs_id": new_id}},
    )
    logger.info("Regenerated GridFS geojson %s for %s", new_id, location_name)


# Helper function to compute bounding box (south, north, west, east)


def _bbox_from_geometry(geom: dict) -> list[float]:
    """Return bounding box [min_lat, max_lat, min_lon, max_lon] from GeoJSON
    geometry."""
    try:
        geom_shape = shape(geom)
        minx, miny, maxx, maxy = (
            geom_shape.bounds
        )  # (min_lon, min_lat, max_lon, max_lat)
        return [miny, maxy, minx, maxx]
    except Exception as e:
        logger.error("Failed to compute bbox from geometry: %s", e)
        raise HTTPException(
            status_code=400, detail="Invalid geometry for bounding box computation"
        )


@router.post("/api/validate_custom_boundary")
async def validate_custom_boundary(data: ValidateCustomBoundaryModel):
    """Validate a custom drawn boundary polygon sent from the frontend.

    The endpoint ensures the geometry is a valid Polygon/MultiPolygon and
    returns basic statistics so the frontend can provide feedback.
    """
    area_name = data.area_name.strip()
    if not area_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="area_name must not be empty",
        )

    geometry = data.geometry
    try:
        geom_shape = shape(geometry)
        if geom_shape.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError("Geometry must be Polygon or MultiPolygon")
        if geom_shape.is_empty:
            raise ValueError("Geometry is empty")
        # Attempt to fix invalid geometries
        if not geom_shape.is_valid:
            geom_shape = geom_shape.buffer(0)
        if geom_shape.is_empty or not geom_shape.is_valid:
            raise ValueError("Invalid geometry (self-intersection or zero area)")

        # Stats
        if geom_shape.geom_type == "Polygon":
            total_points = len(geom_shape.exterior.coords)
            rings = 1 + len(geom_shape.interiors)
        else:  # MultiPolygon
            total_points = sum(len(poly.exterior.coords) for poly in geom_shape.geoms)
            rings = sum(1 + len(poly.interiors) for poly in geom_shape.geoms)

        display_name = area_name  # For custom areas we use the given name directly

        return {
            "valid": True,
            "display_name": display_name,
            "area_name": area_name,
            "geometry": geometry,
            "stats": {
                "total_points": total_points,
                "rings": rings,
            },
        }
    except Exception as e:
        logger.error("Custom boundary validation failed: %s", e)
        return JSONResponse(status_code=400, content={"valid": False, "detail": str(e)})


@router.post("/api/preprocess_custom_boundary")
async def preprocess_custom_boundary(data: CustomBoundaryModel):
    """Kick off preprocessing for a custom drawn boundary.

    This creates/updates a coverage area record and schedules a background task
    that fetches streets inside the provided geometry and calculates coverage.
    """
    display_name = data.display_name or data.area_name
    if not display_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="display_name (or area_name) required",
        )

    # Build location-like dict compatible with existing preprocessing pipeline
    geom_dict = data.geometry
    bbox = _bbox_from_geometry(geom_dict)

    location_dict: dict[str, Any] = {
        "display_name": display_name,
        "osm_id": 0,  # 0 indicates custom
        "osm_type": "custom",
        "boundingbox": bbox,  # [min_lat, max_lat, min_lon, max_lon]
        "lat": shape(geom_dict).centroid.y,
        "lon": shape(geom_dict).centroid.x,
        "geojson": geom_dict,
        "boundary_type": "custom",
        "segment_length_meters": data.segment_length_meters,
        "match_buffer_meters": data.match_buffer_meters,
        "min_match_length_meters": data.min_match_length_meters,
    }

    # Check if already being processed
    existing = await find_one_with_retry(
        coverage_metadata_collection,
        {"location.display_name": display_name},
    )
    if existing and existing.get("status") == "processing":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This area is already being processed",
        )

    # Upsert metadata placeholder
    await update_one_with_retry(
        coverage_metadata_collection,
        {"location.display_name": display_name},
        {
            "$set": {
                "location": location_dict,
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

    # Kick off async processing task
    task_id = str(uuid.uuid4())
    asyncio.create_task(
        process_area(location_dict, task_id, data.segment_length_meters)
    )

    return {
        "status": "success",
        "task_id": task_id,
    }
