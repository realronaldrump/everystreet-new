"""
Streaming service for efficient export data generation.

Provides async generators for streaming large datasets without loading all data into
memory at once.
"""

import csv
import json
import logging
from collections.abc import AsyncIterator
from datetime import datetime
from io import StringIO
from typing import Any

from fastapi import Request
from fastapi.responses import StreamingResponse

from db import parse_query_date
from export_helpers import (
    CSV_BASE_FIELDS,
    CSV_GEOMETRY_FIELDS,
    CSV_LOCATION_FIELDS,
    create_gpx,
    flatten_trip_for_csv,
)
from geometry_service import GeometryService

logger = logging.getLogger(__name__)


def _ensure_dict(item: Any) -> dict[str, Any]:
    """Convert item to dictionary if it is a Pydantic model."""
    if hasattr(item, "model_dump"):
        return item.model_dump(by_alias=True)
    if hasattr(item, "dict"):
        return item.dict(by_alias=True)
    return item


class StreamingService:
    """Service for streaming export data in various formats."""

    @staticmethod
    def get_date_range_filename(request: Request) -> str:
        """Generate filename component from request date range."""
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

    @staticmethod
    async def stream_geojson(cursor, geometry_field: str = "gps") -> AsyncIterator[str]:
        """Stream GeoJSON FeatureCollection from cursor."""
        yield '{"type":"FeatureCollection","features":['
        first = True
        async for trip in cursor:
            try:
                trip = _ensure_dict(trip)
                geom = GeometryService.geometry_from_document(trip, geometry_field)
                if not geom:
                    continue
                props = {k: v for k, v in trip.items() if k != "gps"}
                feature = GeometryService.feature_from_geometry(geom, props)
                chunk = json.dumps(feature, separators=(",", ":"))
                if not first:
                    yield ","
                yield chunk
                first = False
            except Exception as e:
                logger.warning("Skipping trip in GeoJSON stream: %s", e)
                continue
        yield "]}"

    @staticmethod
    async def stream_json_array(cursor) -> AsyncIterator[str]:
        """Stream JSON array from cursor."""
        yield "["
        first = True
        async for doc in cursor:
            try:
                doc = _ensure_dict(doc)
                chunk = json.dumps(doc, separators=(",", ":"), default=str)
                if not first:
                    yield ","
                yield chunk
                first = False
            except Exception as e:
                logger.warning("Skipping document in JSON stream: %s", e)
                continue
        yield "]"

    @staticmethod
    async def stream_gpx(cursor) -> AsyncIterator[str]:
        """
        Stream GPX from cursor.

        Note: GPX requires collecting trips first due to library structure.
        """
        trips = []
        async for trip in cursor:
            trips.append(_ensure_dict(trip))

        gpx_content = await create_gpx(trips)
        yield gpx_content

    @staticmethod
    async def stream_csv(
        cursor,
        include_gps_in_csv: bool = False,
        flatten_location_fields: bool = True,
    ) -> AsyncIterator[str]:
        """Stream CSV data from cursor with predefined headers."""
        # Build fieldnames from shared constants
        base_fields = list(CSV_BASE_FIELDS)
        location_fields = list(CSV_LOCATION_FIELDS) if flatten_location_fields else []

        if not flatten_location_fields:
            base_fields.extend(["startLocation", "destination"])

        fieldnames = base_fields + location_fields + list(CSV_GEOMETRY_FIELDS)

        buf = StringIO()
        writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")

        writer.writeheader()
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)

        async for doc in cursor:
            try:
                doc = _ensure_dict(doc)
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
                logger.warning("Skipping document in CSV stream: %s", e)
                continue

    @staticmethod
    def create_streaming_response(
        generator: AsyncIterator[str],
        media_type: str,
        filename: str,
    ) -> StreamingResponse:
        """Create a StreamingResponse with proper headers."""
        return StreamingResponse(
            generator,
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @classmethod
    async def export_format(
        cls,
        cursor,
        fmt: str,
        filename_base: str,
        geometry_field: str = "gps",
        include_gps_in_csv: bool = False,
        flatten_location_fields: bool = True,
    ) -> StreamingResponse | None:
        """
        Export cursor data in specified format.

        Returns StreamingResponse for supported streaming formats, or None if format
        requires non-streaming fallback.
        """
        fmt_lower = fmt.lower()

        if fmt_lower == "json":
            stream = cls.stream_json_array(cursor)
            return cls.create_streaming_response(
                stream,
                "application/json",
                f"{filename_base}.json",
            )

        if fmt_lower == "geojson":
            stream = cls.stream_geojson(cursor, geometry_field)
            return cls.create_streaming_response(
                stream,
                "application/geo+json",
                f"{filename_base}.geojson",
            )

        if fmt_lower == "gpx":
            stream = cls.stream_gpx(cursor)
            return cls.create_streaming_response(
                stream,
                "application/gpx+xml",
                f"{filename_base}.gpx",
            )

        if fmt_lower == "csv":
            stream = cls.stream_csv(cursor, include_gps_in_csv, flatten_location_fields)
            return cls.create_streaming_response(
                stream,
                "text/csv",
                f"{filename_base}.csv",
            )

        # Format not supported for streaming
        return None
