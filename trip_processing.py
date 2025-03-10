import json
import logging
from typing import Optional, Dict, Any
from datetime import timezone

from dateutil import parser
from shapely.geometry import Point

from db import places_collection, find_one_with_retry
from utils import reverse_geocode_nominatim, validate_trip_data
from trip_processor import TripProcessor

logger = logging.getLogger(__name__)


async def get_place_at_point(point: Point) -> Optional[Dict[str, Any]]:
    """Find a custom place that contains the given point."""
    point_geojson = {"type": "Point", "coordinates": [point.x, point.y]}
    query = {"geometry": {"$geoIntersects": {"$geometry": point_geojson}}}

    return await find_one_with_retry(places_collection, query)


async def process_trip_data(trip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Process a trip using the unified TripProcessor.

    This function maintains backward compatibility with existing code.
    """
    import os

    # Create processor
    processor = TripProcessor(
        mapbox_token=os.getenv("MAPBOX_ACCESS_TOKEN", ""), source="api"
    )
    processor.set_trip_data(trip)

    # Process without map matching
    await processor.process(do_map_match=False)

    # Return the processed data
    return processor.processed_data


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
