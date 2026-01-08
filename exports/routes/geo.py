"""Geo data export route handlers (streets, boundaries)."""

import json
import logging

from fastapi import APIRouter, HTTPException, Query, status

from export_helpers import create_export_response, get_location_filename
from osm_utils import generate_geojson_osm

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/export/streets")
async def export_streets(
    location: str = Query(..., description="Location data in JSON format"),
    fmt: str = Query("geojson", description="Export format"),
):
    """Export streets data for a location."""
    try:
        try:
            loc = json.loads(location)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location JSON",
            )

        data, error = await generate_geojson_osm(loc, streets_only=True)

        if not data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=error or "No street data available",
            )

        location_name = get_location_filename(loc)
        filename_base = f"streets_{location_name}"

        return await create_export_response(data, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error exporting streets data: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/boundary")
async def export_boundary(
    location: str = Query(..., description="Location data in JSON format"),
    fmt: str = Query("geojson", description="Export format"),
):
    """Export boundary data for a location."""
    try:
        try:
            loc = json.loads(location)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location JSON",
            )

        data, error = await generate_geojson_osm(loc, streets_only=False)

        if not data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=error or "No boundary data available",
            )

        location_name = get_location_filename(loc)
        filename_base = f"boundary_{location_name}"

        return await create_export_response(data, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error exporting boundary data: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
