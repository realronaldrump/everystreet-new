"""Export utilities for trip data.

Provides functions to convert lists of trip dictionaries into standard
geospatial formats (GeoJSON, GPX, and Shapefile) for export and
interoperability with other mapping tools and applications.
"""

import io
import json
import logging
import os
import tempfile
import zipfile
from datetime import datetime
from typing import Any

import geopandas as gpd
import gpxpy
import gpxpy.gpx
from bson import ObjectId
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)


def default_serializer(obj: Any) -> str:
    """Custom JSON serializer to handle datetime and ObjectId types.

    Args:
        obj: The object to serialize

    Returns:
        str: String representation of the object
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, ObjectId):
        return str(obj)
    return str(obj)


async def create_geojson(
    trips: list[dict[str, Any]],
) -> str:
    """Convert trip dictionaries to a GeoJSON FeatureCollection string.

    Args:
        trips: List of trip dictionaries

    Returns:
        str: A GeoJSON string representing the trips
    """
    features = []

    for trip in trips:
        try:
            gps_data = trip.get("gps")
            if not gps_data:
                logger.warning(
                    "Trip %s missing GPS data, skipping",
                    trip.get("transactionId", "?"),
                )
                continue

            if isinstance(gps_data, str):
                try:
                    gps_data = json.loads(gps_data)
                except json.JSONDecodeError as e:
                    logger.error(
                        "Error parsing GPS for trip %s: %s",
                        trip.get("transactionId", "?"),
                        e,
                    )
                    continue

            properties_dict = {}
            for key, value in trip.items():
                if key != "gps" and value is not None:
                    properties_dict[key] = value

            feature = {
                "type": "Feature",
                "geometry": gps_data,
                "properties": properties_dict,
            }
            features.append(feature)

        except Exception as e:
            logger.error(
                "Error processing trip %s for GeoJSON: %s",
                trip.get("transactionId", "?"),
                e,
            )

    fc = {
        "type": "FeatureCollection",
        "features": features,
    }

    if not features:
        logger.warning(
            "No valid features generated from %d trips",
            len(trips),
        )
    else:
        logger.info(
            "Created GeoJSON with %d features from %d trips",
            len(features),
            len(trips),
        )

    return json.dumps(fc, default=default_serializer)


async def create_gpx(
    trips: list[dict[str, Any]],
) -> str:
    """Convert trip dictionaries to a GPX file (XML string).

    Args:
        trips: List of trip dictionaries

    Returns:
        str: A GPX XML string representing the trips
    """
    gpx = gpxpy.gpx.GPX()
    trip_count = 0

    for trip in trips:
        try:
            gps_data = trip.get("gps")
            if not gps_data:
                logger.warning(
                    "Trip %s missing GPS data, skipping",
                    trip.get("transactionId", "?"),
                )
                continue

            if isinstance(gps_data, str):
                try:
                    gps_data = json.loads(gps_data)
                except json.JSONDecodeError as e:
                    logger.error(
                        "Error parsing GPS for trip %s: %s",
                        trip.get("transactionId", "?"),
                        e,
                    )
                    continue

            track = gpxpy.gpx.GPXTrack()
            track.name = f"Trip {trip.get('transactionId', 'UNKNOWN')}"

            if trip.get("startLocation") and trip.get("destination"):
                track.description = f"From {trip.get('startLocation')} to {
                    trip.get('destination')
                }"

            gpx.tracks.append(track)

            segment = gpxpy.gpx.GPXTrackSegment()
            track.segments.append(segment)

            if gps_data.get("type") == "LineString":
                for coord in gps_data.get("coordinates", []):
                    if len(coord) >= 2:
                        lon, lat = (
                            coord[0],
                            coord[1],
                        )
                        segment.points.append(
                            gpxpy.gpx.GPXTrackPoint(lat, lon)
                        )
            elif gps_data.get("type") == "Point":
                coords = gps_data.get("coordinates", [])
                if len(coords) >= 2:
                    lon, lat = (
                        coords[0],
                        coords[1],
                    )
                    segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

            if segment.points:
                trip_count += 1

        except Exception as e:
            logger.error(
                "Error processing trip %s for GPX: %s",
                trip.get("transactionId", "?"),
                e,
            )

    if trip_count == 0:
        logger.warning(
            "No valid tracks generated from %d trips",
            len(trips),
        )
    else:
        logger.info(
            "Created GPX with %d tracks from %d trips",
            trip_count,
            len(trips),
        )

    return gpx.to_xml()


async def create_shapefile(
    geojson_data: dict[str, Any], output_name: str
) -> io.BytesIO:
    """Convert GeoJSON data to a shapefile ZIP archive.

    Args:
        geojson_data: GeoJSON data dictionary
        output_name: Base name for the output files

    Returns:
        io.BytesIO: Buffer containing the zipped shapefile
    """
    try:
        gdf = gpd.GeoDataFrame.from_features(geojson_data["features"])

        with tempfile.TemporaryDirectory() as tmp_dir:
            out_path = os.path.join(tmp_dir, f"{output_name}.shp")
            gdf.to_file(out_path, driver="ESRI Shapefile")

            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in os.listdir(tmp_dir):
                    with open(
                        os.path.join(tmp_dir, f),
                        "rb",
                    ) as fh:
                        zf.writestr(
                            f"{output_name}/{f}",
                            fh.read(),
                        )

            buf.seek(0)
            return buf
    except Exception as e:
        logger.error("Error creating shapefile: %s", e)
        raise


async def export_geojson_response(data, filename: str) -> StreamingResponse:
    """Create a StreamingResponse with GeoJSON content.

    Args:
        data: Trip data or GeoJSON data
        filename: Filename for the download

    Returns:
        StreamingResponse: Formatted response with GeoJSON content
    """
    if isinstance(data, list):
        content = await create_geojson(data)
    else:
        content = json.dumps(data, default=default_serializer)

    return StreamingResponse(
        io.BytesIO(content.encode()),
        media_type="application/geo+json",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}.geojson"'
        },
    )


async def export_gpx_response(data, filename: str) -> StreamingResponse:
    """Create a StreamingResponse with GPX content.

    Args:
        data: Trip data
        filename: Filename for the download

    Returns:
        StreamingResponse: Formatted response with GPX content
    """
    if isinstance(data, list):
        content = await create_gpx(data)
    else:
        trips = []
        for feature in data.get("features", []):
            trips.append(
                {
                    "transactionId": feature.get("properties", {}).get(
                        "id", "unknown"
                    ),
                    "gps": feature.get("geometry"),
                    "startLocation": feature.get("properties", {}).get(
                        "startLocation"
                    ),
                    "destination": feature.get("properties", {}).get(
                        "destination"
                    ),
                }
            )
        content = await create_gpx(trips)

    return StreamingResponse(
        io.BytesIO(content.encode()),
        media_type="application/gpx+xml",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}.gpx"'
        },
    )


async def export_shapefile_response(
    geojson_data, filename: str
) -> StreamingResponse:
    """Create a StreamingResponse with Shapefile content (ZIP).

    Args:
        geojson_data: GeoJSON data to convert to shapefile
        filename: Filename for the download

    Returns:
        StreamingResponse: Formatted response with zipped shapefile content
    """
    buffer = await create_shapefile(geojson_data, filename)

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}.zip"'
        },
    )


async def create_export_response(
    data: list[dict[str, Any]] | dict[str, Any],
    fmt: str,
    filename_base: str,
    include_gps_in_csv: bool = False,
    flatten_location_fields: bool = True,
) -> StreamingResponse:
    """Create a StreamingResponse with data in the requested format.

    Args:
        data: Trip data
        fmt: Format to export (geojson, gpx, json, csv, shapefile)
        filename_base: Base filename for the download
        include_gps_in_csv: Whether to include GPS data in CSV exports
        flatten_location_fields: Whether to flatten location fields in CSV exports

    Returns:
        StreamingResponse: Response with appropriate content and headers
    """
    fmt = fmt.lower()

    if fmt == "geojson":
        return await export_geojson_response(data, filename_base)
    if fmt == "gpx":
        return await export_gpx_response(data, filename_base)
    if fmt == "shapefile":
        if isinstance(data, dict) and data.get("type") == "FeatureCollection":
            geojson_data = data
        else:
            geojson_string = await create_geojson(data)
            geojson_data = json.loads(geojson_string)

        return await export_shapefile_response(geojson_data, filename_base)
    if fmt == "json":
        if isinstance(data, list):
            content = json.dumps(data, default=default_serializer)
        else:
            content = json.dumps(data, default=default_serializer)

        return StreamingResponse(
            io.BytesIO(content.encode()),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.json"'
            },
        )
    if fmt == "csv":
        from io import StringIO

        if not isinstance(data, list):
            if (
                isinstance(data, dict)
                and data.get("type") == "FeatureCollection"
            ):
                trips = []
                for feature in data.get("features", []):
                    if feature.get("properties"):
                        trips.append(feature["properties"])
                data = trips
            else:
                data = [data]

        if not data:
            output = StringIO("No data to export")
        else:
            csv_content = await create_csv_export(
                data,
                include_gps_in_csv=include_gps_in_csv,
                flatten_location_fields=flatten_location_fields,
            )
            output = StringIO(csv_content)

        return StreamingResponse(
            output,
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.csv"'
            },
        )
    raise ValueError(f"Unsupported export format: {fmt}")


def extract_date_range_string(
    query: dict[str, Any],
) -> str:
    """Extract a date range string from a query dictionary for use in
    filenames.

    Args:
        query: MongoDB query dictionary

    Returns:
        str: Formatted date range string (YYYYMMDD-YYYYMMDD)
    """
    start_date = (
        query["startTime"].get("$gte")
        if isinstance(query["startTime"], dict)
        else None
    )
    end_date = (
        query["startTime"].get("$lte")
        if isinstance(query["startTime"], dict)
        else None
    )

    if start_date and end_date:
        return f"{start_date.strftime('%Y%m%d')}-{end_date.strftime('%Y%m%d')}"
    return datetime.now().strftime("%Y%m%d")


def get_location_filename(
    location: dict[str, Any],
) -> str:
    """Create a safe filename from a location dictionary.

    Args:
        location: Location dictionary with display_name

    Returns:
        str: Safe filename string
    """
    return (
        location.get("display_name", "")
        .split(",")[0]
        .strip()
        .replace(" ", "_")
        .lower()
    )


async def process_trip_for_export(
    trip: dict[str, Any],
    include_basic_info: bool = True,
    include_locations: bool = True,
    include_telemetry: bool = True,
    include_geometry: bool = True,
    include_meta: bool = True,
    include_custom: bool = True,
) -> dict[str, Any]:
    """Process a trip dictionary based on field preferences for export.

    Args:
        trip: Original trip dictionary
        include_*: Booleans indicating which fields to include

    Returns:
        Dict: Processed trip with only the requested fields
    """
    result = {}

    basic_info_fields = [
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

    location_fields = [
        "startLocation",
        "destination",
        "startAddress",
        "endAddress",
        "startPoint",
        "endPoint",
        "state",
        "city",
    ]

    telemetry_fields = [
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

    geometry_fields = [
        "gps",
        "path",
        "simplified_path",
        "route",
        "geometry",
    ]

    meta_fields = [
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

    custom_fields = [
        "notes",
        "tags",
        "category",
        "purpose",
        "customFields",
    ]

    all_fields = []
    if include_basic_info:
        all_fields.extend(basic_info_fields)
    if include_locations:
        all_fields.extend(location_fields)
    if include_telemetry:
        all_fields.extend(telemetry_fields)
    if include_geometry:
        all_fields.extend(geometry_fields)
    if include_meta:
        all_fields.extend(meta_fields)
    if include_custom:
        all_fields.extend(custom_fields)

    for field in all_fields:
        if field in trip:
            result[field] = trip[field]

    if "_id" not in result and "_id" in trip:
        result["_id"] = trip["_id"]

    return result


async def create_csv_export(
    trips: list[dict[str, Any]],
    include_gps_in_csv: bool = False,
    flatten_location_fields: bool = True,
) -> str:
    """Convert trip dictionaries to CSV format.

    Args:
        trips: List of trip dictionaries
        include_gps_in_csv: Whether to include GPS data as JSON strings
        flatten_location_fields: Whether to flatten location fields into separate columns

    Returns:
        str: CSV data as a string
    """
    if not trips:
        return "No data to export"

    import csv
    from io import StringIO

    output = StringIO()

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

    fieldnames = set()
    for trip in trips:
        fieldnames.update(trip.keys())

    if flatten_location_fields:
        fieldnames.update(location_fields)
        if "startLocation" in fieldnames:
            fieldnames.remove("startLocation")
        if "destination" in fieldnames:
            fieldnames.remove("destination")

    fieldnames = sorted(fieldnames)

    priority_fields = [
        "_id",
        "transactionId",
        "trip_id",
        "trip_type",
        "startTime",
        "endTime",
    ] + (location_fields if flatten_location_fields else [])

    for field in reversed(priority_fields):
        if field in fieldnames:
            fieldnames.remove(field)
            fieldnames.insert(0, field)

    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()

    for trip in trips:
        flat_trip = {}
        for key, value in trip.items():
            if key in [
                "gps",
                "geometry",
                "path",
                "simplified_path",
                "route",
            ]:
                if include_gps_in_csv:
                    flat_trip[key] = json.dumps(
                        value,
                        default=default_serializer,
                    )
                else:
                    flat_trip[key] = (
                        "[Geometry data not included in CSV format]"
                    )
            elif flatten_location_fields and key in [
                "startLocation",
                "destination",
            ]:
                pass
            elif isinstance(value, (dict, list)):
                flat_trip[key] = json.dumps(
                    value,
                    default=default_serializer,
                )
            elif isinstance(value, datetime):
                flat_trip[key] = value.isoformat()
            else:
                flat_trip[key] = value

        if flatten_location_fields:
            start_loc = trip.get("startLocation", {})
            if isinstance(start_loc, str):
                try:
                    start_loc = json.loads(start_loc)
                except json.JSONDecodeError:
                    start_loc = {}

            if isinstance(start_loc, dict):
                flat_trip["startLocation_formatted_address"] = start_loc.get(
                    "formatted_address", ""
                )

                addr_comps = start_loc.get("address_components", {})
                if isinstance(addr_comps, dict):
                    flat_trip["startLocation_street_number"] = addr_comps.get(
                        "street_number", ""
                    )
                    flat_trip["startLocation_street"] = addr_comps.get(
                        "street", ""
                    )
                    flat_trip["startLocation_city"] = addr_comps.get(
                        "city", ""
                    )
                    flat_trip["startLocation_county"] = addr_comps.get(
                        "county", ""
                    )
                    flat_trip["startLocation_state"] = addr_comps.get(
                        "state", ""
                    )
                    flat_trip["startLocation_postal_code"] = addr_comps.get(
                        "postal_code", ""
                    )
                    flat_trip["startLocation_country"] = addr_comps.get(
                        "country", ""
                    )

                coords = start_loc.get("coordinates", {})
                if isinstance(coords, dict):
                    flat_trip["startLocation_lat"] = coords.get("lat", "")
                    flat_trip["startLocation_lng"] = coords.get("lng", "")

            dest = trip.get("destination", {})
            if isinstance(dest, str):
                try:
                    dest = json.loads(dest)
                except json.JSONDecodeError:
                    dest = {}

            if isinstance(dest, dict):
                flat_trip["destination_formatted_address"] = dest.get(
                    "formatted_address", ""
                )

                addr_comps = dest.get("address_components", {})
                if isinstance(addr_comps, dict):
                    flat_trip["destination_street_number"] = addr_comps.get(
                        "street_number", ""
                    )
                    flat_trip["destination_street"] = addr_comps.get(
                        "street", ""
                    )
                    flat_trip["destination_city"] = addr_comps.get("city", "")
                    flat_trip["destination_county"] = addr_comps.get(
                        "county", ""
                    )
                    flat_trip["destination_state"] = addr_comps.get(
                        "state", ""
                    )
                    flat_trip["destination_postal_code"] = addr_comps.get(
                        "postal_code", ""
                    )
                    flat_trip["destination_country"] = addr_comps.get(
                        "country", ""
                    )

                coords = dest.get("coordinates", {})
                if isinstance(coords, dict):
                    flat_trip["destination_lat"] = coords.get("lat", "")
                    flat_trip["destination_lng"] = coords.get("lng", "")

        writer.writerow(flat_trip)

    return output.getvalue()
