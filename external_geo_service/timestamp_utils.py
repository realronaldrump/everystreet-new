"""Timestamp extraction and interpolation utilities for map matching."""

from typing import Any

from date_utils import parse_timestamp


def extract_timestamps_for_coordinates(
    coordinates: list[list[float]],
    trip_data: dict[str, Any],
) -> list[int | None]:
    """
    Extract timestamps for coordinates, interpolating if necessary.

    Args:
        coordinates: List of [lon, lat] coordinates
        trip_data: Trip data containing optional timestamp info

    Returns:
        List of Unix timestamps or None values
    """
    timestamps: list[int | None] = []

    # Try to extract from coordinates field
    trip_coords = trip_data.get("coordinates", [])
    if trip_coords and len(trip_coords) == len(coordinates):
        for coord_obj in trip_coords:
            if isinstance(coord_obj, dict) and "timestamp" in coord_obj:
                ts = coord_obj["timestamp"]
                if isinstance(ts, str):
                    parsed = parse_timestamp(ts)
                    timestamps.append(int(parsed.timestamp()) if parsed else None)
                elif hasattr(ts, "timestamp"):
                    timestamps.append(int(ts.timestamp()))
                elif isinstance(ts, int | float):
                    timestamps.append(int(ts))
                else:
                    timestamps.append(None)
            else:
                timestamps.append(None)

        if any(t is not None for t in timestamps):
            return timestamps

    # Fallback: interpolate from start/end times
    start_time = trip_data.get("startTime")
    end_time = trip_data.get("endTime")

    if start_time and end_time:
        if isinstance(start_time, str):
            start_time = parse_timestamp(start_time)
        if isinstance(end_time, str):
            end_time = parse_timestamp(end_time)

        if start_time and end_time:
            start_ts = int(start_time.timestamp())
            end_ts = int(end_time.timestamp())
            duration = end_ts - start_ts

            if len(coordinates) > 1:
                for i in range(len(coordinates)):
                    ratio = i / (len(coordinates) - 1)
                    timestamps.append(start_ts + int(duration * ratio))
            else:
                timestamps.append(start_ts)

            return timestamps

    return [None] * len(coordinates)
