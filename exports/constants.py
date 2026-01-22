from __future__ import annotations

from typing import Final

EXPORT_SPEC_VERSION: Final[int] = 1

EXPORT_ENTITIES: Final[set[str]] = {
    "trips",
    "matched_trips",
    "streets",
    "boundaries",
    "undriven_streets",
}

EXPORT_FORMATS_BY_ENTITY: Final[dict[str, set[str]]] = {
    "trips": {"json", "csv", "geojson", "gpx"},
    "matched_trips": {"json", "csv", "geojson", "gpx"},
    "streets": {"geojson"},
    "boundaries": {"geojson"},
    "undriven_streets": {"geojson"},
}

EXPORT_SUBDIR_BY_ENTITY: Final[dict[str, str]] = {
    "trips": "",
    "matched_trips": "",
    "streets": "coverage",
    "boundaries": "coverage",
    "undriven_streets": "coverage",
}

EXPORT_DEFAULT_FORMAT: Final[dict[str, str]] = {
    "trips": "json",
    "matched_trips": "geojson",
    "streets": "geojson",
    "boundaries": "geojson",
    "undriven_streets": "geojson",
}

TRIP_BASE_FIELDS: Final[list[str]] = [
    "tripId",
    "transactionId",
    "vin",
    "imei",
    "status",
    "startTime",
    "endTime",
    "timeZone",
    "startTimeZone",
    "endTimeZone",
    "duration",
    "durationSeconds",
    "durationMinutes",
    "startLocation",
    "destination",
    "startPlaceId",
    "location_schema_version",
    "geocoded_at",
    "distance",
    "currentSpeed",
    "maxSpeed",
    "avgSpeed",
    "pointsRecorded",
    "totalIdleDuration",
    "hardBrakingCounts",
    "hardAccelerationCounts",
    "fuelConsumed",
    "startOdometer",
    "endOdometer",
    "sequence",
    "source",
    "closed_reason",
    "processing_state",
    "matchStatus",
    "matched_at",
    "invalid",
    "validation_status",
    "validation_message",
    "validated_at",
    "destinationPlaceId",
    "destinationPlaceName",
    "saved_at",
    "lastUpdate",
    "coverage_emitted_at",
]

TRIP_JSON_FIELDS: Final[list[str]] = [
    *TRIP_BASE_FIELDS,
    "startGeoPoint",
    "destinationGeoPoint",
    "gps",
    "matchedGps",
    "coordinates",
    "processing_history",
]

TRIP_CSV_FIELDS: Final[list[str]] = [
    *TRIP_BASE_FIELDS,
    "startGeoPoint",
    "destinationGeoPoint",
    "gps",
    "matchedGps",
]

TRIP_GEOJSON_PROPERTIES_FIELDS: Final[list[str]] = [
    *TRIP_BASE_FIELDS,
    "startGeoPoint",
    "destinationGeoPoint",
]

STREET_PROPERTIES_FIELDS: Final[list[str]] = [
    "segment_id",
    "area_id",
    "area_version",
    "street_name",
    "highway_type",
    "osm_id",
    "length_miles",
    "status",
    "last_driven_at",
    "first_driven_at",
    "manually_marked",
    "marked_at",
]

BOUNDARY_PROPERTIES_FIELDS: Final[list[str]] = [
    "area_id",
    "display_name",
    "area_type",
    "area_version",
    "total_length_miles",
    "driveable_length_miles",
    "driven_length_miles",
    "coverage_percentage",
    "total_segments",
    "driven_segments",
    "last_synced",
]
