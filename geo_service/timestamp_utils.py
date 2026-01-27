"""Timestamp extraction and interpolation utilities for map matching."""

from typing import Any

from core.date_utils import parse_timestamp


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
        List of elapsed seconds (relative to first point) or None values
    """
    timestamps: list[int | None] = []

    def _normalize_timestamp(value: Any) -> int | None:
        if isinstance(value, str):
            parsed = parse_timestamp(value)
            return int(parsed.timestamp()) if parsed else None
        if hasattr(value, "timestamp"):
            return int(value.timestamp())
        if isinstance(value, int | float):
            return int(value)
        return None

    def _to_elapsed(values: list[int]) -> list[int]:
        if not values:
            return []
        start = values[0]
        return [int(v - start) for v in values]

    # Try to extract from coordinates field
    trip_coords = trip_data.get("coordinates", [])
    if trip_coords and len(trip_coords) == len(coordinates):
        for coord_obj in trip_coords:
            if isinstance(coord_obj, dict) and "timestamp" in coord_obj:
                timestamps.append(_normalize_timestamp(coord_obj["timestamp"]))
            else:
                timestamps.append(None)

        if all(t is not None for t in timestamps):
            return _to_elapsed([t for t in timestamps if t is not None])
        timestamps = []

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
            if duration < 0:
                return [None] * len(coordinates)

            if len(coordinates) > 1:
                for i in range(len(coordinates)):
                    ratio = i / (len(coordinates) - 1)
                    timestamps.append(int(duration * ratio))
            else:
                timestamps.append(0)

            return timestamps

    return [None] * len(coordinates)
