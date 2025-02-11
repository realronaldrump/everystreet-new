import dateutil.parser
from datetime import datetime, timezone
import logging
from typing import Optional, Tuple, List, Dict

logger = logging.getLogger(__name__)


def parse_bouncie_timestamp(ts: str) -> Optional[datetime]:
    """
    Parse an ISO 8601 timestamp from Bouncie's API ensuring it is timezone-aware.
    Returns None if parsing fails.
    """
    if not ts:
        logger.warning("Missing timestamp field in Bouncie API response.")
        return None
    try:
        parsed_time = dateutil.parser.isoparse(ts)
        # Ensure the parsed time is timezone-aware (default to UTC if missing)
        return (
            parsed_time
            if parsed_time.tzinfo
            else parsed_time.replace(tzinfo=timezone.utc)
        )
    except Exception as e:
        logger.warning("Failed to parse timestamp '%s': %s", ts, e)
        return None


def get_trip_timestamps(
    event_data: dict,
) -> Tuple[Optional[datetime], Optional[datetime]]:
    """
    Extract startTime and endTime from Bouncie webhook event data.
    Logs a warning if any timestamp is missing or invalid.
    """
    start_time = None
    end_time = None
    if "start" in event_data and event_data["start"].get("timestamp"):
        start_time = parse_bouncie_timestamp(event_data["start"]["timestamp"])
        if start_time is None:
            logger.warning(
                "Invalid or missing startTime in event: %s", event_data
            )
    if "end" in event_data and event_data["end"].get("timestamp"):
        end_time = parse_bouncie_timestamp(event_data["end"]["timestamp"])
        if end_time is None:
            logger.warning(
                "Invalid or missing endTime in event: %s", event_data
            )
    return start_time, end_time


def sort_and_filter_trip_coordinates(trip_data: List[dict]) -> List[Dict]:
    """
    Extract, sort, and deduplicate trip coordinates based on timestamps.
    Each valid point is a dict with keys: "timestamp", "lat", and "lon".
    """
    seen = set()
    valid_points = []
    for point in trip_data:
        ts = parse_bouncie_timestamp(point.get("timestamp"))
        lat = point.get("gps", {}).get("lat")
        lon = point.get("gps", {}).get("lon")
        if ts is None or lat is None or lon is None:
            logger.warning("Skipping invalid tripData point: %s", point)
            continue
        key = (ts.isoformat(), lat, lon)
        if key not in seen:
            seen.add(key)
            valid_points.append({"timestamp": ts, "lat": lat, "lon": lon})
    return sorted(valid_points, key=lambda x: x["timestamp"])
