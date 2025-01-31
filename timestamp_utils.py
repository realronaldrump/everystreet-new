import dateutil.parser
from datetime import datetime, timezone


def parse_bouncie_timestamp(ts: str) -> datetime:
    """
    Parses an ISO 8601 timestamp from Bouncie's API and ensures it is timezone-aware.

    If parsing fails, it returns the current UTC timestamp (with a log warning).
    """
    if not ts:
        return datetime.now(timezone.utc)  # Fallback if timestamp is missing
    try:
        parsed_time = dateutil.parser.isoparse(ts)
        if parsed_time.tzinfo is None:
            parsed_time = parsed_time.replace(tzinfo=timezone.utc)
        return parsed_time
    except Exception as e:
        print(f"WARNING: Failed to parse timestamp: {ts}, Error: {e}")
        return datetime.now(timezone.utc)


def get_trip_timestamps(event_data: dict) -> tuple:
    """
    Extracts startTime and endTime from Bouncie's webhook event data.
    Handles different event types (`tripStart`, `tripEnd`).
    """
    start_time = None
    end_time = None

    if "start" in event_data:
        start_time = parse_bouncie_timestamp(
            event_data["start"].get("timestamp"))

    if "end" in event_data:
        end_time = parse_bouncie_timestamp(event_data["end"].get("timestamp"))

    return start_time, end_time


def sort_and_filter_trip_coordinates(trip_data: list) -> list:
    """
    Extracts, sorts, and deduplicates trip coordinates based on their timestamps.
    - Removes duplicates by (timestamp, lat, lon).
    - Returns sorted list based on timestamp.
    """
    seen_coords = set()
    sorted_coords = []

    for point in trip_data:
        timestamp = parse_bouncie_timestamp(point.get("timestamp"))
        lat = point.get("gps", {}).get("lat")
        lon = point.get("gps", {}).get("lon")

        if lat is not None and lon is not None:
            coord_key = (timestamp.isoformat(), lat, lon)
            if coord_key not in seen_coords:
                seen_coords.add(coord_key)
                sorted_coords.append({
                    "timestamp": timestamp,
                    "lat": lat,
                    "lon": lon
                })

    return sorted(sorted_coords, key=lambda x: x["timestamp"])
