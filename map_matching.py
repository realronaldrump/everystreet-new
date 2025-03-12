"""
Map matching module.
Provides a clean wrapper around TripProcessor for backward compatibility.
"""

import logging
import os
from typing import Dict, Any, Optional

from dotenv import load_dotenv
from trip_processor import TripProcessor

load_dotenv()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def process_and_map_match_trip(trip: Dict[str, Any]) -> bool:
    """
    Process a trip: validate, extract GPS, map-match via Mapbox, reverse geocode,
    and store the matched trip.

    Args:
        trip: The trip data to process and map match

    Returns:
        bool: True if successful, False otherwise
    """
    try:
        transaction_id = trip.get("transactionId", "?")
        logger.info(f"Starting map matching for trip {transaction_id}")

        # Create processor and process the trip
        processor = TripProcessor(mapbox_token=MAPBOX_ACCESS_TOKEN, source="api")
        processor.set_trip_data(trip)

        # Process with map matching
        await processor.process(do_map_match=True)

        # Save to matched_trips collection
        result = await processor.save(map_match_result=True)

        if result:
            logger.info(
                f"Map matched trip {transaction_id} and saved to matched_trips collection"
            )
            return True
        else:
            logger.warning(f"Failed to save map matched trip {transaction_id}")
            return False

    except Exception as e:
        logger.error(
            f"Error in process_and_map_match_trip for trip {trip.get('transactionId')}: {e}",
            exc_info=True,
        )
        return False
