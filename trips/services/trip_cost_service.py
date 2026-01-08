"""Business logic for trip gas cost calculations."""

import bisect
import logging

from date_utils import parse_timestamp
from db import gas_fillups_collection
from trips.serializers import _safe_float

logger = logging.getLogger(__name__)


class TripCostService:
    """Service class for trip gas cost calculations."""

    @staticmethod
    async def get_fillup_price_map(query=None):
        """Fetches valid gas fill-ups and organizes them by IMEI for efficient lookup.

        Args:
            query: Optional MongoDB query filter

        Returns:
            dict: { imei: ([timestamps], [prices]) } where lists are sorted by timestamp.
        """
        if query is None:
            query = {}

        # Ensure we only get fill-ups with valid price, time, and IMEI
        fillup_query = {
            **query,
            "price_per_gallon": {"$ne": None},
            "fillup_time": {"$ne": None},
            "imei": {"$ne": None},
        }

        projection = {"imei": 1, "fillup_time": 1, "price_per_gallon": 1}
        # Sort by time to ensure ordered lists
        cursor = gas_fillups_collection.find(fillup_query, projection).sort(
            "fillup_time", 1
        )

        price_map = {}
        async for fillup in cursor:
            imei = fillup.get("imei")
            ts = fillup.get("fillup_time")
            price = fillup.get("price_per_gallon")

            if imei not in price_map:
                price_map[imei] = ([], [])

            if ts and price:
                # Robustly handle string timestamps
                if isinstance(ts, str):
                    ts = parse_timestamp(ts)
                    if ts is None:
                        continue

                price_map[imei][0].append(ts)
                price_map[imei][1].append(price)

        # Ensure lists are strictly sorted by timestamp (in case mixed types messed up Mongo sort or order)
        for imei in price_map:
            if price_map[imei][0]:
                # Zip and sort by timestamp
                combined = sorted(
                    zip(price_map[imei][0], price_map[imei][1], strict=False),
                    key=lambda x: x[0],
                )
                price_map[imei] = ([x[0] for x in combined], [x[1] for x in combined])

        return price_map

    @staticmethod
    def calculate_trip_cost(trip, price_map):
        """Calculates estimated cost for a trip based on fuel consumed and historical gas prices.

        Args:
            trip (dict): Trip document with 'fuelConsumed', 'imei', 'startTime'
            price_map (dict): Output from get_fillup_price_map

        Returns:
            float | None: Estimated cost or None if data is missing
        """
        fuel_consumed = _safe_float(trip.get("fuelConsumed"), None)
        imei = trip.get("imei")
        start_time = parse_timestamp(trip.get("startTime"))

        if fuel_consumed is None or not imei or not start_time or imei not in price_map:
            return None

        timestamps, prices = price_map[imei]
        if not timestamps:
            return None

        # Find the insertion point for start_time in timestamps to get the most recent past fill-up
        # bisect_right returns an insertion point after (to the right of) any existing entries of x in a.
        # The element to the left of this index is the one <= start_time
        try:
            idx = bisect.bisect_right(timestamps, start_time)

            if idx > 0:
                # We found a fill-up that happened before (or at) the trip start
                relevant_price = prices[idx - 1]
                return _safe_float(fuel_consumed, 0) * _safe_float(relevant_price, 0)
        except (TypeError, ValueError):
            # Fallback for any remaining type comparison issues
            return None

        return None
