"""Business logic for visit statistics and suggestions."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from db import aggregate_with_retry, find_with_retry, serialize_datetime
from visits.services.collections import Collections
from visits.services.visit_tracking_service import VisitTrackingService

logger = logging.getLogger(__name__)


class VisitStatsService:
    """Service class for visit statistics and suggestions."""

    @staticmethod
    async def get_place_statistics(place: dict) -> dict[str, Any]:
        """Get statistics about visits to a place.

        Args:
            place: Place document

        Returns:
            Dictionary with totalVisits, averageTimeSpent, firstVisit,
            lastVisit, averageTimeSinceLastVisit, and name
        """
        visits = await VisitTrackingService.calculate_visits_for_place(place)

        total_visits = len(visits)
        durations = [
            v["duration"]
            for v in visits
            if v.get("duration") is not None and v["duration"] >= 0
        ]
        time_between_visits = [
            v["time_since_last"]
            for v in visits
            if v.get("time_since_last") is not None and v["time_since_last"] >= 0
        ]

        avg_duration = sum(durations) / len(durations) if durations else None
        avg_time_between = (
            sum(time_between_visits) / len(time_between_visits)
            if time_between_visits
            else None
        )

        first_visit = min((v["arrival_time"] for v in visits), default=None)
        last_visit = max((v["arrival_time"] for v in visits), default=None)

        return {
            "totalVisits": total_visits,
            "averageTimeSpent": VisitTrackingService.format_duration(avg_duration),
            "firstVisit": serialize_datetime(first_visit),
            "lastVisit": serialize_datetime(last_visit),
            "averageTimeSinceLastVisit": VisitTrackingService.format_duration(
                avg_time_between
            ),
            "name": place["name"],
        }

    @staticmethod
    async def get_all_places_statistics() -> list[dict[str, Any]]:
        """Get statistics for all custom places.

        Returns:
            List of place statistics dictionaries
        """
        places = await find_with_retry(Collections.places, {})
        if not places:
            return []

        results = []
        for place in places:
            visits = await VisitTrackingService.calculate_visits_for_place(place)

            total_visits = len(visits)
            durations = [
                v["duration"]
                for v in visits
                if v.get("duration") is not None and v["duration"] >= 0
            ]

            avg_duration = sum(durations) / len(durations) if durations else None

            first_visit = min((v["arrival_time"] for v in visits), default=None)
            last_visit = max((v["arrival_time"] for v in visits), default=None)

            results.append(
                {
                    "_id": str(place["_id"]),
                    "name": place["name"],
                    "totalVisits": total_visits,
                    "averageTimeSpent": VisitTrackingService.format_duration(
                        avg_duration
                    ),
                    "firstVisit": serialize_datetime(first_visit),
                    "lastVisit": serialize_datetime(last_visit),
                }
            )
        return results

    @staticmethod
    async def get_trips_for_place(place: dict) -> dict[str, Any]:
        """Get trips that visited a specific place.

        Args:
            place: Place document

        Returns:
            Dictionary with trips list and place name
        """
        visits = await VisitTrackingService.calculate_visits_for_place(place)

        trips_data = []
        for visit in visits:
            trip = visit["arrival_trip"]
            arrival_trip_id = str(trip["_id"])

            duration_str = VisitTrackingService.format_duration(visit["duration"])
            time_since_last_str = VisitTrackingService.format_duration(
                visit["time_since_last"]
            )

            distance = trip.get("distance", 0)
            if isinstance(distance, dict):
                distance = distance.get("value", 0)

            transaction_id = trip.get("transactionId", arrival_trip_id)

            trips_data.append(
                {
                    "id": arrival_trip_id,
                    "transactionId": transaction_id,
                    "endTime": serialize_datetime(visit["arrival_time"]),
                    "departureTime": (
                        serialize_datetime(visit["departure_time"])
                        if visit["departure_time"]
                        else None
                    ),
                    "timeSpent": duration_str,
                    "timeSinceLastVisit": time_since_last_str,
                    "source": trip.get("source", "unknown"),
                    "distance": distance,
                }
            )

        trips_data.sort(key=lambda x: x["endTime"], reverse=True)

        return {"trips": trips_data, "name": place["name"]}

    @staticmethod
    async def get_non_custom_places_visits(
        timeframe: str | None = None,
    ) -> list[dict[str, Any]]:
        """Aggregate visits to non-custom destinations.

        The logic derives a human-readable place name from destination information,
        prioritizing actual place names over addresses:
            1. destinationPlaceName (if present - explicitly set place name)
            2. destination.formatted_address (full address from Mapbox, includes POI names)
            3. destination.address_components.street (street name as last resort)

        Args:
            timeframe: Optional time filter (day|week|month|year)

        Returns:
            List of non-custom place visit statistics

        Raises:
            ValueError: If timeframe is invalid
        """
        match_stage: dict[str, Any] = {
            "destinationPlaceId": {"$exists": False},
            "$or": [
                {"destinationPlaceName": {"$exists": True, "$ne": None}},
                {"destination.formatted_address": {"$exists": True, "$ne": ""}},
                {"destination.address_components.street": {"$exists": True, "$ne": ""}},
            ],
        }

        if timeframe:
            timeframe = timeframe.lower()
            now = datetime.now(UTC)
            delta_map = {
                "day": timedelta(days=1),
                "week": timedelta(weeks=1),
                "month": timedelta(days=30),
                "year": timedelta(days=365),
            }
            if timeframe not in delta_map:
                raise ValueError(
                    f"Unsupported timeframe '{timeframe}'. Choose from day, week, month, year."
                )

            start_date = now - delta_map[timeframe]
            match_stage["endTime"] = {"$gte": start_date}

        pipeline = [
            {"$match": match_stage},
            {
                "$addFields": {
                    "placeName": {
                        "$ifNull": [
                            "$destinationPlaceName",
                            {
                                "$ifNull": [
                                    "$destination.formatted_address",
                                    {
                                        "$ifNull": [
                                            "$destination.address_components.street",
                                            "Unknown",
                                        ]
                                    },
                                ]
                            },
                        ]
                    }
                }
            },
            {"$match": {"placeName": {"$ne": None, "$nin": ["", "Unknown"]}}},
            {
                "$group": {
                    "_id": "$placeName",
                    "totalVisits": {"$sum": 1},
                    "firstVisit": {"$min": "$endTime"},
                    "lastVisit": {"$max": "$endTime"},
                }
            },
            {"$sort": {"totalVisits": -1}},
            {"$limit": 100},
        ]

        results = await aggregate_with_retry(Collections.trips, pipeline)

        places_data = [
            {
                "name": doc["_id"],
                "totalVisits": doc["totalVisits"],
                "firstVisit": serialize_datetime(doc["firstVisit"]),
                "lastVisit": serialize_datetime(doc["lastVisit"]),
            }
            for doc in results
        ]

        return places_data

    @staticmethod
    async def get_visit_suggestions(
        min_visits: int = 5,
        cell_size_m: int = 250,
        timeframe: str | None = None,
    ) -> list[dict[str, Any]]:
        """Suggest areas that are visited often but are not yet custom places.

        This endpoint groups trip destinations without destinationPlaceId
        by a spatial grid (default ~250m x 250m) and returns any cells that have
        at least min_visits visits.

        Args:
            min_visits: Minimum number of visits to suggest a place
            cell_size_m: Grid cell size in meters
            timeframe: Optional time filter (day|week|month|year)

        Returns:
            List of suggested places with suggestedName, totalVisits,
            firstVisit, lastVisit, centroid, and boundary

        Raises:
            ValueError: If timeframe is invalid
        """
        from shapely.geometry import Point as ShpPoint
        from shapely.geometry import shape as shp_shape

        match_stage: dict[str, Any] = {
            "destinationPlaceId": {"$exists": False},
            "gps": {"$exists": True},
        }

        if timeframe:
            timeframe = timeframe.lower()
            now = datetime.now(UTC)
            delta_map = {
                "day": timedelta(days=1),
                "week": timedelta(weeks=1),
                "month": timedelta(days=30),
                "year": timedelta(days=365),
            }
            if timeframe not in delta_map:
                raise ValueError(
                    "Unsupported timeframe. Choose from day, week, month, year."
                )

            match_stage["endTime"] = {"$gte": now - delta_map[timeframe]}

        # Grid bucketing - approximate a cell by truncating coordinates
        cell_precision = max(1, int(1 / (cell_size_m / 111_320)))  # ~meters/deg

        pipeline = [
            {"$match": match_stage},
            {
                "$project": {
                    "coordinates": {
                        "$cond": {
                            "if": {"$eq": ["$gps.type", "Point"]},
                            "then": "$gps.coordinates",
                            "else": {"$arrayElemAt": ["$gps.coordinates", -1]},
                        }
                    },
                    "endTime": 1,
                }
            },
            {
                "$project": {
                    "lng": {"$arrayElemAt": ["$coordinates", 0]},
                    "lat": {"$arrayElemAt": ["$coordinates", 1]},
                    "endTime": 1,
                }
            },
            {
                "$addFields": {
                    "lngCell": {
                        "$round": [
                            {"$multiply": ["$lng", cell_precision]},
                            0,
                        ]
                    },
                    "latCell": {
                        "$round": [
                            {"$multiply": ["$lat", cell_precision]},
                            0,
                        ]
                    },
                }
            },
            {
                "$group": {
                    "_id": {"lng": "$lngCell", "lat": "$latCell"},
                    "totalVisits": {"$sum": 1},
                    "firstVisit": {"$min": "$endTime"},
                    "lastVisit": {"$max": "$endTime"},
                    "avgLng": {"$avg": "$lng"},
                    "avgLat": {"$avg": "$lat"},
                }
            },
            {"$match": {"totalVisits": {"$gte": min_visits}}},
            {"$sort": {"totalVisits": -1}},
            {"$limit": 50},
        ]

        clusters = await aggregate_with_retry(Collections.trips, pipeline)

        # Build list of existing custom place polygons for overlap check
        existing_places = await find_with_retry(
            Collections.places, {}, projection={"geometry": 1}
        )
        existing_polygons = []
        for p in existing_places:
            try:
                g = p.get("geometry")
                if g:
                    existing_polygons.append(shp_shape(g))
            except Exception:  # noqa: BLE001
                continue

        def overlaps_existing(lng: float, lat: float) -> bool:
            pt = ShpPoint(lng, lat)
            return any(poly.contains(pt) for poly in existing_polygons)

        # Convert each bucket to square polygon boundary & remove overlaps
        suggestions = []
        cell_deg = 1 / cell_precision
        half = cell_deg / 2

        for c in clusters:
            center_lng = c["avgLng"]
            center_lat = c["avgLat"]

            # Skip if inside an existing place
            if overlaps_existing(center_lng, center_lat):
                continue

            boundary = {
                "type": "Polygon",
                "coordinates": [
                    [
                        [center_lng - half, center_lat - half],
                        [center_lng + half, center_lat - half],
                        [center_lng + half, center_lat + half],
                        [center_lng - half, center_lat + half],
                        [center_lng - half, center_lat - half],
                    ]
                ],
            }

            suggestions.append(
                {
                    "suggestedName": f"Area near {round(center_lat, 3)}, {round(center_lng, 3)}",
                    "totalVisits": c["totalVisits"],
                    "firstVisit": serialize_datetime(c["firstVisit"]),
                    "lastVisit": serialize_datetime(c["lastVisit"]),
                    "centroid": [center_lng, center_lat],
                    "boundary": boundary,
                }
            )

        return suggestions
