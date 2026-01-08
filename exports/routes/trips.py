"""Trip export route handlers."""

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, status

from db import (
    build_calendar_date_expr,
    build_query_from_request,
    db_manager,
    find_one_with_retry,
    json_dumps,
)
from export_helpers import create_export_response, process_trip_for_export
from exports.services import StreamingService

logger = logging.getLogger(__name__)
router = APIRouter()

trips_collection = db_manager.db["trips"]


@router.get("/export/geojson")
async def export_geojson(request: Request):
    """Export trips as GeoJSON."""
    try:
        query = await build_query_from_request(request)
        cursor = trips_collection.find(query).batch_size(500)
        filename_base = f"trips_{StreamingService.get_date_range_filename(request)}"

        response = await StreamingService.export_format(
            cursor, "geojson", filename_base
        )
        return response
    except Exception as e:
        logger.exception("Error exporting GeoJSON: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/export/gpx")
async def export_gpx(request: Request):
    """Export trips as GPX."""
    try:
        query = await build_query_from_request(request)
        cursor = trips_collection.find(query).batch_size(500)
        filename_base = f"trips_{StreamingService.get_date_range_filename(request)}"

        response = await StreamingService.export_format(cursor, "gpx", filename_base)
        return response
    except Exception as e:
        logger.exception("Error exporting GPX: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/trip/{trip_id}")
async def export_single_trip(
    trip_id: str,
    fmt: str = Query("geojson", description="Export format"),
):
    """Export a single trip by ID."""
    try:
        t = await find_one_with_retry(
            trips_collection,
            {"transactionId": trip_id},
        )

        if not t:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        start_date = t.get("startTime")
        date_str = start_date.strftime("%Y%m%d") if start_date else "unknown_date"
        filename_base = f"trip_{trip_id}_{date_str}"

        return await create_export_response([t], fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error exporting trip %s: %s", trip_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/all_trips")
async def export_all_trips(
    fmt: str = Query("geojson", description="Export format"),
):
    """Export all trips in various formats."""
    try:
        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"all_trips_{current_time}"

        cursor = trips_collection.find({}).batch_size(500)

        # Try streaming export first
        response = await StreamingService.export_format(cursor, fmt, filename_base)
        if response:
            return response

        # Fall back to non-streaming helper for shapefile
        all_trips = await trips_collection.find({}).to_list(length=1000)
        return await create_export_response(all_trips, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error exporting all trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/trips")
async def export_trips_within_range(
    request: Request,
    fmt: str = Query("geojson", description="Export format"),
):
    """Export trips within a date range."""
    try:
        query = await build_query_from_request(request)
        filename_base = f"trips_{StreamingService.get_date_range_filename(request)}"

        cursor = trips_collection.find(query).batch_size(500)

        response = await StreamingService.export_format(cursor, fmt, filename_base)
        if response:
            return response

        # Fallback for shapefile
        trips_list = await trips_collection.find(query).to_list(length=1000)
        return await create_export_response(trips_list, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error exporting trips within range: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/matched_trips")
async def export_matched_trips_within_range(
    request: Request,
    fmt: str = Query("geojson", description="Export format"),
):
    """Export matched trips within a date range."""
    try:
        query = await build_query_from_request(request)
        query["matchedGps"] = {"$ne": None}
        filename_base = f"matched_trips_{StreamingService.get_date_range_filename(request)}"

        cursor = trips_collection.find(query).batch_size(500)

        response = await StreamingService.export_format(
            cursor, fmt, filename_base, geometry_field="matchedGps"
        )
        if response:
            return response

        matched_list = await trips_collection.find(query).to_list(length=1000)
        return await create_export_response(matched_list, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error exporting matched trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/advanced")
async def export_advanced(
    request: Request,
    include_trips: bool = Query(True, description="Include regular trips"),
    include_matched_trips: bool = Query(True, description="Include map-matched trips"),
    include_basic_info: bool = Query(True, description="Include basic trip info"),
    include_locations: bool = Query(True, description="Include location info"),
    include_telemetry: bool = Query(True, description="Include telemetry data"),
    include_geometry: bool = Query(True, description="Include geometry data"),
    include_meta: bool = Query(True, description="Include metadata"),
    include_custom: bool = Query(True, description="Include custom fields"),
    include_gps_in_csv: bool = Query(False, description="Include GPS in CSV export"),
    flatten_location_fields: bool = Query(True, description="Flatten location fields in CSV"),
    fmt: str = Query("json", description="Export format"),
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

            async for trip in trips_collection.find(final_filter).batch_size(500):
                processed = await process_trip_for_export(
                    trip,
                    include_basic_info,
                    include_locations,
                    include_telemetry,
                    include_geometry,
                    include_meta,
                    include_custom,
                )
                if processed:
                    processed["trip_type"] = trip.get("source", "unknown")
                    if trip.get("matchedGps"):
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
                            row[k] = json_dumps(v)
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
                    "Content-Disposition": f'attachment; filename="{filename_base}.csv"'
                },
            )

        if fmt == "json":

            async def json_generator():
                yield "["
                first = True
                async for item in processed_docs_cursor():
                    chunk = json_dumps(item, separators=(",", ":"))
                    if not first:
                        yield ","
                    yield chunk
                    first = False
                yield "]"

            return StreamingResponse(
                json_generator(),
                media_type="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.json"'
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
        logger.error("Export error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except HTTPException:
        raise
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
            "_id", "transactionId", "trip_id", "startTime", "endTime",
            "duration", "durationInMinutes", "completed", "active",
        ]
    if include_locations:
        base_fields += [
            "startLocation", "destination", "startAddress", "endAddress",
            "startPoint", "endPoint", "state", "city",
        ]
    if include_telemetry:
        base_fields += [
            "distance", "distanceInMiles", "startOdometer", "endOdometer",
            "maxSpeed", "averageSpeed", "idleTime", "fuelConsumed",
            "fuelEconomy", "speedingEvents",
        ]
    if include_geometry:
        base_fields += ["gps", "path", "simplified_path", "route", "geometry"]
    if include_meta:
        base_fields += [
            "deviceId", "imei", "vehicleId", "source", "processingStatus",
            "processingTime", "mapMatchStatus", "confidence", "insertedAt", "updatedAt",
        ]
    if include_custom:
        base_fields += ["notes", "tags", "category", "purpose", "customFields"]

    return sorted(set(base_fields + ["trip_type"]))
