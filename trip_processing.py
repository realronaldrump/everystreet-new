"""
trip_processing.py

Helper functions for processing a trip dictionary:
 - parsing timestamps
 - converting GPS data to JSON
 - setting geo-points
 - checking custom places
 - reverse geocoding
 - formatting idle time
"""

import json
import logging
from typing import Optional, Any, Dict, List
from datetime import timezone

from dateutil import parser
from shapely.geometry import shape, Point
from db import places_collection
from utils import reverse_geocode_nominatim

logger = logging.getLogger(__name__)


async def get_place_at_point(point: Point) -> Optional[dict]:
    """
    Find a custom place (from places_collection) that contains the given shapely.Point.
    """
    places = await places_collection.find({}).to_list(length=None)
    for p in places:
        place_geom = p["geometry"]
        shp = shape(place_geom)
        if shp.contains(point):
            return p
    return None


async def process_trip_data(trip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Asynchronously process a trip:
      - Convert 'startTime'/'endTime' to aware datetimes if strings.
      - Parse 'gps' to a Python dict if it's a JSON string, ensure it has 'coordinates'.
      - Attempt to find a custom place for start/end; if none, do reverse geocoding.
      - Set 'startGeoPoint' and 'destinationGeoPoint'.
      - Return the updated trip, or None if invalid.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info("Processing trip data for transactionId=%s...", transaction_id)
    try:
        # Convert start/end times if strings
        for key in ("startTime", "endTime"):
            val = trip.get(key)
            if isinstance(val, str):
                dt_parsed = parser.isoparse(val)
                if dt_parsed.tzinfo is None:
                    dt_parsed = dt_parsed.replace(tzinfo=timezone.utc)
                trip[key] = dt_parsed

        # Ensure gps is dict
        gps_data = trip.get("gps")
        if not gps_data:
            logger.warning("Trip %s has no GPS data", transaction_id)
            return None

        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except Exception as e:
                logger.error(
                    "Error parsing gps data for trip %s: %s",
                    transaction_id,
                    e,
                    exc_info=True,
                )
                return None
        if not gps_data.get("coordinates"):
            logger.warning(
                "Trip %s has no coordinates array in gps data", transaction_id
            )
            return None

        # Overwrite the 'gps' field with the parsed dict
        trip["gps"] = gps_data

        coords = gps_data["coordinates"]
        if len(coords) < 2:
            logger.warning(
                "Trip %s has fewer than 2 coords in gps data", transaction_id
            )

        # Build shapely Points for first/last
        st = coords[0]
        en = coords[-1]
        start_pt = Point(st[0], st[1])
        end_pt = Point(en[0], en[1])

        # Check custom places
        start_place = await get_place_at_point(start_pt)
        if start_place:
            trip["startLocation"] = start_place["name"]
            trip["startPlaceId"] = str(start_place.get("_id", ""))
        else:
            # fallback to reverse geocode
            rev_start = await reverse_geocode_nominatim(st[1], st[0])
            if rev_start and isinstance(rev_start, dict):
                trip["startLocation"] = rev_start.get("display_name", "")

        end_place = await get_place_at_point(end_pt)
        if end_place:
            trip["destination"] = end_place["name"]
            trip["destinationPlaceId"] = str(end_place.get("_id", ""))
        else:
            rev_end = await reverse_geocode_nominatim(en[1], en[0])
            if rev_end and isinstance(rev_end, dict):
                trip["destination"] = rev_end.get("display_name", "")

        # Set geo-points
        trip["startGeoPoint"] = {
            "type": "Point",
            "coordinates": [st[0], st[1]],
        }
        trip["destinationGeoPoint"] = {
            "type": "Point",
            "coordinates": [en[0], en[1]],
        }

        # Return updated trip
        return trip

    except Exception as e:
        logger.error(
            "Error in process_trip_data for trip %s: %s",
            transaction_id,
            e,
            exc_info=True,
        )
        return None


def format_idle_time(seconds: Any) -> str:
    """
    Convert idle time in seconds to HH:MM:SS.
    If `seconds` is missing or invalid, returns "Invalid Input" or "00:00:00".
    """
    if not seconds:
        return "00:00:00"
    try:
        total_seconds = int(seconds)
    except (TypeError, ValueError):
        logger.error("Invalid input for format_idle_time: %s", seconds)
        return "Invalid Input"
    hrs = total_seconds // 3600
    mins = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hrs:02d}:{mins:02d}:{secs:02d}"
