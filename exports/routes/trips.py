"""Trip export route handlers - simplified and streamlined."""

import json
import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status

from db import build_calendar_date_expr, build_query_from_request
from db.models import Trip
from export_helpers import process_trip_for_export
from export_helpers.trip_processing import (
    BASIC_INFO_FIELDS,
    CUSTOM_FIELDS,
    GEOMETRY_FIELDS,
    LOCATION_FIELDS,
    META_FIELDS,
    TELEMETRY_FIELDS,
)
from exports.services.streaming_service import StreamingService

logger = logging.getLogger(__name__)
router = APIRouter()


def parse_field_groups(fields_param: str | None) -> dict[str, bool]:
    """
    Parse comma-separated field groups into include flags.

    Args:
        fields_param: Comma-separated field groups (e.g., "basic,locations,telemetry")

    Returns:
        Dict of include flags for each field group
    """
    if not fields_param:
        # Default: Include most common fields
        return {
            "include_basic_info": True,
            "include_locations": True,
            "include_telemetry": True,
            "include_geometry": True,
            "include_meta": False,
            "include_custom": False,
        }

    groups = [g.strip().lower() for g in fields_param.split(",")]

    return {
        "include_basic_info": "basic" in groups,
        "include_locations": "locations" in groups,
        "include_telemetry": "telemetry" in groups,
        "include_geometry": "geometry" in groups or "gps" in groups,
        "include_meta": "metadata" in groups or "meta" in groups,
        "include_custom": "custom" in groups,
    }


def get_csv_fieldnames(include_flags: dict[str, bool], flatten_location_fields: bool = True) -> list[str]:
    """Build CSV field names based on include flags."""
    fieldnames = []

    if include_flags["include_basic_info"]:
        fieldnames.extend(BASIC_INFO_FIELDS)

    if include_flags["include_locations"]:
        if flatten_location_fields:
            fieldnames.extend(LOCATION_FIELDS)
        else:
            fieldnames.extend(["startLocation", "destination"])

    if include_flags["include_telemetry"]:
        fieldnames.extend(TELEMETRY_FIELDS)

    if include_flags["include_geometry"]:
        fieldnames.extend(GEOMETRY_FIELDS)

    if include_flags["include_meta"]:
        fieldnames.extend(META_FIELDS)

    if include_flags["include_custom"]:
        fieldnames.extend(CUSTOM_FIELDS)

    return list(dict.fromkeys(fieldnames))  # Remove duplicates while preserving order


async def trip_cursor_wrapper(cursor):
    """Yield dicts from Beanie cursor."""
    async for trip in cursor:
        yield trip.model_dump()


async def _export_from_query(
    find_query,
    fmt: str,
    filename_base: str,
    geometry_field: str = "gps",
    include_flags: dict[str, bool] | None = None,
    flatten_location_fields: bool = True,
):
    """
    Export trips from a query with field filtering.

    Args:
        find_query: Beanie query
        fmt: Format (geojson or csv)
        filename_base: Base filename for export
        geometry_field: Geometry field to use (gps or matchedGps)
        include_flags: Field group include flags
        flatten_location_fields: Flatten location fields in CSV
    """
    if include_flags is None:
        include_flags = {
            "include_basic_info": True,
            "include_locations": True,
            "include_telemetry": True,
            "include_geometry": True,
            "include_meta": False,
            "include_custom": False,
        }

    # For GeoJSON, use streaming directly without field filtering
    if fmt == "geojson":
        cursor = trip_cursor_wrapper(find_query)
        return await StreamingService.export_format(
            cursor,
            fmt,
            filename_base,
            geometry_field=geometry_field,
        )

    # For CSV with field filtering, we need to process each trip
    if fmt == "csv":
        from fastapi.responses import StreamingResponse
        from io import StringIO
        import csv

        fieldnames = get_csv_fieldnames(include_flags, flatten_location_fields)

        async def csv_generator():
            buf = StringIO()
            writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")

            # Write header
            writer.writeheader()
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate(0)

            # Stream rows
            async for trip in find_query:
                try:
                    trip_dict = trip.model_dump()

                    # Process trip based on field flags
                    processed = await process_trip_for_export(
                        trip_dict,
                        **include_flags,
                    )

                    # Flatten for CSV
                    from export_helpers import flatten_trip_for_csv
                    flat = flatten_trip_for_csv(
                        processed,
                        include_gps_in_csv=include_flags["include_geometry"],
                        flatten_location_fields=flatten_location_fields,
                    )

                    writer.writerow(flat)
                    yield buf.getvalue()
                    buf.seek(0)
                    buf.truncate(0)
                except Exception as e:
                    logger.warning("Skipping trip in CSV export: %s", e)
                    continue

        return StreamingResponse(
            csv_generator(),
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.csv"',
            },
        )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unsupported format: {fmt}. Use 'geojson' or 'csv'",
    )


