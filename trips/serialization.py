"""
Canonical trip serialization helpers.

Single source of truth for duration, timezone derivation, and shared
trip response field normalization.
"""

from __future__ import annotations

from typing import Any

from core.casting import safe_float
from core.date_utils import parse_timestamp
from core.serialization import serialize_datetime


def _first_non_empty(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


class TripSerializer:
    """Canonical serializer for shared trip response shapes."""

    @staticmethod
    def to_trip_dict(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return dict(value)
        if hasattr(value, "model_dump"):
            return value.model_dump()
        if hasattr(value, "dict"):
            return value.dict()
        return dict(value)

    @staticmethod
    def derive_timezone_fields(trip_doc: dict[str, Any]) -> tuple[Any, Any, Any]:
        start_tz = _first_non_empty(trip_doc.get("startTimeZone"))
        end_tz = _first_non_empty(trip_doc.get("endTimeZone"))
        alias_tz = _first_non_empty(start_tz, end_tz)
        return start_tz, end_tz, alias_tz

    @staticmethod
    def calculate_duration_seconds(trip_doc: dict[str, Any]) -> float | None:
        """Calculate trip duration in seconds from startTime and endTime."""
        duration = trip_doc.get("duration")
        if duration is not None:
            try:
                return float(duration)
            except (TypeError, ValueError):
                pass

        start_raw = trip_doc.get("startTime")
        end_raw = trip_doc.get("endTime")
        if not start_raw or not end_raw:
            return None

        start = parse_timestamp(start_raw) if isinstance(start_raw, str) else start_raw
        end = parse_timestamp(end_raw) if isinstance(end_raw, str) else end_raw
        if start is None or end is None:
            return None

        return (end - start).total_seconds()

    @staticmethod
    def to_dict(
        trip_doc: dict[str, Any],
        fields: set[str] | None = None,
    ) -> dict[str, Any]:
        """Serialize common trip fields with normalized timestamps/timezones."""
        start_dt = parse_timestamp(trip_doc.get("startTime"))
        end_dt = parse_timestamp(trip_doc.get("endTime"))
        start_tz, end_tz, alias_tz = TripSerializer.derive_timezone_fields(trip_doc)

        serialized: dict[str, Any] = {
            "transactionId": trip_doc.get("transactionId"),
            "imei": trip_doc.get("imei"),
            "vin": trip_doc.get("vin"),
            "source": trip_doc.get("source"),
            "status": trip_doc.get("status"),
            "startTime": start_dt.isoformat() if start_dt else None,
            "endTime": end_dt.isoformat() if end_dt else None,
            "startTimeZone": start_tz,
            "endTimeZone": end_tz,
            "timeZone": alias_tz,
            "duration": TripSerializer.calculate_duration_seconds(trip_doc),
            "distance": safe_float(trip_doc.get("distance"), 0),
            "maxSpeed": safe_float(trip_doc.get("maxSpeed"), 0),
            "avgSpeed": trip_doc.get("avgSpeed"),
            "startLocation": trip_doc.get("startLocation"),
            "destination": trip_doc.get("destination"),
            "totalIdleDuration": trip_doc.get("totalIdleDuration"),
            "fuelConsumed": safe_float(trip_doc.get("fuelConsumed"), 0),
            "hardBrakingCounts": trip_doc.get("hardBrakingCounts"),
            "hardAccelerationCounts": trip_doc.get("hardAccelerationCounts"),
            "startOdometer": trip_doc.get("startOdometer"),
            "endOdometer": trip_doc.get("endOdometer"),
            "matchStatus": trip_doc.get("matchStatus"),
            "matched_at": serialize_datetime(trip_doc.get("matched_at")),
            "pointsRecorded": trip_doc.get("pointsRecorded"),
        }

        if fields is None:
            return serialized
        return {field: serialized.get(field) for field in fields}

    @staticmethod
    def to_geojson_properties(
        trip_doc: dict[str, Any],
        *,
        estimated_cost: float | None = None,
        points_recorded: int = 0,
        include_matched_at: bool = False,
        coverage_distance_miles: float | None = None,
    ) -> dict[str, Any]:
        """Serialize GeoJSON feature properties for trip responses."""
        props = TripSerializer.to_dict(trip_doc)
        props["pointsRecorded"] = points_recorded
        props["estimated_cost"] = safe_float(estimated_cost, 0)
        if not include_matched_at:
            props.pop("matched_at", None)
        if coverage_distance_miles is not None:
            props["coverageDistance"] = coverage_distance_miles
        return props


def calculate_duration_seconds(trip_doc: dict[str, Any]) -> float | None:
    """Backward-compatible function alias for duration calculation."""
    return TripSerializer.calculate_duration_seconds(trip_doc)
