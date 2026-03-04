from __future__ import annotations

from datetime import datetime
from typing import Any

from beanie import PydanticObjectId
from bson import ObjectId

from core.date_utils import parse_timestamp
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
    if isinstance(value, ObjectId | PydanticObjectId):
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


def _get_trip_id(trip: Any) -> str | None:
    if isinstance(trip, dict):
        trip_id = trip.get("tripId") or trip.get("_id") or trip.get("id")
        return str(trip_id) if trip_id else None
    trip_id = getattr(trip, "id", None)
    return str(trip_id) if trip_id else None


def build_trip_values(trip: Any) -> dict[str, Any]:
    from trips.serialization import TripSerializer

    trip_doc = TripSerializer.to_trip_dict(trip)
    common = TripSerializer.to_dict(trip_doc)
    duration_seconds = common.get("duration")
    duration_minutes = duration_seconds / 60.0 if duration_seconds is not None else None

    return {
        "tripId": _get_trip_id(trip),
        "transactionId": common.get("transactionId"),
        "vin": common.get("vin"),
        "imei": common.get("imei"),
        "status": common.get("status"),
        "startTime": common.get("startTime"),
        "endTime": common.get("endTime"),
        "timeZone": common.get("timeZone"),
        "startTimeZone": common.get("startTimeZone"),
        "endTimeZone": common.get("endTimeZone"),
        "duration": common.get("duration"),
        "durationSeconds": duration_seconds,
        "durationMinutes": duration_minutes,
        "startLocation": normalize_value(common.get("startLocation")),
        "destination": normalize_value(common.get("destination")),
        "startPlaceId": _get_value(trip, "startPlaceId"),
        "location_schema_version": _get_value(trip, "location_schema_version"),
        "geocoded_at": format_datetime(_get_value(trip, "geocoded_at")),
        "distance": common.get("distance"),
        "coverageDistance": _get_value(trip, "coverageDistance"),
        "currentSpeed": _get_value(trip, "currentSpeed"),
        "maxSpeed": common.get("maxSpeed"),
        "avgSpeed": common.get("avgSpeed"),
        "pointsRecorded": _get_value(trip, "pointsRecorded"),
        "totalIdleDuration": common.get("totalIdleDuration"),
        "hardBrakingCounts": common.get("hardBrakingCounts"),
        "hardAccelerationCounts": common.get("hardAccelerationCounts"),
        "fuelConsumed": common.get("fuelConsumed"),
        "startOdometer": common.get("startOdometer"),
        "endOdometer": common.get("endOdometer"),
        "sequence": _get_value(trip, "sequence"),
        "source": common.get("source"),
        "closed_reason": _get_value(trip, "closed_reason"),
        "processing_state": _get_value(trip, "processing_state"),
        "matchStatus": common.get("matchStatus"),
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
