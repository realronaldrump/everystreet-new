import json
import logging
from typing import Optional, Dict, Any
from datetime import timezone

from dateutil import parser
from shapely.geometry import Point

from db import places_collection, find_one_with_retry
from utils import reverse_geocode_nominatim, validate_trip_data

logger = logging.getLogger(__name__)


async def get_place_at_point(point: Point) -> Optional[Dict[str, Any]]:
    """Find a custom place that contains the given point."""
    point_geojson = {"type": "Point", "coordinates": [point.x, point.y]}
    query = {"geometry": {"$geoIntersects": {"$geometry": point_geojson}}}

    return await find_one_with_retry(places_collection, query)


async def process_trip_data(trip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Process a trip by:
    - Validating data
    - Converting timestamps to proper datetime objects
    - Parsing GPS data
    - Determining start/end locations
    - Setting geo-points for spatial queries
    """
    transaction_id = trip.get("transactionId", "?")

    try:
        # Validate the trip
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.warning(
                "Trip %s validation failed: %s", transaction_id, error_message
            )
            return None

        # Create a working copy of the trip
        processed_trip = trip.copy()

        # Parse timestamps
        for key in ("startTime", "endTime"):
            val = processed_trip.get(key)
            if isinstance(val, str):
                dt = parser.isoparse(val)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                processed_trip[key] = dt

        # Parse GPS data
        gps_data = processed_trip.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
                processed_trip["gps"] = gps_data
            except json.JSONDecodeError:
                logger.warning("Trip %s has invalid GPS JSON", transaction_id)
                return None

        # Ensure coordinates exist
        coords = gps_data.get("coordinates", [])
        if len(coords) < 2:
            logger.warning("Trip %s has insufficient coordinates", transaction_id)
            return None

        # Get start and end points
        start_coord = coords[0]
        end_coord = coords[-1]
        start_pt = Point(start_coord[0], start_coord[1])
        end_pt = Point(end_coord[0], end_coord[1])

        # Set geo-points for spatial queries
        processed_trip["startGeoPoint"] = {
            "type": "Point",
            "coordinates": [start_coord[0], start_coord[1]],
        }
        processed_trip["destinationGeoPoint"] = {
            "type": "Point",
            "coordinates": [end_coord[0], end_coord[1]],
        }

        # Determine start location
        if not processed_trip.get("startLocation"):
            start_place = await get_place_at_point(start_pt)
            if start_place:
                processed_trip["startLocation"] = start_place.get("name", "")
                processed_trip["startPlaceId"] = str(start_place.get("_id", ""))
            else:
                rev_start = await reverse_geocode_nominatim(
                    start_coord[1], start_coord[0]
                )
                if rev_start:
                    processed_trip["startLocation"] = rev_start.get("display_name", "")

        # Determine end location
        if not processed_trip.get("destination"):
            end_place = await get_place_at_point(end_pt)
            if end_place:
                processed_trip["destination"] = end_place.get("name", "")
                processed_trip["destinationPlaceId"] = str(end_place.get("_id", ""))
            else:
                rev_end = await reverse_geocode_nominatim(end_coord[1], end_coord[0])
                if rev_end:
                    processed_trip["destination"] = rev_end.get("display_name", "")

        return processed_trip

    except Exception as e:
        logger.error("Error processing trip %s: %s", transaction_id, e)
        return None


def format_idle_time(seconds: Any) -> str:
    """Convert idle time in seconds to a HH:MM:SS string."""
    if not seconds:
        return "00:00:00"

    try:
        total_seconds = int(seconds)
        hrs = total_seconds // 3600
        mins = (total_seconds % 3600) // 60
        secs = total_seconds % 60
        return f"{hrs:02d}:{mins:02d}:{secs:02d}"
    except (TypeError, ValueError):
        logger.error("Invalid input for format_idle_time: %s", seconds)
        return "00:00:00"
