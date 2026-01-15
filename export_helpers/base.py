"""
Base utilities and constants for export helpers.

This module provides shared logging, constants, and utility functions
used across all export format modules.
"""

import json
import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

# CSV field definitions for consistent use across streaming and buffered exports
# CSV location fields for flattened GeoPoint data
CSV_LOCATION_FIELDS = [
    "startGeoPoint_lng",
    "startGeoPoint_lat",
    "destinationGeoPoint_lng",
    "destinationGeoPoint_lat",
    "destinationPlaceId",
    "destinationPlaceName",
]

CSV_GEOMETRY_FIELDS = ["gps", "matchedGps", "coordinates"]

CSV_BASE_FIELDS = [
    "_id",
    "transactionId",
    "vin",
    "imei",
    "status",
    "startTime",
    "endTime",
    "duration",
    "durationMinutes",
    "distance",
    "source",
]


def normalize_location_object(obj: Any) -> dict[str, Any]:
    """
    Normalize a location field that may be a string or dict.

    Args:
        obj: Location data as string (JSON) or dict

    Returns:
        dict: Normalized location dictionary
    """
    if isinstance(obj, str):
        try:
            return json.loads(obj)
        except json.JSONDecodeError:
            return {}
    return obj if isinstance(obj, dict) else {}


def flatten_geopoint(
    geopoint: dict[str, Any] | None,
    prefix: str,
) -> dict[str, Any]:
    """
    Flatten a GeoPoint (GeoJSON Point or LineString) into prefixed CSV columns.

    Args:
        geopoint: GeoJSON dict with type and coordinates
        prefix: Field prefix (e.g., "startGeoPoint" or "destinationGeoPoint")

    Returns:
        Dict with flattened fields like "startGeoPoint_lat", "startGeoPoint_lng", etc.
    """
    result = {
        f"{prefix}_lat": "",
        f"{prefix}_lng": "",
    }

    if not geopoint or not isinstance(geopoint, dict):
        return result

    coords = geopoint.get("coordinates")
    if not coords:
        return result

    # Handle Point: coordinates = [lng, lat]
    if (
        geopoint.get("type") == "Point"
        and isinstance(coords, list)
        and len(coords) >= 2
    ):
        result[f"{prefix}_lng"] = coords[0]
        result[f"{prefix}_lat"] = coords[1]
    # Handle LineString: use first coordinate
    elif (
        geopoint.get("type") == "LineString"
        and isinstance(coords, list)
        and len(coords) >= 1
    ):
        first_coord = coords[0]
        if isinstance(first_coord, list) and len(first_coord) >= 2:
            result[f"{prefix}_lng"] = first_coord[0]
            result[f"{prefix}_lat"] = first_coord[1]

    return result


def flatten_location(
    location: dict[str, Any],
    prefix: str,
) -> dict[str, Any]:
    """
    Flatten a location object into prefixed CSV columns.

    NOTE: This function is kept for backwards compatibility but trips don't
    have this structure. Use flatten_geopoint for actual trip geo points.

    Args:
        location: Location dictionary with formatted_address, address_components, coordinates
        prefix: Field prefix (e.g., "startLocation" or "destination")

    Returns:
        Dict with flattened fields like "startLocation_city", "destination_lat", etc.
    """
    result = {}

    result[f"{prefix}_formatted_address"] = location.get("formatted_address", "")

    addr_comps = location.get("address_components", {})
    if isinstance(addr_comps, dict):
        result[f"{prefix}_street_number"] = addr_comps.get("street_number", "")
        result[f"{prefix}_street"] = addr_comps.get("street", "")
        result[f"{prefix}_city"] = addr_comps.get("city", "")
        result[f"{prefix}_county"] = addr_comps.get("county", "")
        result[f"{prefix}_state"] = addr_comps.get("state", "")
        result[f"{prefix}_postal_code"] = addr_comps.get("postal_code", "")
        result[f"{prefix}_country"] = addr_comps.get("country", "")

    coords = location.get("coordinates", {})
    if isinstance(coords, dict):
        result[f"{prefix}_lat"] = coords.get("lat", "")
        result[f"{prefix}_lng"] = coords.get("lng", "")

    return result


def get_location_filename(location: dict[str, Any]) -> str:
    """
    Create a safe filename from a location dictionary.

    Args:
        location: Location dictionary with display_name

    Returns:
        str: Safe filename string
    """
    return (
        location.get("display_name", "").split(",")[0].strip().replace(" ", "_").lower()
    )


def serialize_value(value: Any) -> Any:
    """
    Serialize a value for export (handles datetime, dict, list).

    Args:
        value: Any value to serialize

    Returns:
        Serialized value suitable for export
    """
    if isinstance(value, dict | list):
        return json.dumps(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value
