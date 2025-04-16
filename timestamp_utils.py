"""Helper functions for parsing and processing timestamps from Bouncie API
data.

Includes functions for converting ISO 8601 strings to timezone-aware datetime
objects and for sorting/filtering coordinate data from Bouncie trip events.
"""

import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict
from dateutil import parser

logger = logging.getLogger(__name__)


def parse_bouncie_timestamp(ts: str) -> Optional[datetime]:
    """Parse an ISO 8601 timestamp from Bouncie, ensure it's timezone-aware,
    default UTC."""
    if not ts:
        logger.warning("Missing timestamp field in Bouncie event data.")
        return None

    try:
        parsed_time = parser.isoparse(ts)
        if parsed_time.tzinfo is None:
            parsed_time = parsed_time.astimezone(timezone.utc)
        return parsed_time
    except Exception as e:
        logger.warning("Failed to parse timestamp '%s': %s", ts, e)
        return None


def sort_and_filter_trip_coordinates(trip_data: List[dict]) -> List[Dict]:
    """Extract, sort, and deduplicate trip coordinates from 'tripData' Bouncie
    event chunks Each point is a dict with 'timestamp', 'lat', 'lon'."""
    seen = set()
    valid_points = []

    for point in trip_data:
        ts = parse_bouncie_timestamp(point.get("timestamp"))
        gps = point.get("gps", {})
        lat = gps.get("lat")
        lon = gps.get("lon")

        if ts is None or lat is None or lon is None:
            logger.warning("Skipping invalid tripData point: %s", point)
            continue

        key = (ts.isoformat(), lat, lon)
        if key not in seen:
            seen.add(key)
            valid_points.append({"timestamp": ts, "lat": lat, "lon": lon})

    return sorted(valid_points, key=lambda x: x["timestamp"])
