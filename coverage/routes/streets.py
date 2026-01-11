"""
Route handlers for street segment operations.

Handles fetching streets, marking segments, and street-related queries.
"""

import logging
from typing import Annotated, Any

from beanie import PydanticObjectId
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from gridfs import errors

from coverage.gridfs_service import gridfs_service
from coverage.services import segment_marking_service
from db import CoverageMetadata, Street
from db.schemas import LocationModel

logger = logging.getLogger(__name__)
router = APIRouter()


def sanitize_features(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ensure features are JSON serializable by converting ObjectIds to strings."""
    for feature in features:
        if "properties" in feature:
            props = feature["properties"]
            for key, value in props.items():
                if isinstance(value, ObjectId):
                    props[key] = str(value)
        if "id" in feature and isinstance(feature["id"], ObjectId):
            feature["id"] = str(feature["id"])
    return features


@router.get("/api/coverage_areas/{location_id}/geojson/gridfs")
async def get_coverage_area_geojson_from_gridfs(
    location_id: PydanticObjectId,
    response: Response,
):
    """Stream raw GeoJSON from GridFS for a given coverage area."""
    logger.info("[%s] Request received for GridFS GeoJSON stream.", location_id)

    coverage_doc = await CoverageMetadata.get(location_id)

    if not coverage_doc:
        logger.warning("[%s] Coverage area metadata not found for ID.", location_id)
        raise HTTPException(
            status_code=404,
            detail="Coverage area metadata not found",
        )

    gridfs_id = coverage_doc.streets_geojson_id
    location_name = (
        coverage_doc.location.get("display_name", "UnknownLocation")
        if coverage_doc.location
        else "UnknownLocation"
    )

    if not gridfs_id:
        logger.warning(
            "[%s] No streets_geojson_gridfs_id found for %s, falling back.",
            location_id,
            location_name,
        )
        import asyncio

        asyncio.create_task(gridfs_service.regenerate_streets_geojson(location_id))
        streets_data = await get_coverage_area_streets(location_id)
        return JSONResponse(content=streets_data, media_type="application/json")

    # GridFS needs ObjectId for its API
    if isinstance(gridfs_id, str):
        try:
            gridfs_id = ObjectId(gridfs_id)
        except Exception:
            logger.exception(
                "[%s] Invalid GridFS ID format: %s",
                location_id,
                gridfs_id,
            )
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

            asyncio.create_task(gridfs_service.regenerate_streets_geojson(location_id))
            streets_data = await get_coverage_area_streets(location_id)
            return JSONResponse(content=streets_data, media_type="application/json")

        response.headers["Content-Type"] = "application/json"
        response.headers["Content-Disposition"] = (
            f'attachment; filename="{location_name}_streets.geojson"'
        )
        if "length" in grid_out_file_metadata:
            response.headers["Content-Length"] = str(grid_out_file_metadata["length"])

        async def stream_geojson_data():
            async for chunk in gridfs_service.stream_geojson(
                gridfs_id,
                str(location_id),
            ):
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

        asyncio.create_task(gridfs_service.regenerate_streets_geojson(location_id))
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
            status_code=500,
            detail=f"Error streaming GeoJSON data: {e!s}",
        )


@router.get("/api/coverage_areas/{location_id}/streets")
async def get_coverage_area_streets(
    location_id: PydanticObjectId,
    undriven: Annotated[bool, Query()] = False,
    driven: Annotated[bool, Query()] = False,
):
    """Get updated street GeoJSON for a coverage area."""
    meta = await CoverageMetadata.get(location_id)
    if not meta:
        raise HTTPException(
            status_code=404,
            detail="Coverage area not found",
        )
    name = meta.location.get("display_name") if meta.location else None
    if not name:
        raise HTTPException(status_code=500, detail="Coverage area has no display name")

    query: dict[str, Any] = {"properties.location": name}
    if undriven:
        query["properties.driven"] = False
        query["properties.undriveable"] = {"$ne": True}
    elif driven:
        query["properties.driven"] = True

    # Beanie doesn't support dict projections - fetch full docs and map to dicts
    features_list = await Street.find(query).to_list()
    features = [
        {"geometry": f.geometry, "properties": f.properties} for f in features_list
    ]

    features = sanitize_features(features)
    return {"type": "FeatureCollection", "features": features}


@router.get("/api/coverage_areas/{location_id}/streets/viewport")
async def get_coverage_area_streets_viewport(
    location_id: PydanticObjectId,
    west: Annotated[float, Query(description="Viewport min longitude")],
    south: Annotated[float, Query(description="Viewport min latitude")],
    east: Annotated[float, Query(description="Viewport max longitude")],
    north: Annotated[float, Query(description="Viewport max latitude")],
    undriven: Annotated[bool, Query()] = False,
    driven: Annotated[bool, Query()] = False,
):
    """Return streets intersecting the current map viewport."""
    meta = await CoverageMetadata.get(location_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Coverage area not found")
    name = meta.location.get("display_name") if meta.location else None
    if not name:
        raise HTTPException(status_code=500, detail="Coverage area has no display name")

    viewport_poly = {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ],
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

    # Use Beanie find with limit
    # For geoIntersects, Beanie supports passing the query dict directly
    features_list = await Street.find(query).limit(5000).to_list()

    # Map to dict structure expected by sanitize_features
    features = [
        {"geometry": f.geometry, "properties": f.properties} for f in features_list
    ]
    features = sanitize_features(features)
    return {"type": "FeatureCollection", "features": features}


@router.post("/api/undriven_streets")
async def get_undriven_streets(location: LocationModel):
    """Get undriven streets for a specific location."""
    location_name = "UNKNOWN"
    try:
        location_name = location.display_name
        logger.info(
            "Request received for undriven streets for '%s'.",
            location_name,
        )

        coverage_metadata = await CoverageMetadata.find_one(
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

        count = await Street.find(query).count()
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
        # Use Beanie iteration
        async for street in Street.find(query):
            features.append(street.model_dump(include={"geometry", "properties"}))

        content_to_return = {
            "type": "FeatureCollection",
            "features": features,
        }
        # Direct JSON return, assuming types are serializable (Beanie models usually are)
        return JSONResponse(content=content_to_return)

    except HTTPException:
        raise
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
        segment = await Street.find_one({"properties.segment_id": segment_id})
        if not segment:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Segment not found",
            )
        # Return as dict without _id
        return segment.model_dump(exclude={"id"})
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "Error fetching segment details for segment_id %s: %s",
            segment_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error fetching segment details: {e!s}",
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
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
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
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
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
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
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
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
