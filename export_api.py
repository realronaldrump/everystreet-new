import io
import json
import logging
from datetime import datetime, timezone
from typing import Any

import geojson as geojson_module
from fastapi import APIRouter, Body, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from db import (
    build_query_from_request,
    db_manager,
    find_one_with_retry,
    find_with_retry,
    parse_query_date,
)
from export_helpers import (
    create_csv_export,
    create_export_response,
    default_serializer,
    export_gpx_response,
    extract_date_range_string,
    get_location_filename,
    process_trip_for_export,
)
from osm_utils import generate_geojson_osm

logger = logging.getLogger(__name__)
router = APIRouter()

trips_collection = db_manager.db["trips"]
matched_trips_collection = db_manager.db["matched_trips"]


async def _load_trips_for_export(
    request: Request,
    not_found_message: str,
) -> list[dict[str, Any]]:
    """Fetch trips for export, raising a 404 if none are found."""
    query = await build_query_from_request(request)
    trips = await find_with_retry(trips_collection, query)

    if not trips:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=not_found_message,
        )

    return trips


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

    except HTTPException as http_exc:
        raise http_exc
    except ValueError as ve:
        logger.error(f"ValueError in export_coverage_route_endpoint: {str(ve)}")
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.exception(f"Error exporting coverage route: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Failed to export coverage route: {str(e)}"
        )


# --- Other existing export endpoints remain unchanged ---


@router.get("/export/geojson")
async def export_geojson(request: Request):
    """Export trips as GeoJSON."""
    try:
        trips = await _load_trips_for_export(
            request,
            "No trips found for filters.",
        )
        return await create_export_response(trips, "geojson", "all_trips")
    except HTTPException:
        raise
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
        trips = await _load_trips_for_export(request, "No trips found.")
        return await export_gpx_response(trips, "trips")
    except HTTPException:
        raise
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
        all_trips = await find_with_retry(trips_collection, {})

        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"all_trips_{current_time}"

        if fmt == "json":
            return JSONResponse(
                content=json.loads(
                    json.dumps(
                        all_trips,
                        default=default_serializer,
                    ),
                ),
            )

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

        if "startTime" not in query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or missing date range",
            )

        all_trips = await find_with_retry(trips_collection, query)

        date_range = extract_date_range_string(query)
        filename_base = f"trips_{date_range}"

        return await create_export_response(all_trips, fmt, filename_base)
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

        if "startTime" not in query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or missing date range",
            )

        matched = await find_with_retry(matched_trips_collection, query)

        date_range = extract_date_range_string(query)
        filename_base = f"matched_trips_{date_range}"

        return await create_export_response(matched, fmt, filename_base)
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

        date_filter = None
        if start_date_str and end_date_str:
            start_date = parse_query_date(start_date_str)
            end_date = parse_query_date(end_date_str, end_of_day=True)
            if start_date and end_date:
                date_filter = {
                    "startTime": {
                        "$gte": start_date,
                        "$lte": end_date,
                    },
                }

        trips = []

        if include_trips:
            query = date_filter or {}
            regular_trips = await find_with_retry(trips_collection, query)

            for trip in regular_trips:
                processed_trip = await process_trip_for_export(
                    trip,
                    include_basic_info,
                    include_locations,
                    include_telemetry,
                    include_geometry,
                    include_meta,
                    include_custom,
                )
                if processed_trip:
                    processed_trip["trip_type"] = trip.get("source", "unknown")
                    trips.append(processed_trip)

        if include_matched_trips:
            query = date_filter or {}
            matched_trips_list = await find_with_retry(
                matched_trips_collection,
                query,
            )

            for trip in matched_trips_list:
                processed_trip = await process_trip_for_export(
                    trip,
                    include_basic_info,
                    include_locations,
                    include_telemetry,
                    include_geometry,
                    include_meta,
                    include_custom,
                )
                if processed_trip:
                    processed_trip["trip_type"] = "map_matched"
                    trips.append(processed_trip)

        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"trips_export_{current_time}"

        if fmt == "csv":
            csv_data = await create_csv_export(
                trips,
                include_gps_in_csv=include_gps_in_csv,
                flatten_location_fields=flatten_location_fields,
            )
            return StreamingResponse(
                io.StringIO(csv_data),
                media_type="text/csv",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.csv"',
                },
            )

        if fmt == "json":
            return JSONResponse(
                content=json.loads(
                    json.dumps(
                        trips,
                        default=default_serializer,
                    ),
                ),
            )

        return await create_export_response(
            trips,
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
