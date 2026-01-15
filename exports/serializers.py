from __future__ import annotations

from datetime import datetime
from typing import Any

from beanie import PydanticObjectId
from bson import ObjectId

from date_utils import parse_timestamp
from exports.constants import (
    BOUNDARY_PROPERTIES_FIELDS,
    STREET_PROPERTIES_FIELDS,
    TRIP_BASE_FIELDS,
    TRIP_GEOJSON_PROPERTIES_FIELDS,
    TRIP_JSON_FIELDS,
)


def format_datetime(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        parsed = parse_timestamp(value)
        return parsed.isoformat() if parsed else value
    return None


def normalize_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (ObjectId, PydanticObjectId)):
        return str(value)
    if isinstance(value, dict):
        return {key: normalize_value(val) for key, val in value.items()}
    if isinstance(value, list):
        return [normalize_value(item) for item in value]
    return value


def _get_value(source: Any, key: str) -> Any:
    if isinstance(source, dict):
        return source.get(key)
    return getattr(source, key, None)


def _get_value_with_fallback(source: Any, key: str, *fallbacks: str) -> Any:
    value = _get_value(source, key)
    if value is not None:
        return value
    for fallback in fallbacks:
        value = _get_value(source, fallback)
        if value is not None:
            return value
    return None


def _get_trip_id(trip: Any) -> str | None:
    if isinstance(trip, dict):
        trip_id = trip.get("tripId") or trip.get("_id") or trip.get("id")
        return str(trip_id) if trip_id else None
    trip_id = getattr(trip, "id", None)
    return str(trip_id) if trip_id else None


def _calculate_duration_seconds(trip: Any) -> float | None:
    start = parse_timestamp(_get_value(trip, "startTime"))
    end = parse_timestamp(_get_value(trip, "endTime"))
    if start and end:
        return (end - start).total_seconds()
    duration = _get_value(trip, "duration")
    if duration is None:
        return None
    try:
        return float(duration)
    except (TypeError, ValueError):
        return None


def build_trip_values(trip: Any) -> dict[str, Any]:
    duration_seconds = _calculate_duration_seconds(trip)
    duration_minutes = (
        duration_seconds / 60.0 if duration_seconds is not None else None
    )

    values = {
        "tripId": _get_trip_id(trip),
        "transactionId": _get_value(trip, "transactionId"),
        "vin": _get_value(trip, "vin"),
        "imei": _get_value(trip, "imei"),
        "status": _get_value(trip, "status"),
        "startTime": format_datetime(_get_value(trip, "startTime")),
        "endTime": format_datetime(_get_value(trip, "endTime")),
        "timeZone": _get_value(trip, "timeZone"),
        "startTimeZone": _get_value(trip, "startTimeZone"),
        "endTimeZone": _get_value(trip, "endTimeZone"),
        "duration": _get_value(trip, "duration"),
        "durationSeconds": duration_seconds,
        "durationMinutes": duration_minutes,
        "startLocation": normalize_value(_get_value(trip, "startLocation")),
        "destination": normalize_value(_get_value(trip, "destination")),
        "startPlaceId": _get_value(trip, "startPlaceId"),
        "location_schema_version": _get_value(trip, "location_schema_version"),
        "geocoded_at": format_datetime(_get_value(trip, "geocoded_at")),
        "distance": _get_value(trip, "distance"),
        "currentSpeed": _get_value(trip, "currentSpeed"),
        "maxSpeed": _get_value(trip, "maxSpeed"),
        "avgSpeed": _get_value_with_fallback(trip, "avgSpeed", "averageSpeed"),
        "pointsRecorded": _get_value(trip, "pointsRecorded"),
        "totalIdleDuration": _get_value_with_fallback(
            trip,
            "totalIdleDuration",
            "totalIdlingTime",
        ),
        "hardBrakingCounts": _get_value_with_fallback(
            trip,
            "hardBrakingCounts",
            "hardBrakingCount",
        ),
        "hardAccelerationCounts": _get_value_with_fallback(
            trip,
            "hardAccelerationCounts",
            "hardAccelerationCount",
        ),
        "fuelConsumed": _get_value(trip, "fuelConsumed"),
        "startOdometer": _get_value(trip, "startOdometer"),
        "endOdometer": _get_value(trip, "endOdometer"),
        "sequence": _get_value(trip, "sequence"),
        "source": _get_value(trip, "source"),
        "closed_reason": _get_value(trip, "closed_reason"),
        "processing_state": _get_value(trip, "processing_state"),
        "matchStatus": _get_value(trip, "matchStatus"),
        "matched_at": format_datetime(_get_value(trip, "matched_at")),
        "invalid": _get_value(trip, "invalid"),
        "validation_status": _get_value(trip, "validation_status"),
        "validation_message": _get_value(trip, "validation_message"),
        "validated_at": format_datetime(_get_value(trip, "validated_at")),
        "destinationPlaceId": _get_value(trip, "destinationPlaceId"),
        "destinationPlaceName": _get_value(trip, "destinationPlaceName"),
        "saved_at": format_datetime(_get_value(trip, "saved_at")),
        "lastUpdate": format_datetime(_get_value(trip, "lastUpdate")),
        "coverage_emitted_at": format_datetime(_get_value(trip, "coverage_emitted_at")),
        "startGeoPoint": normalize_value(_get_value(trip, "startGeoPoint")),
        "destinationGeoPoint": normalize_value(
            _get_value(trip, "destinationGeoPoint"),
        ),
        "gps": normalize_value(_get_value(trip, "gps")),
        "matchedGps": normalize_value(_get_value(trip, "matchedGps")),
        "coordinates": normalize_value(_get_value(trip, "coordinates")),
        "processing_history": normalize_value(
            _get_value(trip, "processing_history"),
        ),
    }

    return values


