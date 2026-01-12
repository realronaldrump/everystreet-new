"""Business logic for visit detection and tracking."""

import logging
from typing import Any

from date_utils import normalize_to_utc_datetime
from db.aggregation import aggregate_to_list
from db.models import Place, Trip
from db.schemas import PlaceResponse

logger = logging.getLogger(__name__)


class VisitTrackingService:
    """Service class for visit tracking and calculation."""

    @staticmethod
    async def calculate_visits_for_place(place: Place | PlaceResponse) -> list[dict]:
        """
        Calculate visits for a place using a single MongoDB aggregation.

        This avoids the N+1 query pattern by:
        - Matching all trips that end at the place (destinationPlaceId or within geometry)
        - Looking up the next global trip with startTime > arrival endTime
        - Using $setWindowFields to compute time since previous visit's departure

        Args:
            place: Place model or PlaceResponse

        Returns:
            List of visit dicts with arrival_trip, arrival_time, departure_time,
            duration, and time_since_last
        """
        # Handle both Place model and PlaceResponse
        if isinstance(place, PlaceResponse):
            place_id = place.id
            geometry = place.geometry
        else:
            place_id = str(place.id)
            geometry = place.geometry

        # Match trips by destinationPlaceId OR by spatial intersection with place geometry
        # This handles both new trips (with destinationPlaceId set) and older trips
        # that were recorded before the place was created
        match_conditions: list[dict[str, Any]] = [
            {"destinationPlaceId": place_id},
        ]

        # Add spatial matching if place has geometry
        # Note: We can't easily match gps LineString end points against a polygon
        # in the initial $match stage, so we'll need to use aggregation to extract
        # the end point and then filter. However, for trips that already have
        # destinationGeoPoint set, we can match directly.
        if geometry:
            # Match trips whose destinationGeoPoint falls within the place geometry
            match_conditions.append(
                {"destinationGeoPoint": {"$geoWithin": {"$geometry": geometry}}},
            )

        ended_at_place_match = {
            "$or": match_conditions,
            "endTime": {"$ne": None},
        }

        pipeline = [
            {"$match": ended_at_place_match},
            {"$sort": {"endTime": 1}},
            {
                "$lookup": {
                    "from": "trips",
                    "let": {"arrivalEnd": "$endTime"},
                    "pipeline": [
                        {"$match": {"$expr": {"$gt": ["$startTime", "$$arrivalEnd"]}}},
                        {"$sort": {"startTime": 1}},
                        {"$limit": 1},
                        {"$project": {"_id": 0, "startTime": 1}},
                    ],
                    "as": "nextTrip",
                },
            },
            {
                "$addFields": {
                    "departure_time": {"$arrayElemAt": ["$nextTrip.startTime", 0]},
                },
            },
            {
                "$addFields": {
                    "duration_seconds": {
                        "$cond": [
                            {
                                "$and": [
                                    {"$ne": ["$departure_time", None]},
                                    {"$ne": ["$endTime", None]},
                                ],
                            },
                            {
                                "$divide": [
                                    {"$subtract": ["$departure_time", "$endTime"]},
                                    1000,
                                ],
                            },
                            None,
                        ],
                    },
                },
            },
            {
                "$setWindowFields": {
                    "sortBy": {"endTime": 1},
                    "output": {
                        "previous_departure_time": {
                            "$shift": {
                                "output": "$departure_time",
                                "by": -1,
                                "default": None,
                            },
                        },
                    },
                },
            },
            {
                "$addFields": {
                    "time_since_last_seconds": {
                        "$cond": [
                            {
                                "$and": [
                                    {"$ne": ["$previous_departure_time", None]},
                                    {"$ne": ["$endTime", None]},
                                ],
                            },
                            {
                                "$divide": [
                                    {
                                        "$subtract": [
                                            "$endTime",
                                            "$previous_departure_time",
                                        ],
                                    },
                                    1000,
                                ],
                            },
                            None,
                        ],
                    },
                },
            },
            {
                "$project": {
                    "nextTrip": 0,
                    "previous_departure_time": 0,
                },
            },
        ]

        docs = await aggregate_to_list(Trip, pipeline)

        visits: list[dict] = []
        for doc in docs:
            arrival_time = normalize_to_utc_datetime(doc.get("endTime"))
            departure_time = normalize_to_utc_datetime(doc.get("departure_time"))
            duration = doc.get("duration_seconds")
            time_since_last = doc.get("time_since_last_seconds")

            visits.append(
                {
                    "arrival_trip": doc,
                    "arrival_time": arrival_time,
                    "departure_time": departure_time,
                    "duration": duration,
                    "time_since_last": time_since_last,
                },
            )

        return visits

    @staticmethod
    def format_duration(seconds):
        """
        Format duration in seconds to a human-readable string.

        Args:
            seconds: Duration in seconds (can be None or negative)

        Returns:
            Formatted string like "5m 30s", "2h 15m", "3d 4h 30m", or "N/A"
        """
        if seconds is None or seconds < 0:
            return "N/A"

        if seconds < 60:
            return f"{int(seconds)}s"
        if seconds < 3600:
            mins = int(seconds // 60)
            secs = int(seconds % 60)
            return f"{mins}m {secs}s"
        if seconds < 86400:
            hrs = int(seconds // 3600)
            mins = int((seconds % 3600) // 60)
            return f"{hrs}h {mins:02d}m"
        days = int(seconds // 86400)
        hrs = int((seconds % 86400) // 3600)
        mins = int((seconds % 3600) // 60)
        return f"{days}d {hrs}h {mins:02d}m"
