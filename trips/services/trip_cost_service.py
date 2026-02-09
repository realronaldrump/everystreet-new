"""Business logic for trip gas cost calculations."""

import bisect

from core.casting import safe_float
from core.date_utils import parse_timestamp
from db.models import GasFillup


class TripCostService:
    """Service class for trip gas cost calculations."""

    @staticmethod
    async def get_fillup_price_map(query=None):
        """
        Fetches gas fill-ups and organizes an effective $/gallon series by IMEI for
        efficient lookup.

        Effective price is derived as:
        - Prefer `total_cost / gallons` when available (captures taxes/rounding).
        - Fall back to `price_per_gallon` when total_cost is missing.

        Args:
            query: Optional MongoDB query filter

        Returns:
            dict: { imei: ([timestamps], [prices]) } where lists are sorted by timestamp.
        """
        if query is None:
            query = {}

        # Ensure we only get fill-ups with usable price info, time, and IMEI.
        # We accept either explicit `price_per_gallon` or derived `total_cost/gallons`.
        fillup_query = {
            **query,
            "fillup_time": {"$ne": None},
            "imei": {"$ne": None},
            "$or": [
                {"price_per_gallon": {"$ne": None}},
                {"$and": [{"total_cost": {"$ne": None}}, {"gallons": {"$ne": None}}]},
            ],
        }

        # Use Beanie cursor iteration
        price_map = {}
        async for fillup in GasFillup.find(fillup_query).sort(GasFillup.fillup_time):
            imei = fillup.imei
            ts = fillup.fillup_time
            gallons = safe_float(fillup.gallons, None)
            total_cost = safe_float(fillup.total_cost, None)
            ppg = safe_float(fillup.price_per_gallon, None)

            # Prefer total_cost-derived price when possible.
            effective_ppg = None
            if total_cost is not None and gallons is not None and gallons > 0:
                effective_ppg = total_cost / gallons
            elif ppg is not None:
                effective_ppg = ppg

            if imei not in price_map:
                price_map[imei] = ([], [])

            if ts and effective_ppg is not None and effective_ppg > 0:
                # Robustly handle string timestamps
                if isinstance(ts, str):
                    ts = parse_timestamp(ts)
                    if ts is None:
                        continue

                price_map[imei][0].append(ts)
                price_map[imei][1].append(effective_ppg)

        # Ensure lists are strictly sorted by timestamp
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
        """
        Calculates estimated cost for a trip based on fuel consumed and historical gas
        prices.

        Args:
            trip (dict): Trip document with 'fuelConsumed', 'imei', and timestamps
                (`endTime` preferred, fallback to `startTime`)
            price_map (dict): Output from get_fillup_price_map

        Returns:
            float | None: Estimated cost or None if data is missing
        """
        fuel_consumed = safe_float(trip.get("fuelConsumed"), None)
        imei = trip.get("imei")
        ref_time = parse_timestamp(trip.get("endTime") or trip.get("startTime"))

        if fuel_consumed is None or not imei or not ref_time or imei not in price_map:
            return None

        timestamps, prices = price_map[imei]
        if not timestamps:
            return None

        # Find the insertion point for ref_time in timestamps to get the most recent
        # past fill-up (at or before the trip reference time).
        try:
            idx = bisect.bisect_right(timestamps, ref_time)

            if idx > 0:
                # We found a fill-up that happened before (or at) the trip start
                relevant_price = prices[idx - 1]
                return safe_float(fuel_consumed, 0) * safe_float(relevant_price, 0)
        except (TypeError, ValueError):
            # Fallback for any remaining type comparison issues
            return None

        return None
