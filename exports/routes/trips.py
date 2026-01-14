"""Trip export route handlers."""

import json
import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status

from db import build_calendar_date_expr, build_query_from_request
from db.models import Trip
from export_helpers import create_export_response, process_trip_for_export
from exports.services.streaming_service import StreamingService

logger = logging.getLogger(__name__)
router = APIRouter()


async def trip_cursor_wrapper(cursor):
    """Yield dicts from Beanie cursor."""
    async for trip in cursor:
        yield trip.model_dump()


async def _export_from_query(
    find_query,
    fmt: str,
    filename_base: str,
    geometry_field: str = "gps",
    include_gps_in_csv: bool = False,
    flatten_location_fields: bool = True,
):
    cursor = trip_cursor_wrapper(find_query)

    response = await StreamingService.export_format(
        cursor,
        fmt,
        filename_base,
        geometry_field=geometry_field,
        include_gps_in_csv=include_gps_in_csv,
        flatten_location_fields=flatten_location_fields,
    )
    if response:
        return response

    trips_list = [t.model_dump() for t in await find_query.to_list()]
    return await create_export_response(
        trips_list,
        fmt,
        filename_base,
        include_gps_in_csv=include_gps_in_csv,
        flatten_location_fields=flatten_location_fields,
    )


async def _export_trips_from_request(
    request: Request,
    fmt: str,
    filename_prefix: str,
    query_overrides: dict | None = None,
    geometry_field: str = "gps",
    include_gps_in_csv: bool = False,
    flatten_location_fields: bool = True,
):
    query = await build_query_from_request(request)
    if query_overrides:
        query.update(query_overrides)

    filename_base = (
        f"{filename_prefix}_{StreamingService.get_date_range_filename(request)}"
    )
    find_query = Trip.find(query)
    return await _export_from_query(
        find_query,
        fmt,
        filename_base,
        geometry_field=geometry_field,
        include_gps_in_csv=include_gps_in_csv,
        flatten_location_fields=flatten_location_fields,
    )


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


@router.get("/api/export/trips")
async def export_trips_within_range(
    request: Request,
    fmt: Annotated[str, Query(description="Export format")] = "geojson",
):
    """Export trips within a date range."""
    return await _run_export(
        lambda: _export_trips_from_request(
            request,
            fmt,
            "trips",
        ),
        "Error exporting trips within range: %s",
    )


@router.get("/api/export/matched_trips")
async def export_matched_trips_within_range(
    request: Request,
    fmt: Annotated[str, Query(description="Export format")] = "geojson",
):
    """Export matched trips within a date range."""
    return await _run_export(
        lambda: _export_trips_from_request(
            request,
            fmt,
            "matched_trips",
            query_overrides={"matchedGps": {"$ne": None}},
            geometry_field="matchedGps",
        ),
        "Error exporting matched trips: %s",
    )


