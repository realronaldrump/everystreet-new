"""Geo data export route handlers (streets, boundaries)."""

import json
import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from export_helpers import create_export_response, get_location_filename
from osm_utils import generate_geojson_osm

logger = logging.getLogger(__name__)
router = APIRouter()


async def _export_geo_data(
    location: str,
    fmt: str,
    *,
    streets_only: bool,
    filename_prefix: str,
):
    try:
        loc = json.loads(location)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid location JSON",
        )

    data, error = await generate_geojson_osm(loc, streets_only=streets_only)

    if not data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=error or "No data available",
        )

    location_name = get_location_filename(loc)
    filename_base = f"{filename_prefix}_{location_name}"

    return await create_export_response(data, fmt, filename_base)


async def _run_export(action, error_message: str):
    try:
        return await action()
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception(error_message, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/streets")
async def export_streets(
    location: Annotated[str, Query(description="Location data in JSON format")],
    fmt: Annotated[str, Query(description="Export format")] = "geojson",
):
    """Export streets data for a location."""
    return await _run_export(
        lambda: _export_geo_data(
            location,
            fmt,
            streets_only=True,
            filename_prefix="streets",
        ),
        "Error exporting streets data: %s",
    )


@router.get("/api/export/boundary")
async def export_boundary(
    location: Annotated[str, Query(description="Location data in JSON format")],
    fmt: Annotated[str, Query(description="Export format")] = "geojson",
):
    """Export boundary data for a location."""
    return await _run_export(
        lambda: _export_geo_data(
            location,
            fmt,
            streets_only=False,
            filename_prefix="boundary",
        ),
        "Error exporting boundary data: %s",
    )
