"""
Map matching module.
Uses TripProcessor for all map matching functionality.
This module is retained for backward compatibility.
"""

import logging
import os
from typing import Dict, Any

from dotenv import load_dotenv
from trip_processor import TripProcessor

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def process_and_map_match_trip(trip: Dict[str, Any]) -> None:
    """
    Process a trip: validate, extract GPS, map-match via Mapbox, reverse geocode,
    and store the matched trip.

    Now simply a wrapper around TripProcessor for backward compatibility.
    """
    try:
        transaction_id = trip.get("transactionId", "?")

        # Create processor and process the trip
        processor = TripProcessor(
            mapbox_token=MAPBOX_ACCESS_TOKEN, source="api")
        processor.set_trip_data(trip)

        # Process with map matching
        await processor.process(do_map_match=True)

        # Save to matched_trips collection
        await processor.save(map_match_result=True)

        logger.info(
            "Map matched trip %s and saved to matched_trips collection",
            transaction_id)

    except Exception as e:
        logger.error(
            "Error in process_and_map_match_trip for trip %s: %s",
            trip.get("transactionId"),
            e,
            exc_info=True,
        )