def serialize_trip_record(
    trip: Any,
    *,
    include_geometry: bool = True,
) -> dict[str, Any]:
    values = build_trip_values(trip)
    fields = TRIP_JSON_FIELDS

    if not include_geometry:
        values.update(
            {
                "gps": None,
                "matchedGps": None,
                "coordinates": None,
                "startGeoPoint": None,
                "destinationGeoPoint": None,
            },
        )

    return {field: values.get(field) for field in fields}


def serialize_trip_properties(trip: Any) -> dict[str, Any]:
    values = build_trip_values(trip)
    fields = TRIP_GEOJSON_PROPERTIES_FIELDS
    return {field: values.get(field) for field in fields}


def serialize_trip_base(trip: Any) -> dict[str, Any]:
    values = build_trip_values(trip)
    fields = TRIP_BASE_FIELDS
    return {field: values.get(field) for field in fields}


def serialize_street_properties(street: Any, state: Any | None) -> dict[str, Any]:
    values = {
        "segment_id": _get_value(street, "segment_id"),
        "area_id": normalize_value(_get_value(street, "area_id")),
        "area_version": _get_value(street, "area_version"),
        "street_name": _get_value(street, "street_name"),
        "highway_type": _get_value(street, "highway_type"),
        "osm_id": _get_value(street, "osm_id"),
        "length_miles": _get_value(street, "length_miles"),
        "status": _get_value(state, "status") if state else "undriven",
        "last_driven_at": format_datetime(
            _get_value(state, "last_driven_at") if state else None,
        ),
        "first_driven_at": format_datetime(
            _get_value(state, "first_driven_at") if state else None,
        ),
        "manually_marked": _get_value(state, "manually_marked") if state else False,
        "marked_at": format_datetime(
            _get_value(state, "marked_at") if state else None,
        ),
    }
    return {field: values.get(field) for field in STREET_PROPERTIES_FIELDS}


def serialize_boundary_properties(area: Any) -> dict[str, Any]:
    values = {
        "area_id": normalize_value(_get_value(area, "id") or _get_value(area, "_id")),
        "display_name": _get_value(area, "display_name"),
        "area_type": _get_value(area, "area_type"),
        "area_version": _get_value(area, "area_version"),
        "total_length_miles": _get_value(area, "total_length_miles"),
        "driveable_length_miles": _get_value(area, "driveable_length_miles"),
        "driven_length_miles": _get_value(area, "driven_length_miles"),
        "coverage_percentage": _get_value(area, "coverage_percentage"),
        "total_segments": _get_value(area, "total_segments"),
        "driven_segments": _get_value(area, "driven_segments"),
        "last_synced": format_datetime(_get_value(area, "last_synced")),
    }
    return {field: values.get(field) for field in BOUNDARY_PROPERTIES_FIELDS}
