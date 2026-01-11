"""Route handlers for custom boundary operations.

Handles validation and preprocessing of custom drawn boundaries.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from shapely.geometry import shape

from coverage.location_settings import normalize_location_settings
from coverage.services import geometry_service
from coverage_tasks import process_area
from db import CoverageMetadata, ProgressStatus
from models import CustomBoundaryModel, ValidateCustomBoundaryModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/validate_custom_boundary")
async def validate_custom_boundary(data: ValidateCustomBoundaryModel):
    """Validate a custom drawn boundary polygon.

    Ensures the geometry is a valid Polygon/MultiPolygon and returns
    basic statistics for frontend feedback.
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

        display_name = area_name

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

    Creates/updates a coverage area record and schedules a background task
    that fetches streets inside the provided geometry and calculates coverage.
    """
    display_name = data.display_name or data.area_name
    if not display_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="display_name (or area_name) required",
        )

    geom_dict = data.geometry
    bbox = geometry_service.bbox_from_geometry(geom_dict)

    location_dict: dict[str, Any] = {
        "display_name": display_name,
        "osm_id": 0,
        "osm_type": "custom",
        "boundingbox": bbox,
        "lat": shape(geom_dict).centroid.y,
        "lon": shape(geom_dict).centroid.x,
        "geojson": {"type": "Feature", "geometry": geom_dict, "properties": {}},
        "boundary_type": "custom",
        "segment_length_feet": data.segment_length_feet,
        "segment_length_meters": data.segment_length_meters,
        "match_buffer_feet": data.match_buffer_feet,
        "match_buffer_meters": data.match_buffer_meters,
        "min_match_length_feet": data.min_match_length_feet,
        "min_match_length_meters": data.min_match_length_meters,
    }
    location_dict = normalize_location_settings(location_dict)

    existing = await CoverageMetadata.find_one({"location.display_name": display_name})
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

    # Upsert coverage metadata using Beanie
    if existing:
        existing.location = location_dict
        existing.status = "processing"
        existing.last_error = None
        existing.last_updated = datetime.now(UTC)
        existing.total_length_miles = 0
        existing.driven_length_miles = 0
        existing.coverage_percentage = 0
        existing.total_streets = 0
        await existing.save()
    else:
        coverage = CoverageMetadata(
            location=location_dict,
            status="processing",
            last_updated=datetime.now(UTC),
            total_length_miles=0,
            driven_length_miles=0,
            coverage_percentage=0,
            total_streets=0,
        )
        await coverage.insert()

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

    asyncio.create_task(process_area(location_dict, task_id))

    return {
        "status": "success",
        "task_id": task_id,
    }
