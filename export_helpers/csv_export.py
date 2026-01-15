"""
CSV export utilities.

Provides functions to convert trip data to CSV format for export.
"""

import csv
import json
import logging
from datetime import datetime
from io import StringIO
from typing import Any

from .base import (
    CSV_BASE_FIELDS,
    CSV_GEOMETRY_FIELDS,
    CSV_LOCATION_FIELDS,
    flatten_geopoint,
)

logger = logging.getLogger(__name__)


def flatten_trip_for_csv(
    trip: dict[str, Any],
    include_gps_in_csv: bool = False,
    flatten_location_fields: bool = True,
) -> dict[str, Any]:
    """
    Flatten a trip dictionary for CSV export.

    This function consolidates the location flattening logic used by both
    streaming (export_api.py) and buffered (create_csv_export) CSV generation.

    Args:
        trip: Original trip dictionary
        include_gps_in_csv: Whether to include geometry data as JSON strings
        flatten_location_fields: Whether to flatten location objects into columns

    Returns:
        Flat dictionary with all values suitable for CSV writing
    """
    flat = {}

    # Handle geometry fields
    for key in CSV_GEOMETRY_FIELDS:
        if key in trip:
            if include_gps_in_csv:
                flat[key] = json.dumps(trip[key])
            else:
                flat[key] = "[Geometry data not included]"

    # Handle location flattening - use actual Trip model GeoPoint fields
    if flatten_location_fields:
        # Flatten GeoPoint fields (actual Trip model structure)
        start_geo = trip.get("startGeoPoint")
        dest_geo = trip.get("destinationGeoPoint")

        flat.update(flatten_geopoint(start_geo, "startGeoPoint"))
        flat.update(flatten_geopoint(dest_geo, "destinationGeoPoint"))

        # Include place info directly
        if "destinationPlaceId" in trip:
            flat["destinationPlaceId"] = trip["destinationPlaceId"]
        if "destinationPlaceName" in trip:
            flat["destinationPlaceName"] = trip["destinationPlaceName"]
    else:
        # Include GeoPoints as JSON strings
        if "startGeoPoint" in trip:
            flat["startGeoPoint"] = json.dumps(trip["startGeoPoint"])
        if "destinationGeoPoint" in trip:
            flat["destinationGeoPoint"] = json.dumps(trip["destinationGeoPoint"])

    # Handle all other fields
    for key, value in trip.items():
        if key in flat:
            continue
        if (
            key
            in [
                "startGeoPoint",
                "destinationGeoPoint",
                "destinationPlaceId",
                "destinationPlaceName",
            ]
            and flatten_location_fields
        ):
            continue
        if key in CSV_GEOMETRY_FIELDS:
            continue

        if isinstance(value, dict | list):
            flat[key] = json.dumps(value)
        elif isinstance(value, datetime):
            flat[key] = value.isoformat()
        else:
            flat[key] = value

    return flat


async def create_csv_export(
    trips: list[dict[str, Any]],
    include_gps_in_csv: bool = False,
    flatten_location_fields: bool = True,
) -> str:
    """
    Convert trip dictionaries to CSV format.

    Args:
        trips: List of trip dictionaries
        include_gps_in_csv: Whether to include GPS data as JSON strings
        flatten_location_fields: Whether to flatten location fields
        into separate columns

    Returns:
        str: CSV data as a string
    """
    if not trips:
        return "No data to export"

    output = StringIO()

    # Build fieldnames from all trips, plus location fields if flattening
    fieldnames = set()
    for trip in trips:
        fieldnames.update(trip.keys())

    if flatten_location_fields:
        fieldnames.update(CSV_LOCATION_FIELDS)
        fieldnames.discard("startGeoPoint")
        fieldnames.discard("destinationGeoPoint")

    fieldnames = sorted(fieldnames)

    # Prioritize important fields at the start
    priority_fields = CSV_BASE_FIELDS[:6] + (
        CSV_LOCATION_FIELDS if flatten_location_fields else []
    )

    for field in reversed(priority_fields):
        if field in fieldnames:
            fieldnames.remove(field)
            fieldnames.insert(0, field)

    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()

    for trip in trips:
        flat_trip = flatten_trip_for_csv(
            trip,
            include_gps_in_csv=include_gps_in_csv,
            flatten_location_fields=flatten_location_fields,
        )
        writer.writerow(flat_trip)

    return output.getvalue()
