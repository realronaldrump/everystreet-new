"""Helper functions for parsing and processing timestamps from Bouncie API
data.

Includes optimized functions for converting ISO 8601 strings to timezone-aware
datetime objects and for sorting/filtering coordinate data from Bouncie trip events.
"""

import logging
from datetime import datetime, timezone
from typing import Any

from dateutil import parser

logger = logging.getLogger(__name__)

# Cache for timezone to avoid repeated operations
_UTC_TIMEZONE = timezone.utc


def parse_bouncie_timestamp(ts: str | None) -> datetime | None:
    """Parse an ISO 8601 timestamp from Bouncie with optimized error handling.

    Args:
        ts: ISO 8601 timestamp string or None

    Returns:
        Timezone-aware datetime object or None if parsing fails
    """
    if not ts or not isinstance(ts, str):
        logger.warning(
            "Missing or invalid timestamp field in Bouncie event data."
        )
        return None

    try:
        parsed_time = parser.isoparse(ts)
        # Ensure timezone-aware, default to UTC if naive
        if parsed_time.tzinfo is None:
            parsed_time = parsed_time.replace(tzinfo=_UTC_TIMEZONE)
        return parsed_time
    except (ValueError, TypeError, OverflowError) as e:
        logger.warning("Failed to parse timestamp '%s': %s", ts, e)
        return None


def sort_and_filter_trip_coordinates(
    trip_data: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Extract, sort, and deduplicate trip coordinates from Bouncie event chunks.

    Optimized version with better validation and performance improvements.

    Args:
        trip_data: List of trip data dictionaries with timestamp, lat, lon

    Returns:
        Sorted list of valid coordinate points with deduplication
    """
    if not trip_data or not isinstance(trip_data, list):
        logger.warning("Invalid trip_data provided: expected non-empty list")
        return []

    seen_coordinates = set()
    valid_points = []

    for i, point in enumerate(trip_data):
        if not isinstance(point, dict):
            logger.warning(
                "Skipping invalid point at index %d: not a dictionary", i
            )
            continue

        # Parse timestamp
        timestamp_str = point.get("timestamp")
        parsed_timestamp = parse_bouncie_timestamp(timestamp_str)
        if parsed_timestamp is None:
            logger.warning("Skipping point at index %d: invalid timestamp", i)
            continue

        # Extract GPS coordinates with validation
        gps_data = point.get("gps", {})
        if not isinstance(gps_data, dict):
            logger.warning(
                "Skipping point at index %d: invalid GPS data format", i
            )
            continue

        lat = gps_data.get("lat")
        lon = gps_data.get("lon")

        # Validate coordinate values
        if (
            lat is None
            or lon is None
            or not isinstance(lat, (int, float))
            or not isinstance(lon, (int, float))
        ):
            logger.warning(
                "Skipping point at index %d: missing or invalid coordinates", i
            )
            continue

        # Validate coordinate ranges
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            logger.warning(
                "Skipping point at index %d: coordinates out of valid range (lat=%s, lon=%s)",
                i,
                lat,
                lon,
            )
            continue

        # Create deduplication key (rounded to avoid floating point precision issues)
        dedup_key = (
            parsed_timestamp.isoformat(),
            round(lat, 6),  # ~0.1m precision
            round(lon, 6),
        )

        if dedup_key not in seen_coordinates:
            seen_coordinates.add(dedup_key)
            valid_points.append(
                {
                    "timestamp": parsed_timestamp,
                    "lat": lat,
                    "lon": lon,
                }
            )

    # Sort by timestamp for chronological order
    valid_points.sort(key=lambda point: point["timestamp"])

    logger.debug(
        "Processed %d points, filtered to %d valid unique points",
        len(trip_data),
        len(valid_points),
    )

    return valid_points