async def _export_trips_from_request(
    request: Request,
    fmt: str,
    filename_prefix: str,
    query_overrides: dict | None = None,
    geometry_field: str = "gps",
    fields: str | None = None,
    flatten_location_fields: bool = True,
):
    """Build query from request and export trips."""
    query = await build_query_from_request(request)
    if query_overrides:
        query.update(query_overrides)

    filename_base = (
        f"{filename_prefix}_{StreamingService.get_date_range_filename(request)}"
    )
    find_query = Trip.find(query)

    # Parse field groups
    include_flags = parse_field_groups(fields)

    return await _export_from_query(
        find_query,
        fmt,
        filename_base,
        geometry_field=geometry_field,
        include_flags=include_flags,
        flatten_location_fields=flatten_location_fields,
    )


async def _run_export(action, error_message: str):
    """Wrapper for export error handling."""
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


@router.get("/api/export/trips")
async def export_trips_within_range(
    request: Request,
    fmt: Annotated[str, Query(description="Export format (geojson or csv)")] = "geojson",
    fields: Annotated[
        str | None,
        Query(description="Comma-separated field groups: basic,locations,telemetry,geometry,metadata,custom"),
    ] = None,
    flatten_location_fields: Annotated[
        bool,
        Query(description="Flatten location fields in CSV"),
    ] = True,
):
    """
    Export trips within a date range.

    Supports field filtering for CSV exports to include only requested data.

    Query Parameters:
        - start_date: Start date (YYYY-MM-DD)
        - end_date: End date (YYYY-MM-DD)
        - fmt: Format (geojson or csv)
        - fields: Comma-separated field groups (for CSV)
        - flatten_location_fields: Flatten location fields in CSV

    Example:
        GET /api/export/trips?start_date=2024-01-01&end_date=2024-01-31&fmt=csv&fields=basic,locations,telemetry
    """
    if fmt not in ["geojson", "csv"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format: {fmt}. Use 'geojson' or 'csv'",
        )

    return await _run_export(
        lambda: _export_trips_from_request(
            request,
            fmt,
            "trips",
            fields=fields,
            flatten_location_fields=flatten_location_fields,
        ),
        "Error exporting trips within range: %s",
    )


@router.get("/api/export/matched_trips")
async def export_matched_trips_within_range(
    request: Request,
    fmt: Annotated[str, Query(description="Export format (geojson or csv)")] = "geojson",
    fields: Annotated[
        str | None,
        Query(description="Comma-separated field groups: basic,locations,telemetry,geometry,metadata,custom"),
    ] = None,
    flatten_location_fields: Annotated[
        bool,
        Query(description="Flatten location fields in CSV"),
    ] = True,
):
    """
    Export map-matched trips within a date range.

    Only exports trips that have been map-matched (matchedGps field present).

    Query Parameters:
        - start_date: Start date (YYYY-MM-DD)
        - end_date: End date (YYYY-MM-DD)
        - fmt: Format (geojson or csv)
        - fields: Comma-separated field groups (for CSV)
        - flatten_location_fields: Flatten location fields in CSV

    Example:
        GET /api/export/matched_trips?start_date=2024-01-01&end_date=2024-01-31&fmt=geojson
    """
    if fmt not in ["geojson", "csv"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format: {fmt}. Use 'geojson' or 'csv'",
        )

    return await _run_export(
        lambda: _export_trips_from_request(
            request,
            fmt,
            "matched_trips",
            query_overrides={"matchedGps": {"$ne": None}},
            geometry_field="matchedGps",
            fields=fields,
            flatten_location_fields=flatten_location_fields,
        ),
        "Error exporting matched trips: %s",
    )
