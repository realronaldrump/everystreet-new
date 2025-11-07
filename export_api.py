import json
import logging
from datetime import datetime, timezone
from typing import Any

import geojson as geojson_module
from fastapi import APIRouter, Body, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from db import (
    build_calendar_date_expr,
    build_query_from_request,
    db_manager,
    find_one_with_retry,
    parse_query_date,
)
from export_helpers import (
    create_export_response,
    default_serializer,
    get_location_filename,
    process_trip_for_export,
)
from osm_utils import generate_geojson_osm

logger = logging.getLogger(__name__)
router = APIRouter()

trips_collection = db_manager.db["trips"]
matched_trips_collection = db_manager.db["matched_trips"]


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
                geom = trip.get("gps")
                if not isinstance(geom, dict) or not geom.get("type"):
                    continue
                props = {k: v for k, v in trip.items() if k != "gps"}
                feature = {"type": "Feature", "geometry": geom, "properties": props}
                chunk = json.dumps(
                    feature, default=default_serializer, separators=(",", ":")
                )
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
                chunk = json.dumps(
                    doc, default=default_serializer, separators=(",", ":")
                )
                if not first:
                    yield ","
                yield chunk
                first = False
            except Exception as e:
                logger.warning("Skipping document in JSON stream: %s", e)
                continue
        yield "]"

    return generator()


def _xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


async def _stream_gpx_from_cursor(cursor) -> Any:
    async def generator():
        yield '<?xml version="1.0" encoding="UTF-8"?>\n'
        yield '<gpx version="1.1" creator="EveryStreet" xmlns="http://www.topografix.com/GPX/1/1">\n'
        async for trip in cursor:
            try:
                geom = trip.get("gps")
                if not isinstance(geom, dict) or "type" not in geom:
                    continue
                name = _xml_escape(str(trip.get("transactionId", "trip")))
                yield f"  <trk><name>{name}</name><trkseg>\n"
                if geom.get("type") == "LineString":
                    coords = geom.get("coordinates", [])
                    for c in coords:
                        if isinstance(c, (list, tuple)) and len(c) >= 2:
                            lon, lat = c[0], c[1]
                            yield f'    <trkpt lat="{lat}" lon="{lon}"/>\n'
                elif geom.get("type") == "Point":
                    coords = geom.get("coordinates", [])
                    if isinstance(coords, (list, tuple)) and len(coords) >= 2:
                        lon, lat = coords[0], coords[1]
                        yield f'    <trkpt lat="{lat}" lon="{lon}"/>\n'
                yield "  </trkseg></trk>\n"
            except Exception as e:
                logger.warning("Skipping trip in GPX stream: %s", e)
                continue
        yield "</gpx>\n"

    return generator()


