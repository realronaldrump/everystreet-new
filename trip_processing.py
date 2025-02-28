import json
import logging
from typing import Optional, Any, Dict
from datetime import timezone

from dateutil import parser
from shapely.geometry import Point
from db import places_collection
from utils import reverse_geocode_nominatim

logger = logging.getLogger(__name__)


async def get_place_at_point(point: Point) -> Optional[dict]:
    """
    Return a custom place document that geospatially intersects the given point.
    This uses MongoDB's $geoIntersects operator for efficiency.
    """
    point_geojson = {"type": "Point", "coordinates": [point.x, point.y]}
    return await places_collection.find_one(
        {"geometry": {"$geoIntersects": {"$geometry": point_geojson}}}
    )


async def process_trip_data(trip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Process a trip dictionary by:
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
        # Parse start and end times
        for key in ("startTime", "endTime"):
            val = trip.get(key)
            if isinstance(val, str):
                dt = parser.isoparse(val)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                trip[key] = dt

        # Ensure GPS data is available and in dict form
        gps_data = trip.get("gps")
        if not gps_data:
            logger.warning("Trip %s missing GPS data", transaction_id)
            return None
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if "coordinates" not in gps_data or not isinstance(
            gps_data["coordinates"], list
        ):
            logger.warning("Trip %s has invalid GPS data", transaction_id)
            return None
        trip["gps"] = gps_data

        coords = gps_data["coordinates"]
        if len(coords) < 2:
            logger.warning("Trip %s has fewer than 2 GPS coordinates", transaction_id)

        # Get start and end points
        st, en = coords[0], coords[-1]
        start_pt = Point(st[0], st[1])
        end_pt = Point(en[0], en[1])

        # Determine start location via custom place lookup or reverse geocode fallback
        start_place = await get_place_at_point(start_pt)
        if start_place:
            trip["startLocation"] = start_place.get("name", "")
            trip["startPlaceId"] = str(start_place.get("_id", ""))
        else:
            rev_start = await reverse_geocode_nominatim(st[1], st[0])
            trip["startLocation"] = rev_start["display_name"] if rev_start else ""

        end_place = await get_place_at_point(end_pt)
        if end_place:
            trip["destination"] = end_place.get("name", "")
            trip["destinationPlaceId"] = str(end_place.get("_id", ""))
        else:
            rev_end = await reverse_geocode_nominatim(en[1], en[0])
            trip["destination"] = rev_end["display_name"] if rev_end else ""

        # Set geo-points for spatial queries
        trip["startGeoPoint"] = {"type": "Point", "coordinates": [st[0], st[1]]}
        trip["destinationGeoPoint"] = {"type": "Point", "coordinates": [en[0], en[1]]}

        return trip

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
