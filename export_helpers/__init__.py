"""
Export helpers package.

Provides utilities for converting trip data to various geospatial formats
(GeoJSON, GPX, Shapefile, CSV) for export and interoperability with other
mapping tools and applications.

This package is organized into the following modules:
- base: Constants and shared utilities
- geojson: GeoJSON creation functions
- gpx: GPX creation functions
- shapefile: Shapefile creation functions
- csv_export: CSV creation and flattening functions
- trip_processing: Trip data filtering and processing
- responses: FastAPI StreamingResponse factory functions
"""

# Base utilities and constants
from .base import (
    CSV_BASE_FIELDS,
    CSV_GEOMETRY_FIELDS,
    CSV_LOCATION_FIELDS,
    flatten_location,
    get_location_filename,
    normalize_location_object,
    serialize_value,
)

# CSV export
from .csv_export import (
    create_csv_export,
    flatten_trip_for_csv,
)

# GeoJSON export
from .geojson import create_geojson

# GPX export
from .gpx import (
    build_gpx_from_coords,
    create_gpx,
)

# HTTP responses
from .responses import (
    create_export_response,
    export_geojson_response,
    export_gpx_response,
    export_shapefile_response,
)

# Shapefile export
from .shapefile import create_shapefile

# Trip processing
from .trip_processing import (
    BASIC_INFO_FIELDS,
    CUSTOM_FIELDS,
    GEOMETRY_FIELDS,
    LOCATION_FIELDS,
    META_FIELDS,
    TELEMETRY_FIELDS,
    process_trip_for_export,
)

__all__ = [
    # Base
    "CSV_BASE_FIELDS",
    "CSV_GEOMETRY_FIELDS",
    "CSV_LOCATION_FIELDS",
    "flatten_location",
    "get_location_filename",
    "normalize_location_object",
    "serialize_value",
    # GeoJSON
    "create_geojson",
    # GPX
    "build_gpx_from_coords",
    "create_gpx",
    # Shapefile
    "create_shapefile",
    # CSV
    "create_csv_export",
    "flatten_trip_for_csv",
    # Trip processing
    "BASIC_INFO_FIELDS",
    "CUSTOM_FIELDS",
    "GEOMETRY_FIELDS",
    "LOCATION_FIELDS",
    "META_FIELDS",
    "TELEMETRY_FIELDS",
    "process_trip_for_export",
    # Responses
    "create_export_response",
    "export_geojson_response",
    "export_gpx_response",
    "export_shapefile_response",
]
