"""Utility functions for distance calculation.

This module provides utility functions for distance calculations.
For other utilities, use the core modules:
- core.http.session: get_session, cleanup_session, SessionState
- core.http.retry: retry_async
- core.http.geocoding: reverse_geocode_mapbox, reverse_geocode_nominatim, validate_location_osm
- core.async_bridge: run_async_from_sync
- core.math_utils: calculate_circular_average_hour
- geometry_service: GeometryService for distance calculations
"""

from __future__ import annotations

import logging

from constants import METERS_TO_MILES

from geometry_service import GeometryService

logger = logging.getLogger(__name__)

__all__ = [
    "meters_to_miles",
    "calculate_distance",
]


def meters_to_miles(meters: float) -> float:
    """Convert meters to miles.

    Note: For new code, prefer importing METERS_TO_MILES from constants module directly.

    Args:
        meters: Distance in meters.

    Returns:
        Distance in miles.
    """
    return meters * METERS_TO_MILES


def calculate_distance(
    coordinates: list[list[float]],
) -> float:
    """Calculate the total distance of a trip from a list of [lng, lat] coordinates.

    Note: For new code, prefer using GeometryService.calculate_distance() directly.

    Args:
        coordinates: List of [longitude, latitude] coordinate pairs.

    Returns:
        Total distance in miles.
    """
    total_distance_meters = 0.0
    coords: list[list[float]] = coordinates if isinstance(coordinates, list) else []

    if not coords or not isinstance(coords[0], list):
        logger.warning("Invalid coordinates format for distance calculation.")
        return 0.0

    for i in range(len(coords) - 1):
        try:
            lon1, lat1 = coords[i]
            lon2, lat2 = coords[i + 1]
            total_distance_meters += GeometryService.haversine_distance(
                lon1,
                lat1,
                lon2,
                lat2,
                unit="meters",
            )
        except (
            TypeError,
            ValueError,
            IndexError,
        ) as e:
            logger.warning(
                "Skipping coordinate pair due to error: %s - Pair: %s, %s",
                e,
                coords[i],
                (coords[i + 1] if i + 1 < len(coords) else "N/A"),
            )
            continue

    return meters_to_miles(total_distance_meters)