async def _stream_csv_from_cursor(
    cursor, include_gps_in_csv: bool, flatten_location_fields: bool
) -> Any:
    """Stream CSV data from cursor with predefined headers for efficiency.

    Uses the csv module with a predefined set of headers based on export options,
    which is simpler and more robust than introspecting the first document.
    """
    import csv
    from io import StringIO

    # Define expected headers upfront based on export options
    base_fields = [
        "_id",
        "transactionId",
        "trip_id",
        "trip_type",
        "startTime",
        "endTime",
        "duration",
        "distance",
        "imei",
        "source",
        "completed",
    ]

    location_fields = []
    if flatten_location_fields:
        location_fields = [
            "startLocation_formatted_address",
            "startLocation_street_number",
            "startLocation_street",
            "startLocation_city",
            "startLocation_county",
            "startLocation_state",
            "startLocation_postal_code",
            "startLocation_country",
            "startLocation_lat",
            "startLocation_lng",
            "destination_formatted_address",
            "destination_street_number",
            "destination_street",
            "destination_city",
            "destination_county",
            "destination_state",
            "destination_postal_code",
            "destination_country",
            "destination_lat",
            "destination_lng",
        ]
    else:
        # Include location objects as JSON if not flattening
        base_fields.extend(["startLocation", "destination"])

    geometry_fields = ["gps", "geometry", "path", "simplified_path", "route"]

    # Combine all fields in priority order
    fieldnames = base_fields + location_fields + geometry_fields

    async def generator():
        buf = StringIO()
        writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction='ignore')

        # Write header immediately
        writer.writeheader()
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)

        # Process each document
        async for doc in cursor:
            try:
                flat = {}

                # Handle geometry fields
                for key in geometry_fields:
                    if key in doc:
                        if include_gps_in_csv:
                            flat[key] = json.dumps(doc[key], default=default_serializer)
                        else:
                            flat[key] = "[Geometry data not included]"

                # Handle location flattening
                if flatten_location_fields:
                    def normalize(obj):
                        if isinstance(obj, str):
                            try:
                                return json.loads(obj)
                            except json.JSONDecodeError:
                                return {}
                        return obj if isinstance(obj, dict) else {}

                    start_loc = normalize(doc.get("startLocation", {}))
                    dest = normalize(doc.get("destination", {}))

                    flat["startLocation_formatted_address"] = start_loc.get("formatted_address", "")
                    addr = start_loc.get("address_components", {}) if isinstance(start_loc, dict) else {}
                    flat["startLocation_street_number"] = addr.get("street_number", "")
                    flat["startLocation_street"] = addr.get("street", "")
                    flat["startLocation_city"] = addr.get("city", "")
                    flat["startLocation_county"] = addr.get("county", "")
                    flat["startLocation_state"] = addr.get("state", "")
                    flat["startLocation_postal_code"] = addr.get("postal_code", "")
                    flat["startLocation_country"] = addr.get("country", "")
                    coords = start_loc.get("coordinates", {}) if isinstance(start_loc, dict) else {}
                    flat["startLocation_lat"] = coords.get("lat", "")
                    flat["startLocation_lng"] = coords.get("lng", "")

                    flat["destination_formatted_address"] = dest.get("formatted_address", "")
                    addr = dest.get("address_components", {}) if isinstance(dest, dict) else {}
                    flat["destination_street_number"] = addr.get("street_number", "")
                    flat["destination_street"] = addr.get("street", "")
                    flat["destination_city"] = addr.get("city", "")
                    flat["destination_county"] = addr.get("county", "")
                    flat["destination_state"] = addr.get("state", "")
                    flat["destination_postal_code"] = addr.get("postal_code", "")
                    flat["destination_country"] = addr.get("country", "")
                    coords = dest.get("coordinates", {}) if isinstance(dest, dict) else {}
                    flat["destination_lat"] = coords.get("lat", "")
                    flat["destination_lng"] = coords.get("lng", "")
                else:
                    # Include locations as JSON strings
                    if "startLocation" in doc:
                        flat["startLocation"] = json.dumps(doc["startLocation"], default=default_serializer)
                    if "destination" in doc:
                        flat["destination"] = json.dumps(doc["destination"], default=default_serializer)

                # Handle all other base fields
                for key in base_fields:
                    if key in doc and key not in flat:
                        value = doc[key]
                        if isinstance(value, (dict, list)):
                            flat[key] = json.dumps(value, default=default_serializer)
                        else:
                            flat[key] = value

                writer.writerow(flat)
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate(0)
            except Exception as e:
                logger.warning("Skipping document in CSV stream due to error: %s", e)
                continue

    return generator()


