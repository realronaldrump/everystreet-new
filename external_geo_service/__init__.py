"""
External Geo Service Package.

This package provides geocoding and map matching services using Mapbox and Nominatim
APIs.
"""

from .geocoding import GeocodingService
from .map_matching import MapMatchingService
from .rate_limiting import map_match_semaphore, mapbox_rate_limiter
from .schemas import (
    get_empty_location_schema,
    parse_mapbox_response,
    parse_nominatim_response,
)
from .timestamp_utils import extract_timestamps_for_coordinates

__all__ = [
    # Individual services
    "GeocodingService",
    "MapMatchingService",
    # Utilities
    "extract_timestamps_for_coordinates",
    "get_empty_location_schema",
    "map_match_semaphore",
    # Rate limiting
    "mapbox_rate_limiter",
    "parse_mapbox_response",
    "parse_nominatim_response",
]
