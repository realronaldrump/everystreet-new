"""
HTTP response utilities for export.

Provides functions to create StreamingResponse objects for various export formats.
"""

import io
import json
from io import StringIO
from typing import Any

from fastapi.responses import StreamingResponse

from .csv_export import create_csv_export
from .geojson import create_geojson
from .gpx import create_gpx
from .shapefile import create_shapefile


async def export_geojson_response(data, filename: str) -> StreamingResponse:
    """
    Create a StreamingResponse with GeoJSON content.

    Args:
        data: Trip data or GeoJSON data
        filename: Filename for the download

    Returns:
        StreamingResponse: Formatted response with GeoJSON content
    """
    if isinstance(data, list):
        content = await create_geojson(data)
    else:
        content = json.dumps(data)

    return StreamingResponse(
        io.BytesIO(content.encode()),
        media_type="application/geo+json",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}.geojson"',
        },
    )


async def export_gpx_response(data, filename: str) -> StreamingResponse:
    """
    Create a StreamingResponse with GPX content.

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
                        "id",
                        "unknown",
                    ),
                    "gps": feature.get("geometry"),
                    "startLocation": feature.get("properties", {}).get(
                        "startLocation",
                    ),
                    "destination": feature.get("properties", {}).get(
                        "destination",
                    ),
                },
            )
        content = await create_gpx(trips)

    return StreamingResponse(
        io.BytesIO(content.encode()),
        media_type="application/gpx+xml",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}.gpx"',
        },
    )


async def export_shapefile_response(
    geojson_data,
    filename: str,
) -> StreamingResponse:
    """
    Create a StreamingResponse with Shapefile content (ZIP).

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
            "Content-Disposition": f'attachment; filename="{filename}.zip"',
        },
    )


async def create_export_response(
    data: list[dict[str, Any]] | dict[str, Any],
    fmt: str,
    filename_base: str,
    include_gps_in_csv: bool = False,
    flatten_location_fields: bool = True,
) -> StreamingResponse:
    """
    Create a StreamingResponse with data in the requested format.

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
        content = json.dumps(data)

        return StreamingResponse(
            io.BytesIO(content.encode()),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.json"',
            },
        )
    if fmt == "csv":
        if not isinstance(data, list):
            if isinstance(data, dict) and data.get("type") == "FeatureCollection":
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
                "Content-Disposition": f'attachment; filename="{filename_base}.csv"',
            },
        )
    msg = f"Unsupported export format: {fmt}"
    raise ValueError(msg)
