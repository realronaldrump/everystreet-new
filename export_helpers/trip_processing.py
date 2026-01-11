"""
Trip processing utilities for export.

Provides functions to process and filter trip data for export based on field
preferences.
"""

from typing import Any

# Field category definitions
BASIC_INFO_FIELDS = [
    "_id",
    "transactionId",
    "trip_id",
    "startTime",
    "endTime",
    "duration",
    "durationInMinutes",
    "completed",
    "active",
]

LOCATION_FIELDS = [
    "startLocation",
    "destination",
    "startAddress",
    "endAddress",
    "startPoint",
    "endPoint",
    "state",
    "city",
]

TELEMETRY_FIELDS = [
    "distance",
    "distanceInMiles",
    "startOdometer",
    "endOdometer",
    "maxSpeed",
    "averageSpeed",
    "idleTime",
    "fuelConsumed",
    "fuelEconomy",
    "speedingEvents",
]

GEOMETRY_FIELDS = [
    "gps",
    "path",
    "simplified_path",
    "route",
    "geometry",
]

META_FIELDS = [
    "deviceId",
    "imei",
    "vehicleId",
    "source",
    "processingStatus",
    "processingTime",
    "mapMatchStatus",
    "confidence",
    "insertedAt",
    "updatedAt",
]

CUSTOM_FIELDS = [
    "notes",
    "tags",
    "category",
    "purpose",
    "customFields",
]


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
