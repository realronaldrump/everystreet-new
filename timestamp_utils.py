import dateutil.parser
from datetime import datetime, timezone
import logging

logger = logging.getLogger(__name__)

def parse_bouncie_timestamp(ts: str) -> datetime:
    """
    Parses an ISO 8601 timestamp from Bouncie's API and ensures it is timezone-aware.

    If parsing fails, it logs a warning and returns None instead of defaulting to current time.
    """
    if not ts:
        logger.warning("Missing timestamp field in Bouncie API response.")
        return None  # Do NOT return current time; return None to signal missing data

    try:
        parsed_time = dateutil.parser.isoparse(ts)
        if parsed_time.tzinfo is None:
            parsed_time = parsed_time.replace(tzinfo=timezone.utc)
        return parsed_time
    except Exception as e:
        logger.warning(f"Failed to parse timestamp: {ts}, Error: {e}")
        return None  # Return None instead of defaulting to now()


def get_trip_timestamps(event_data: dict) -> tuple:
    """
    Extracts startTime and endTime from Bouncie's webhook event data.
    Handles different event types (`tripStart`, `tripEnd`).
    
    If timestamps are missing or invalid, logs a warning.
    """
    start_time = None
    end_time = None

    if "start" in event_data and event_data["start"].get("timestamp"):
        start_time = parse_bouncie_timestamp(event_data["start"]["timestamp"])
        if start_time is None:
            logger.warning(f"Invalid or missing startTime in event: {event_data}")

    if "end" in event_data and event_data["end"].get("timestamp"):
        end_time = parse_bouncie_timestamp(event_data["end"]["timestamp"])
        if end_time is None:
            logger.warning(f"Invalid or missing endTime in event: {event_data}")

    return start_time, end_time


def sort_and_filter_trip_coordinates(trip_data: list) -> list:
    """
    Extracts, sorts, and deduplicates trip coordinates based on their timestamps.
    - Removes duplicates by (timestamp, lat, lon).
    - Returns sorted list based on timestamp.
    - Logs if data is missing or improperly formatted.
    """
    seen_coords = set()
    sorted_coords = []

    for point in trip_data:
        timestamp = parse_bouncie_timestamp(point.get("timestamp"))
        lat = point.get("gps", {}).get("lat")
        lon = point.get("gps", {}).get("lon")

        if timestamp is None or lat is None or lon is None:
            logger.warning(f"Skipping invalid tripData point: {point}")
            continue

        coord_key = (timestamp.isoformat(), lat, lon)
        if coord_key not in seen_coords:
            seen_coords.add(coord_key)
            sorted_coords.append({
                "timestamp": timestamp,
                "lat": lat,
                "lon": lon
            })

    return sorted(sorted_coords, key=lambda x: x["timestamp"])