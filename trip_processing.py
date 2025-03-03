import json
import logging
from typing import Optional, Any, Dict
from datetime import timezone

from dateutil import parser
from shapely.geometry import Point
from db import places_collection, find_one_with_retry
from utils import reverse_geocode_nominatim, validate_trip_data

logger = logging.getLogger(__name__)


async def get_place_at_point(point: Point) -> Optional[dict]:
    """
    Return a custom place document that geospatially intersects the given point.
    This uses MongoDB's $geoIntersects operator for efficiency.
    """
    point_geojson = {"type": "Point", "coordinates": [point.x, point.y]}
    return await find_one_with_retry(
        places_collection,
        {"geometry": {"$geoIntersects": {"$geometry": point_geojson}}},
    )


async def process_trip_data(trip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Process a trip dictionary by:
      - Validating the trip data
      - Converting startTime and endTime strings to timezone-aware datetimes.
      - Parsing the 'gps' field into a dict and validating its 'coordinates'.
      - Determining start/end locations via a geospatial lookup; falling back
        to reverse geocoding if no custom place is found.
      - Setting startGeoPoint and destinationGeoPoint.
    Returns the updated trip dict or None if the trip is invalid.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info("Processing trip data for transactionId=%s", transaction_id)

    try:
        # First, validate the trip data
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.warning(
                "Trip %s failed validation: %s", transaction_id, error_message
            )
            return None

        # Create a new trip dictionary that we'll populate
        processed_trip = trip.copy()

        # Parse start and end times
        for key in ("startTime", "endTime"):
            val = processed_trip.get(key)
            if isinstance(val, str):
                dt = parser.isoparse(val)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                processed_trip[key] = dt

        # Ensure GPS data is available and in dict form
        gps_data = processed_trip.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
                processed_trip["gps"] = gps_data
            except json.JSONDecodeError as e:
                logger.warning("Trip %s has invalid GPS JSON: %s", transaction_id, e)
                return None

        if not gps_data or "coordinates" not in gps_data:
            logger.warning(
                "Trip %s has missing coordinates in GPS data", transaction_id
            )
            return None

        coords = gps_data["coordinates"]
        if len(coords) < 2:
            logger.warning("Trip %s has fewer than 2 GPS coordinates", transaction_id)
            return None

        # Get start and end points
        st, en = coords[0], coords[-1]
        start_pt = Point(st[0], st[1])
        end_pt = Point(en[0], en[1])

        # Determine start location via custom place lookup or reverse geocode fallback
        start_place = await get_place_at_point(start_pt)
        if start_place:
            processed_trip["startLocation"] = start_place.get("name", "")
            processed_trip["startPlaceId"] = str(start_place.get("_id", ""))
        else:
            rev_start = await reverse_geocode_nominatim(st[1], st[0])
            processed_trip["startLocation"] = (
                rev_start["display_name"] if rev_start else ""
            )

        end_place = await get_place_at_point(end_pt)
        if end_place:
            processed_trip["destination"] = end_place.get("name", "")
            processed_trip["destinationPlaceId"] = str(end_place.get("_id", ""))
        else:
            rev_end = await reverse_geocode_nominatim(en[1], en[0])
            processed_trip["destination"] = rev_end["display_name"] if rev_end else ""

        # Set geo-points for spatial queries
        processed_trip["startGeoPoint"] = {
            "type": "Point",
            "coordinates": [st[0], st[1]],
        }
        processed_trip["destinationGeoPoint"] = {
            "type": "Point",
            "coordinates": [en[0], en[1]],
        }

        return processed_trip

    except Exception as e:
        logger.error("Error processing trip %s: %s", transaction_id, e, exc_info=True)
        return None


def format_idle_time(seconds: Any) -> str:
    """
    Convert idle time (in seconds) to a HH:MM:SS string.
    Returns "00:00:00" if seconds is falsy, or "Invalid Input" for bad values.
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
