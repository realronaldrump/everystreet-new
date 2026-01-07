import json
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from db import (
    build_calendar_date_expr,
    build_query_from_request,
    db_manager,
    find_one_with_retry,
    json_dumps,
    parse_query_date,
)
from export_helpers import (
    CSV_BASE_FIELDS,
    CSV_GEOMETRY_FIELDS,
    CSV_LOCATION_FIELDS,
    create_export_response,
    create_gpx,
    flatten_trip_for_csv,
    get_location_filename,
    process_trip_for_export,
)
from geometry_service import GeometryService
from osm_utils import generate_geojson_osm

logger = logging.getLogger(__name__)
router = APIRouter()

trips_collection = db_manager.db["trips"]


# ----------------------------- Streaming helpers -----------------------------


def _date_range_filename_component(request: Request) -> str:
    start = request.query_params.get("start_date")
    end = request.query_params.get("end_date")
    if start and end:
        try:
            s = parse_query_date(start)
            e = parse_query_date(end)
            if s and e:
                return f"{s.strftime('%Y%m%d')}-{e.strftime('%Y%m%d')}"
        except Exception:
            pass
    return datetime.now().strftime("%Y%m%d")


async def _stream_geojson_from_cursor(cursor) -> Any:
    async def generator():
        yield '{"type":"FeatureCollection","features":['
        first = True
        async for trip in cursor:
            try:
                geom = GeometryService.geometry_from_document(trip, "gps")
                if not geom:
                    continue
                props = {k: v for k, v in trip.items() if k != "gps"}
                feature = GeometryService.feature_from_geometry(geom, props)
                chunk = json_dumps(feature, separators=(",", ":"))
                if not first:
                    yield ","
                yield chunk
                first = False
            except Exception as e:
                logger.warning("Skipping trip in GeoJSON stream due to error: %s", e)
                continue
        yield "]}"

    return generator()


async def _stream_json_array_from_cursor(cursor) -> Any:
    async def generator():
        yield "["
        first = True
        async for doc in cursor:
            try:
                chunk = json_dumps(doc, separators=(",", ":"))
                if not first:
                    yield ","
                yield chunk
                first = False
            except Exception as e:
                logger.warning("Skipping document in JSON stream: %s", e)
                continue
        yield "]"

    return generator()


async def _stream_gpx_from_cursor(cursor) -> Any:
    """Generate GPX from trip cursor using gpxpy library.

    Collects trips from cursor and uses the gpxpy-based create_gpx function
    for proper GPX generation with validation and proper XML structure.
    """
    trips = []
    async for trip in cursor:
        trips.append(trip)

    gpx_content = await create_gpx(trips)

    async def generator():
        yield gpx_content

    return generator()


async def _stream_csv_from_cursor(
    cursor, include_gps_in_csv: bool, flatten_location_fields: bool
) -> Any:
    """Stream CSV data from cursor with predefined headers for efficiency.

    Uses the shared flatten_trip_for_csv function for consistent flattening
    logic between streaming and buffered CSV exports.
    """
    import csv
    from io import StringIO

    # Build fieldnames from shared constants
    base_fields = list(CSV_BASE_FIELDS)
    location_fields = list(CSV_LOCATION_FIELDS) if flatten_location_fields else []

    if not flatten_location_fields:
        base_fields.extend(["startLocation", "destination"])

    # Combine all fields in priority order
    fieldnames = base_fields + location_fields + list(CSV_GEOMETRY_FIELDS)

    async def generator():
        buf = StringIO()
        writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")

        # Write header immediately
        writer.writeheader()
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)

        # Process each document using the shared flattening function
        async for doc in cursor:
            try:
                flat = flatten_trip_for_csv(
                    doc,
                    include_gps_in_csv=include_gps_in_csv,
                    flatten_location_fields=flatten_location_fields,
                )

                writer.writerow(flat)
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate(0)
            except Exception as e:
                logger.warning("Skipping document in CSV stream due to error: %s", e)
                continue

    return generator()


