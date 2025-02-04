"""
trip_processing.py

This module contains helper functions for processing a trip object:
  - Parsing and normalizing timestamp fields.
  - Validating and formatting GPS data.
  - Setting geo‑point fields.
  - Converting an idle time in seconds to a human‐readable format.
"""

import json
import logging
from dateutil import parser
from datetime import datetime, timezone
from typing import Optional, Any, Dict

logger = logging.getLogger(__name__)


def process_trip(trip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Processes a trip dictionary by:
      - Parsing startTime and endTime (if they are strings) into timezone‑aware datetime objects.
      - Converting the 'gps' field into a JSON string.
      - Validating that the gps data contains a "coordinates" array.
      - Setting additional keys 'startGeoPoint' and 'destinationGeoPoint'
        based on the first and last coordinates.
      - Converting "distance" to a float (or setting it to 0.0 if missing or invalid).

    Returns the modified trip dict or None if any critical validation fails.
    """
    try:
        # Process startTime.
        start_time = trip.get("startTime")
        if isinstance(start_time, str):
            parsed_start = parser.isoparse(start_time)
            # Ensure the datetime is timezone-aware.
            if parsed_start.tzinfo is None:
                parsed_start = parsed_start.replace(tzinfo=timezone.utc)
            trip["startTime"] = parsed_start

        # Process endTime.
        end_time = trip.get("endTime")
        if isinstance(end_time, str):
            parsed_end = parser.isoparse(end_time)
            if parsed_end.tzinfo is None:
                parsed_end = parsed_end.replace(tzinfo=timezone.utc)
            trip["endTime"] = parsed_end

        # Validate gps data exists.
        if "gps" not in trip:
            logger.error(
                f"Trip {trip.get('transactionId', '?')} missing gps data.")
            return None

        # Ensure gps data is a dictionary.
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if not gps_data.get("coordinates"):
            logger.error(
                f"Trip {trip.get('transactionId', '?')} has invalid coordinates."
            )
            return None

        # Store the gps data as a JSON string.
        trip["gps"] = json.dumps(gps_data)

        # Set geo-point fields from the coordinates.
        trip["startGeoPoint"] = gps_data["coordinates"][0]
        trip["destinationGeoPoint"] = gps_data["coordinates"][-1]

        # Convert "distance" to a float (default to 0.0 if missing or conversion fails).
        try:
            trip["distance"] = float(trip.get("distance", 0.0))
        except (ValueError, TypeError):
            trip["distance"] = 0.0

        return trip

    except Exception as e:
        logger.error(
            f"Error processing trip {trip.get('transactionId', '?')}: {e}",
            exc_info=True,
        )
        return None


def format_idle_time(seconds: Any) -> str:
    """
    Converts a number of seconds (as a float or int) into a string formatted as HH:MM:SS.
    Returns "00:00:00" if seconds is falsy.
    """
    if not seconds:
        return "00:00:00"
    try:
        total_seconds = int(seconds)
    except (TypeError, ValueError) as e:
        logger.error(f"Invalid input for format_idle_time: {seconds} - {e}")
        return "Invalid Input"
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"
