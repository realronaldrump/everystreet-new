"""
Trip processing utilities for export.

Provides functions to process and filter trip data for export based on
field preferences.
"""

from typing import Any

# Field category definitions - aligned with Trip model in db/models.py
BASIC_INFO_FIELDS = [
    "_id",
    "transactionId",
    "vin",
    "imei",
    "status",
    "startTime",
    "endTime",
    "duration",  # Computed field
    "durationMinutes",  # Computed field
]

LOCATION_FIELDS = [
    "startGeoPoint",
    "destinationGeoPoint",
    "destinationPlaceId",
    "destinationPlaceName",
]

TELEMETRY_FIELDS = [
    "distance",
    "startOdometer",
    "endOdometer",
    "currentSpeed",
    "maxSpeed",
    "avgSpeed",
    "totalIdleDuration",
    "hardBrakingCounts",
    "hardAccelerationCounts",
    "fuelConsumed",
    "pointsRecorded",
]

GEOMETRY_FIELDS = [
    "gps",
    "matchedGps",
    "coordinates",
]

META_FIELDS = [
    "source",
    "processing_state",
    "matchStatus",
    "matched_at",
    "saved_at",
    "lastUpdate",
    "closed_reason",
    "coverage_emitted_at",
    "sequence",
]

CUSTOM_FIELDS = [
    "invalid",
    "validated_at",
    "validation_status",
    "validation_message",
]


def compute_derived_fields(trip: dict[str, Any]) -> dict[str, Any]:
    """
    Compute derived fields from actual trip data.

    Calculates duration from startTime/endTime if not already present.

    Args:
        trip: Trip dictionary with raw fields

    Returns:
        Trip dictionary with computed fields added
    """
    # Compute duration from startTime and endTime
    if "duration" not in trip or trip.get("duration") is None:
        start = trip.get("startTime")
        end = trip.get("endTime")
        if start and end:
            try:
                # Handle datetime objects
                if hasattr(start, "timestamp") and hasattr(end, "timestamp"):
                    duration_seconds = (end - start).total_seconds()
                    trip["duration"] = duration_seconds
                    trip["durationMinutes"] = duration_seconds / 60.0
            except (TypeError, AttributeError):
                pass

    return trip


async def process_trip_for_export(
    trip: dict[str, Any],
    include_basic_info: bool = True,
    include_locations: bool = True,
    include_telemetry: bool = True,
    include_geometry: bool = True,
    include_meta: bool = True,
    include_custom: bool = True,
) -> dict[str, Any]:
    """
    Process a trip dictionary based on field preferences for export.

    Args:
        trip: Original trip dictionary
        include_basic_info: Include basic trip identification fields
        include_locations: Include location-related fields
        include_telemetry: Include vehicle telemetry fields
        include_geometry: Include GPS/geometry fields
        include_meta: Include metadata fields
        include_custom: Include custom user-defined fields

    Returns:
        Dict: Processed trip with only the requested fields
    """
    result = {}

    all_fields = []
    if include_basic_info:
        all_fields.extend(BASIC_INFO_FIELDS)
    if include_locations:
        all_fields.extend(LOCATION_FIELDS)
    if include_telemetry:
        all_fields.extend(TELEMETRY_FIELDS)
    if include_geometry:
        all_fields.extend(GEOMETRY_FIELDS)
    if include_meta:
        all_fields.extend(META_FIELDS)
    if include_custom:
        all_fields.extend(CUSTOM_FIELDS)

    for field in all_fields:
        if field in trip:
            result[field] = trip[field]

    # Always include _id if present
    if "_id" not in result and "_id" in trip:
        result["_id"] = trip["_id"]

    return result