@router.get("/export/geojson")
async def export_geojson(request: Request):
    """Export trips as GeoJSON."""
    try:
        query = await build_query_from_request(request)
        cursor = trips_collection.find(query).batch_size(500)
        stream = await _stream_geojson_from_cursor(cursor)
        filename_base = f"trips_{_date_range_filename_component(request)}"
        return StreamingResponse(
            stream,
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.geojson"',
            },
        )
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
        stream = await _stream_gpx_from_cursor(cursor)
        filename_base = f"trips_{_date_range_filename_component(request)}"
        return StreamingResponse(
            stream,
            media_type="application/gpx+xml",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.gpx"',
            },
        )
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

        # Single-trip export does not risk OOM; reuse existing helper
        return await create_export_response([t], fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    except Exception as e:
        logger.exception(
            "Error exporting trip %s: %s",
            trip_id,
            str(e),
        )
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

        if fmt.lower() == "json":
            stream = await _stream_json_array_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.json"',
                },
            )
        if fmt.lower() == "geojson":
            stream = await _stream_geojson_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/geo+json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.geojson"',
                },
            )
        if fmt.lower() == "gpx":
            stream = await _stream_gpx_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/gpx+xml",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.gpx"',
                },
            )
        if fmt.lower() == "csv":
            stream = await _stream_csv_from_cursor(
                cursor, include_gps_in_csv=False, flatten_location_fields=True
            )
            return StreamingResponse(
                stream,
                media_type="text/csv",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.csv"',
                },
            )
        # shapefile and others fall back to non-streaming helper
        all_trips = await trips_collection.find({}).to_list(length=1000)
        return await create_export_response(all_trips, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception(
            "Error exporting all trips: %s",
            str(e),
        )
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
        filename_base = f"trips_{_date_range_filename_component(request)}"

        cursor = trips_collection.find(query).batch_size(500)

        if fmt.lower() == "json":
            stream = await _stream_json_array_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.json"'
                },
            )
        if fmt.lower() == "geojson":
            stream = await _stream_geojson_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/geo+json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.geojson"'
                },
            )
        if fmt.lower() == "gpx":
            stream = await _stream_gpx_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/gpx+xml",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.gpx"'
                },
            )
        if fmt.lower() == "csv":
            stream = await _stream_csv_from_cursor(
                cursor, include_gps_in_csv=False, flatten_location_fields=True
            )
            return StreamingResponse(
                stream,
                media_type="text/csv",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.csv"'
                },
            )

        # Fallback
        trips_list = await trips_collection.find(query).to_list(length=1000)
        return await create_export_response(trips_list, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    except Exception as e:
        logger.exception(
            "Error exporting trips within range: %s",
            str(e),
        )
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
        filename_base = f"matched_trips_{_date_range_filename_component(request)}"

        cursor = trips_collection.find(query).batch_size(500)

        if fmt.lower() == "json":
            stream = await _stream_json_array_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.json"'
                },
            )
        if fmt.lower() == "geojson":
            stream = await _stream_geojson_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/geo+json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.geojson"'
                },
            )
        if fmt.lower() == "gpx":
            stream = await _stream_gpx_from_cursor(cursor)
            return StreamingResponse(
                stream,
                media_type="application/gpx+xml",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.gpx"'
                },
            )
        if fmt.lower() == "csv":
            stream = await _stream_csv_from_cursor(
                cursor, include_gps_in_csv=False, flatten_location_fields=True
            )
            return StreamingResponse(
                stream,
                media_type="text/csv",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.csv"'
                },
            )

        matched_list = await trips_collection.find(query).to_list(length=1000)
        return await create_export_response(matched_list, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception(
            "Error exporting matched trips: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/streets")
async def export_streets(
    location: str = Query(
        ...,
        description="Location data in JSON format",
    ),
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
    except Exception as e:
        logger.exception(
            "Error exporting streets data: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/boundary")
async def export_boundary(
    location: str = Query(
        ...,
        description="Location data in JSON format",
    ),
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

    except Exception as e:
        logger.exception(
            "Error exporting boundary data: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/export/advanced")
async def export_advanced(
    request: Request,
    include_trips: bool = Query(
        True,
        description="Include regular trips (now all trips)",
    ),
    include_matched_trips: bool = Query(
        True,
        description="Include map-matched trips",
    ),
    include_basic_info: bool = Query(
        True,
        description="Include basic trip info",
    ),
    include_locations: bool = Query(True, description="Include location info"),
    include_telemetry: bool = Query(
        True,
        description="Include telemetry data",
    ),
    include_geometry: bool = Query(True, description="Include geometry data"),
    include_meta: bool = Query(True, description="Include metadata"),
    include_custom: bool = Query(True, description="Include custom fields"),
    include_gps_in_csv: bool = Query(
        False,
        description="Include GPS in CSV export",
    ),
    flatten_location_fields: bool = Query(
        True,
        description="Flatten location fields in CSV",
    ),
    fmt: str = Query("json", description="Export format"),
):
    """Advanced configurable export for trips data.

    Allows fine-grained control over data sources, fields to include, date
    range, and export format.
    """
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
            # Determine filter based on flags
            final_filter = date_filter.copy()
            if include_matched_trips and not include_trips:
                final_filter["matchedGps"] = {"$ne": None}
            elif not include_matched_trips and not include_trips:
                # Nothing requested
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
                    # If it has matched data, maybe indicate?
                    if trip.get("matchedGps"):
                        processed["has_match"] = True
                    yield processed

        if fmt == "csv":
            # Convert async generator to streaming CSV
            import csv
            from io import StringIO

            async def csv_generator():
                # Define a stable header from include_* flags
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
                    base_fields += [
                        "gps",
                        "path",
                        "simplified_path",
                        "route",
                        "geometry",
                    ]
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
                    base_fields += [
                        "notes",
                        "tags",
                        "category",
                        "purpose",
                        "customFields",
                    ]
                base_fields = sorted(set(base_fields + ["trip_type"]))

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
                    "Content-Disposition": f'attachment; filename="{filename_base}.csv"',
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
                    "Content-Disposition": f'attachment; filename="{filename_base}.json"',
                },
            )

        # For geojson/shapefile/gpx, fall back to existing helper by
        # materializing a bounded list
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

    except Exception as e:
        logger.error("Error in advanced export: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Export failed: {e!s}",
        )