@router.get("/api/export/advanced")
async def export_advanced(
    request: Request,
    include_trips: Annotated[bool, Query(description="Include regular trips")] = True,
    include_matched_trips: Annotated[
        bool,
        Query(description="Include map-matched trips"),
    ] = True,
    include_basic_info: Annotated[
        bool,
        Query(description="Include basic trip info"),
    ] = True,
    include_locations: Annotated[
        bool,
        Query(description="Include location info"),
    ] = True,
    include_telemetry: Annotated[
        bool,
        Query(description="Include telemetry data"),
    ] = True,
    include_geometry: Annotated[
        bool,
        Query(description="Include geometry data"),
    ] = True,
    include_meta: Annotated[bool, Query(description="Include metadata")] = True,
    include_custom: Annotated[bool, Query(description="Include custom fields")] = True,
    include_gps_in_csv: Annotated[
        bool,
        Query(description="Include GPS in CSV export"),
    ] = False,
    flatten_location_fields: Annotated[
        bool,
        Query(description="Flatten location fields in CSV"),
    ] = True,
    fmt: Annotated[str, Query(description="Export format")] = "json",
):
    """Advanced configurable export for trips data."""
    import csv
    from io import StringIO

    from fastapi.responses import StreamingResponse

    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")

        range_expr = None
        if start_date_str and end_date_str:
            range_expr = build_calendar_date_expr(start_date_str, end_date_str)
            if not range_expr:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date range",
                )

        date_filter = {"$expr": range_expr} if range_expr else {}
        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"trips_export_{current_time}"

        async def processed_docs_cursor():
            final_filter = date_filter.copy()
            if include_matched_trips and not include_trips:
                final_filter["matchedGps"] = {"$ne": None}
            elif not include_matched_trips and not include_trips:
                return

            # Use Beanie Trip model find
            async for trip in Trip.find(final_filter):
                trip_dict = trip.model_dump()
                processed = await process_trip_for_export(
                    trip_dict,
                    include_basic_info,
                    include_locations,
                    include_telemetry,
                    include_geometry,
                    include_meta,
                    include_custom,
                )
                if processed:
                    processed["trip_type"] = trip_dict.get("source", "unknown")
                    if trip_dict.get("matchedGps"):
                        processed["has_match"] = True
                    yield processed

        if fmt == "csv":
            base_fields = _build_csv_fields(
                include_basic_info,
                include_locations,
                include_telemetry,
                include_geometry,
                include_meta,
                include_custom,
            )

            async def csv_generator():
                buf = StringIO()
                writer = csv.DictWriter(buf, fieldnames=base_fields)
                writer.writeheader()
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate(0)

                async for item in processed_docs_cursor():
                    row = {}
                    for k in base_fields:
                        v = item.get(k)
                        if isinstance(v, dict | list):
                            row[k] = json.dumps(v, default=str)
                        else:
                            row[k] = v
                    writer.writerow(row)
                    yield buf.getvalue()
                    buf.seek(0)
                    buf.truncate(0)

            return StreamingResponse(
                csv_generator(),
                media_type="text/csv",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.csv"',
                },
            )

        if fmt == "json":

            async def json_generator():
                yield "["
                first = True
                async for item in processed_docs_cursor():
                    chunk = json.dumps(item, separators=(",", ":"), default=str)
                    if not first:
                        yield ","
                    yield chunk
                    first = False
                yield "]"

            return StreamingResponse(
                json_generator(),
                media_type="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.json"',
                },
            )

        # For geojson/shapefile/gpx, materialize a bounded list
        limited = []
        async for item in processed_docs_cursor():
            limited.append(item)
            if len(limited) >= 1000:
                break

        return await create_export_response(
            limited,
            fmt,
            filename_base,
            include_gps_in_csv=include_gps_in_csv,
            flatten_location_fields=flatten_location_fields,
        )
    except ValueError as e:
        logger.exception("Export error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.error("Error in advanced export: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Export failed: {e!s}",
        )


def _build_csv_fields(
    include_basic_info: bool,
    include_locations: bool,
    include_telemetry: bool,
    include_geometry: bool,
    include_meta: bool,
    include_custom: bool,
) -> list[str]:
    """Build CSV field list based on include flags."""
    base_fields = []
    if include_basic_info:
        base_fields += [
            "_id",
            "transactionId",
            "trip_id",
            "startTime",
            "endTime",
            "duration",
            "durationInMinutes",
            "completed",
            "active",
        ]
    if include_locations:
        base_fields += [
            "startLocation",
            "destination",
            "startAddress",
            "endAddress",
            "startPoint",
            "endPoint",
            "state",
            "city",
        ]
    if include_telemetry:
        base_fields += [
            "distance",
            "distanceInMiles",
            "startOdometer",
            "endOdometer",
            "maxSpeed",
            "averageSpeed",
            "idleTime",
            "fuelConsumed",
            "fuelEconomy",
            "speedingEvents",
        ]
    if include_geometry:
        base_fields += ["gps", "path", "simplified_path", "route", "geometry"]
    if include_meta:
        base_fields += [
            "deviceId",
            "imei",
            "vehicleId",
            "source",
            "processingStatus",
            "processingTime",
            "mapMatchStatus",
            "confidence",
            "insertedAt",
            "updatedAt",
        ]
    if include_custom:
        base_fields += ["notes", "tags", "category", "purpose", "customFields"]

    return sorted({*base_fields, "trip_type"})
