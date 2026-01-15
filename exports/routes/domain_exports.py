"""
Domain-aligned export endpoints for coverage data.

This module provides clean export endpoints that properly use the app's
domain models (Street, CoverageArea, CoverageState) instead of legacy
on-demand OSM fetching.

Endpoints:
- GET /api/export/streets/{area_id} - Export streets with coverage status
- GET /api/export/boundaries/{area_id} - Export area boundary
- GET /api/export/undriven-streets/{area_id} - Export undriven streets only
"""

import csv
import json
import logging
from collections.abc import AsyncIterator
from io import StringIO
from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from coverage.models import CoverageArea, CoverageState, Street

logger = logging.getLogger(__name__)
router = APIRouter()


# =============================================================================
# Streaming Helpers
# =============================================================================


async def stream_geojson_features(features: list[dict]) -> AsyncIterator[str]:
    """Stream GeoJSON FeatureCollection from a list of features."""
    yield '{"type":"FeatureCollection","features":['
    first = True
    for feature in features:
        if not first:
            yield ","
        yield json.dumps(feature, separators=(",", ":"), default=str)
        first = False
    yield "]}"


async def stream_csv_features(features: list[dict], fieldnames: list[str]) -> AsyncIterator[str]:
    """Stream CSV data from features."""
    buf = StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")

    # Write header
    writer.writeheader()
    yield buf.getvalue()
    buf.seek(0)
    buf.truncate(0)

    # Write rows
    for feature in features:
        props = feature.get("properties", {})
        # Flatten geometry for CSV if needed
        geom = feature.get("geometry", {})
        if geom:
            props["geometry_type"] = geom.get("type")
            props["geometry_json"] = json.dumps(geom, separators=(",", ":"))

        writer.writerow(props)
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)


def create_streaming_response(
    generator: AsyncIterator[str],
    media_type: str,
    filename: str,
) -> StreamingResponse:
    """Create a StreamingResponse with proper headers."""
    return StreamingResponse(
        generator,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-cache",
        },
    )


# =============================================================================
# Data Assembly Functions
# =============================================================================


async def get_street_features_with_status(
    area_id: PydanticObjectId,
    area_version: int,
    status_filter: str | None = None,
) -> list[dict]:
    """
    Build GeoJSON features for streets with coverage status.

    Args:
        area_id: Coverage area ID
        area_version: Area version to query
        status_filter: Optional status filter (driven, undriven, undriveable)

    Returns:
        List of GeoJSON Feature dicts
    """
    # Get all streets for this area version
    streets = await Street.find({
        "area_id": area_id,
        "area_version": area_version,
    }).to_list()

    if not streets:
        return []

    # Get all coverage states for this area
    segment_ids = [s.segment_id for s in streets]
    states = await CoverageState.find({
        "area_id": area_id,
        "segment_id": {"$in": segment_ids},
    }).to_list()

    # Build lookup map
    state_map = {s.segment_id: s for s in states}

    # Build features
    features = []
    for street in streets:
        state = state_map.get(street.segment_id)
        state_status = state.status if state else "undriven"

        # Apply filter if specified
        if status_filter and state_status != status_filter:
            continue

        feature = {
            "type": "Feature",
            "geometry": street.geometry,
            "properties": {
                "segment_id": street.segment_id,
                "street_name": street.street_name,
                "highway_type": street.highway_type,
                "length_miles": street.length_miles,
                "osm_id": street.osm_id,
                "status": state_status,
                "first_driven_at": state.first_driven_at.isoformat() if state and state.first_driven_at else None,
                "last_driven_at": state.last_driven_at.isoformat() if state and state.last_driven_at else None,
                "manually_marked": state.manually_marked if state else False,
            },
        }
        features.append(feature)

    return features


async def get_undriven_street_features(
    area_id: PydanticObjectId,
    area_version: int,
) -> list[dict]:
    """
    Build GeoJSON features for undriven streets only.

    This is optimized for the common "what haven't I driven yet?" use case.
    """
    # Get undriven states
    undriven_states = await CoverageState.find({
        "area_id": area_id,
        "status": "undriven",
    }).to_list()

    if not undriven_states:
        return []

    # Get corresponding streets
    segment_ids = [s.segment_id for s in undriven_states]
    streets = await Street.find({
        "area_id": area_id,
        "area_version": area_version,
        "segment_id": {"$in": segment_ids},
    }).to_list()

    # Build features
    features = []
    for street in streets:
        feature = {
            "type": "Feature",
            "geometry": street.geometry,
            "properties": {
                "segment_id": street.segment_id,
                "street_name": street.street_name,
                "highway_type": street.highway_type,
                "length_miles": street.length_miles,
                "osm_id": street.osm_id,
                "status": "undriven",
            },
        }
        features.append(feature)

    return features


def get_boundary_feature(area: CoverageArea) -> dict:
    """
    Build GeoJSON feature for area boundary.

    Args:
        area: CoverageArea document

    Returns:
        GeoJSON Feature dict
    """
    return {
        "type": "Feature",
        "geometry": area.boundary,
        "properties": {
            "area_id": str(area.id),
            "display_name": area.display_name,
            "area_type": area.area_type,
            "total_length_miles": area.total_length_miles,
            "driven_length_miles": area.driven_length_miles,
            "coverage_percentage": area.coverage_percentage,
            "total_segments": area.total_segments,
            "driven_segments": area.driven_segments,
            "status": area.status,
            "created_at": area.created_at.isoformat(),
        },
    }


