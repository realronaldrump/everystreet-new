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
from datetime import timezone

logger = logging.getLogger(__name__)

def process_trip(trip):
    """
    Processes a trip dictionary by:
      - Parsing startTime and endTime (if they are strings) into timezone‑aware datetime objects.
      - Converting the 'gps' field into a JSON string.
      - Validating that the gps data contains a "coordinates" array.
      - Setting additional keys 'startGeoPoint' and 'destinationGeoPoint'
        based on the first and last coordinates.
      - Converting "distance" to a float (or setting it to 0.0 if missing).
    Returns the modified trip dict or None if any critical validation fails.
    """
    try:
        # Process startTime.
        if isinstance(trip.get("startTime"), str):
            parsed_start = parser.isoparse(trip["startTime"])
            if parsed_start.tzinfo is None:
                parsed_start = parsed_start.replace(tzinfo=timezone.utc)
            trip["startTime"] = parsed_start

        # Process endTime.
        if isinstance(trip.get("endTime"), str):
            parsed_end = parser.isoparse(trip["endTime"])
            if parsed_end.tzinfo is None:
                parsed_end = parsed_end.replace(tzinfo=timezone.utc)
            trip["endTime"] = parsed_end

        # Check for gps data.
        if "gps" not in trip:
            logger.error(f"Trip {trip.get('transactionId', '?')} missing gps data.")
            return None

        # Ensure gps data is a dictionary and then convert back to JSON string.
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        # Validate that there are coordinates.
        if not gps_data.get("coordinates"):
            logger.error(f"Trip {trip.get('transactionId', '?')} has invalid coordinates.")
            return None

        # Store the gps data as a JSON string.
        trip["gps"] = json.dumps(gps_data)

        # Set geo-points from the coordinates.
        trip["startGeoPoint"] = gps_data["coordinates"][0]
        trip["destinationGeoPoint"] = gps_data["coordinates"][-1]

        # Convert distance to float.
        if "distance" in trip:
            try:
                trip["distance"] = float(trip["distance"])
            except (ValueError, TypeError):
                trip["distance"] = 0.0
        else:
            trip["distance"] = 0.0

        return trip

    except Exception as e:
        logger.error(f"Error processing trip {trip.get('transactionId', '?')}: {e}", exc_info=True)
        return None

def format_idle_time(seconds):
    """
    Converts a number of seconds (as a float or int) into a string formatted as HH:MM:SS.
    Returns "00:00:00" if seconds is falsy.
    """
    if not seconds:
        return "00:00:00"
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        logger.error(f"Invalid input for format_idle_time: {seconds}")
        return "Invalid Input"
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"