@router.post("/api/export/coverage-route")
async def export_coverage_route_endpoint(
    payload: dict = Body(...),
):
    """
    Export the provided coverage route GeoJSON data in the specified format.
    This endpoint now robustly handles both GeometryCollection and single LineString geometries.
    """
    try:
        route_geometry = payload.get("route_geometry")
        fmt = payload.get("format", "geojson").lower()
        location_display_name = payload.get("location_name", "coverage_route")

        if not route_geometry or not isinstance(route_geometry, dict):
            raise HTTPException(
                status_code=400, detail="Invalid or missing route_geometry."
            )

        geom_type = route_geometry.get("type")
        data_to_export: Any
        filename_base = f"{location_display_name.replace(' ', '_').lower()}_route"

        if geom_type == "GeometryCollection":
            # Handle complex coverage route
            if fmt == "gpx":
                trips_for_gpx = []
                for i, geom in enumerate(route_geometry.get("geometries", [])):
                    if (
                        isinstance(geom, dict)
                        and geom.get("type") == "LineString"
                        and geom.get("coordinates")
                    ):
                        trips_for_gpx.append(
                            {
                                "transactionId": f"segment_{i + 1}",
                                "gps": geom,
                                "source": "coverage_route_segment",
                                "startTime": datetime.now(timezone.utc),
                                "endTime": datetime.now(timezone.utc),
                            }
                        )
                data_to_export = trips_for_gpx
            elif fmt == "shapefile":
                features = [
                    geojson_module.Feature(
                        geometry=geom, properties={"segment_idx": i + 1}
                    )
                    for i, geom in enumerate(route_geometry.get("geometries", []))
                    if isinstance(geom, dict)
                ]
                data_to_export = geojson_module.FeatureCollection(features)
            else:  # geojson, json
                data_to_export = route_geometry

        elif geom_type == "LineString":
            # Handle simple A-to-B route
            filename_base = (
                f"{location_display_name.replace(' ', '_').lower()}_single_route"
            )
            if fmt == "gpx":
                data_to_export = [
                    {
                        "transactionId": "single_route",
                        "gps": route_geometry,
                        "source": "single_route",
                        "startTime": datetime.now(timezone.utc),
                        "endTime": datetime.now(timezone.utc),
                    }
                ]
            elif fmt == "shapefile":
                feature = geojson_module.Feature(
                    geometry=route_geometry, properties={"name": "single_route"}
                )
                data_to_export = geojson_module.FeatureCollection([feature])
            else:  # geojson, json
                data_to_export = route_geometry
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported route geometry type: {geom_type}. Must be GeometryCollection or LineString.",
            )

        if not data_to_export:
            raise HTTPException(
                status_code=400,
                detail="No valid geometries found in the route to export.",
            )

        return await create_export_response(data_to_export, fmt, filename_base)

    except ValueError as ve:
        logger.error("ValueError in export_coverage_route_endpoint: %s", str(ve))
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.exception("Error exporting coverage route: %s", str(e))
        raise HTTPException(
            status_code=500, detail="Failed to export coverage route: %s" % str(e)
        )


# --- Other existing export endpoints remain unchanged ---


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
        logger.exception("Error exporting GeoJSON: %s", str(e))
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
        logger.exception("Error exporting GPX: %s", str(e))
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
        filename_base = f"matched_trips_{_date_range_filename_component(request)}"

        cursor = matched_trips_collection.find(query).batch_size(500)

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

        matched_list = await matched_trips_collection.find(query).to_list(length=1000)
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
                detail=error or "No data returned from Overpass",
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
                detail=error or "No boundary data from Overpass",
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
            if include_trips:
                async for trip in trips_collection.find(date_filter).batch_size(500):
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
                        yield processed
            if include_matched_trips:
                async for trip in matched_trips_collection.find(date_filter).batch_size(
                    500
                ):
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
                        processed["trip_type"] = "map_matched"
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
                        if isinstance(v, (dict, list)):
                            row[k] = json.dumps(v, default=default_serializer)
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
                    chunk = json.dumps(
                        item, default=default_serializer, separators=(",", ":")
                    )
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

        # For geojson/shapefile/gpx, fall back to existing helper by materializing a bounded list
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
        logger.error("Export error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    except Exception as e:
        logger.error("Error in advanced export: %s", str(e), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Export failed: {e!s}",
        )