# =============================================================================
# Route Handlers
# =============================================================================


@router.get("/api/export/streets/{area_id}")
async def export_streets(
    area_id: PydanticObjectId,
    fmt: Annotated[str, Query(description="Export format (geojson or csv)")] = "geojson",
    status_filter: Annotated[
        str | None,
        Query(description="Filter by status: driven, undriven, or undriveable"),
    ] = None,
):
    """
    Export all streets for a coverage area.

    Returns streets with their current coverage status (driven/undriven/undriveable).
    Supports filtering by status and export to GeoJSON or CSV formats.

    Example:
        GET /api/export/streets/507f1f77bcf86cd799439011?fmt=geojson
        GET /api/export/streets/507f1f77bcf86cd799439011?fmt=csv&status_filter=undriven
    """
    # Validate format
    if fmt not in ["geojson", "csv"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format: {fmt}. Use 'geojson' or 'csv'",
        )

    # Validate status filter
    if status_filter and status_filter not in ["driven", "undriven", "undriveable"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status filter: {status_filter}",
        )

    # Get area
    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    # Check area is ready
    if area.status != "ready":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Area is not ready for export (status: {area.status})",
        )

    # Get features
    try:
        features = await get_street_features_with_status(
            area_id,
            area.area_version,
            status_filter,
        )
    except Exception as e:
        logger.exception("Error building street features: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build street export data",
        )

    # Generate filename
    status_suffix = f"_{status_filter}" if status_filter else ""
    filename_base = f"streets_{area.display_name.replace(' ', '_')}{status_suffix}"

    # Stream response
    if fmt == "geojson":
        stream = stream_geojson_features(features)
        return create_streaming_response(
            stream,
            "application/geo+json",
            f"{filename_base}.geojson",
        )
    else:  # csv
        fieldnames = [
            "segment_id",
            "street_name",
            "highway_type",
            "length_miles",
            "osm_id",
            "status",
            "first_driven_at",
            "last_driven_at",
            "manually_marked",
            "geometry_type",
            "geometry_json",
        ]
        stream = stream_csv_features(features, fieldnames)
        return create_streaming_response(
            stream,
            "text/csv",
            f"{filename_base}.csv",
        )


@router.get("/api/export/boundaries/{area_id}")
async def export_boundary(
    area_id: PydanticObjectId,
    fmt: Annotated[str, Query(description="Export format (geojson or csv)")] = "geojson",
):
    """
    Export boundary for a coverage area.

    Returns the area's boundary polygon with metadata.

    Example:
        GET /api/export/boundaries/507f1f77bcf86cd799439011?fmt=geojson
    """
    # Validate format
    if fmt not in ["geojson", "csv"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format: {fmt}. Use 'geojson' or 'csv'",
        )

    # Get area
    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    # Build feature
    try:
        feature = get_boundary_feature(area)
    except Exception as e:
        logger.exception("Error building boundary feature: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build boundary export data",
        )

    # Generate filename
    filename_base = f"boundary_{area.display_name.replace(' ', '_')}"

    # Stream response
    if fmt == "geojson":
        stream = stream_geojson_features([feature])
        return create_streaming_response(
            stream,
            "application/geo+json",
            f"{filename_base}.geojson",
        )
    else:  # csv
        fieldnames = [
            "area_id",
            "display_name",
            "area_type",
            "total_length_miles",
            "driven_length_miles",
            "coverage_percentage",
            "total_segments",
            "driven_segments",
            "status",
            "created_at",
            "geometry_type",
            "geometry_json",
        ]
        stream = stream_csv_features([feature], fieldnames)
        return create_streaming_response(
            stream,
            "text/csv",
            f"{filename_base}.csv",
        )


@router.get("/api/export/undriven-streets/{area_id}")
async def export_undriven_streets(
    area_id: PydanticObjectId,
    fmt: Annotated[str, Query(description="Export format (geojson or csv)")] = "geojson",
):
    """
    Export undriven streets for a coverage area.

    This is optimized for the "what streets haven't I driven yet?" use case.
    Only returns segments with status='undriven'.

    Example:
        GET /api/export/undriven-streets/507f1f77bcf86cd799439011?fmt=geojson
    """
    # Validate format
    if fmt not in ["geojson", "csv"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format: {fmt}. Use 'geojson' or 'csv'",
        )

    # Get area
    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    # Check area is ready
    if area.status != "ready":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Area is not ready for export (status: {area.status})",
        )

    # Get undriven features
    try:
        features = await get_undriven_street_features(area_id, area.area_version)
    except Exception as e:
        logger.exception("Error building undriven street features: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build undriven streets export data",
        )

    # Generate filename
    filename_base = f"undriven_streets_{area.display_name.replace(' ', '_')}"

    # Stream response
    if fmt == "geojson":
        stream = stream_geojson_features(features)
        return create_streaming_response(
            stream,
            "application/geo+json",
            f"{filename_base}.geojson",
        )
    else:  # csv
        fieldnames = [
            "segment_id",
            "street_name",
            "highway_type",
            "length_miles",
            "osm_id",
            "status",
            "geometry_type",
            "geometry_json",
        ]
        stream = stream_csv_features(features, fieldnames)
        return create_streaming_response(
            stream,
            "text/csv",
            f"{filename_base}.csv",
        )
