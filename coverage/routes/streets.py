"""Route handlers for street segment operations.

Handles fetching streets, marking segments, and street-related queries.
"""

import json
import logging
from typing import Any

import bson
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from gridfs import errors

from coverage.gridfs_service import gridfs_service
from coverage.serializers import sanitize_features
from coverage.services import segment_marking_service
from db import (
    batch_cursor,
    count_documents_with_retry,
    db_manager,
    find_one_with_retry,
    find_with_retry,
)

logger = logging.getLogger(__name__)
router = APIRouter()

coverage_metadata_collection = db_manager.db["coverage_metadata"]
streets_collection = db_manager.db["streets"]


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
        },
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

    if not gridfs_id:
        logger.warning(
            "[%s] No streets_geojson_gridfs_id found for %s, falling back.",
            location_id,
            location_name,
        )
        import asyncio

        asyncio.create_task(gridfs_service.regenerate_streets_geojson(obj_location_id))
        streets_data = await get_coverage_area_streets(location_id)
        return JSONResponse(content=streets_data, media_type="application/json")

    if isinstance(gridfs_id, str):
        try:
            gridfs_id = ObjectId(gridfs_id)
        except Exception:
            logger.error("[%s] Invalid GridFS ID format: %s", location_id, gridfs_id)
            raise HTTPException(status_code=400, detail="Invalid GridFS ID format.")

    try:
        grid_out_file_metadata = await gridfs_service.get_file_metadata(gridfs_id)

        if not grid_out_file_metadata:
            logger.warning(
                "[%s] GridFS ID %s exists in metadata but file not found.",
                location_id,
                gridfs_id,
            )
            import asyncio

            asyncio.create_task(
                gridfs_service.regenerate_streets_geojson(obj_location_id)
            )
            streets_data = await get_coverage_area_streets(location_id)
            return JSONResponse(content=streets_data, media_type="application/json")

        response.headers["Content-Type"] = "application/json"
        response.headers["Content-Disposition"] = (
            f'attachment; filename="{location_name}_streets.geojson"'
        )
        if "length" in grid_out_file_metadata:
            response.headers["Content-Length"] = str(grid_out_file_metadata["length"])

        async def stream_geojson_data():
            async for chunk in gridfs_service.stream_geojson(gridfs_id, location_id):
                yield chunk

        return StreamingResponse(stream_geojson_data(), media_type="application/json")

    except errors.NoFile:
        logger.warning(
            "[%s] NoFile error for GridFS ID %s, falling back.",
            location_id,
            gridfs_id,
            exc_info=True,
        )
        import asyncio

        asyncio.create_task(gridfs_service.regenerate_streets_geojson(obj_location_id))
        streets_data = await get_coverage_area_streets(location_id)
        return JSONResponse(content=streets_data, media_type="application/json")
    except Exception as e:
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
    """Get updated street GeoJSON for a coverage area."""
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
        query["properties.undriveable"] = {"$ne": True}
    elif driven:
        query["properties.driven"] = True

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
    features = sanitize_features(features)
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
    """Return streets intersecting the current map viewport."""
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
    features = sanitize_features(features)
    return {"type": "FeatureCollection", "features": features}


@router.post("/api/undriven_streets")
async def get_undriven_streets(location):
    """Get undriven streets for a specific location."""
    from models import LocationModel

    if not isinstance(location, LocationModel):
        location = LocationModel(**location)

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
        cursor = streets_collection.find(query)

        async for street_batch in batch_cursor(cursor):
            for street_doc in street_batch:
                if "geometry" in street_doc and "properties" in street_doc:
                    features.append(street_doc)

        content_to_return = {
            "type": "FeatureCollection",
            "features": features,
        }
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


@router.get("/api/street_segment/{segment_id}")
async def get_street_segment_details(segment_id: str):
    """Get details for a specific street segment."""
    try:
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
        return segment
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


@router.post("/api/street_segments/mark_driven")
async def mark_street_segment_as_driven(request: Request):
    """Mark a street segment as manually driven."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "driven": True,
            "undriveable": False,
            "manually_marked_driven": True,
            "manually_marked_undriven": False,
            "manually_marked_undriveable": False,
            "manually_marked_driveable": False,
        }
        return await segment_marking_service.mark_segment(
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
async def mark_street_segment_as_undriven(request: Request):
    """Mark a street segment as manually undriven."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "driven": False,
            "manually_marked_undriven": True,
            "manually_marked_driven": False,
        }
        return await segment_marking_service.mark_segment(
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
async def mark_street_segment_as_undriveable(request: Request):
    """Mark a street segment as undriveable."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "undriveable": True,
            "driven": False,
            "manually_marked_undriveable": True,
            "manually_marked_driveable": False,
            "manually_marked_driven": False,
            "manually_marked_undriven": False,
        }
        return await segment_marking_service.mark_segment(
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
async def mark_street_segment_as_driveable(request: Request):
    """Mark a street segment as driveable."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "undriveable": False,
            "manually_marked_driveable": True,
            "manually_marked_undriveable": False,
        }
        return await segment_marking_service.mark_segment(
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
