"""Business logic for visit statistics and suggestions."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from db.aggregation import aggregate_to_list
from db.models import Place, Trip
from db.schemas import (
    NonCustomPlaceVisit,
    PlaceResponse,
    PlaceStatisticsResponse,
    PlaceVisitsResponse,
    VisitResponse,
    VisitSuggestion,
)
from visits.services.visit_tracking_service import VisitTrackingService

logger = logging.getLogger(__name__)


class VisitStatsService:
    """Service class for visit statistics and suggestions."""

    @staticmethod
    async def get_place_statistics(
        place: Place | PlaceResponse,
    ) -> PlaceStatisticsResponse:
        """
        Get statistics about visits to a place.

        Args:
            place: Place model or PlaceResponse

        Returns:
            PlaceStatisticsResponse with visit statistics
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

        # Get place name and id
        if isinstance(place, PlaceResponse):
            place_id = place.id
            name = place.name
        else:
            place_id = str(place.id)
            name = place.name or ""

        return PlaceStatisticsResponse(
            id=place_id,
            name=name,
            totalVisits=total_visits,
            averageTimeSpent=VisitTrackingService.format_duration(avg_duration),
            firstVisit=first_visit,
            lastVisit=last_visit,
            averageTimeSinceLastVisit=VisitTrackingService.format_duration(
                avg_time_between,
            ),
        )

    @staticmethod
    async def get_all_places_statistics() -> list[PlaceStatisticsResponse]:
        """
        Get statistics for all custom places.

        Returns:
            List of PlaceStatisticsResponse objects
        """
        places = await Place.find_all().to_list()
        if not places:
            return []

        results = []
        for place_model in places:
            visits = await VisitTrackingService.calculate_visits_for_place(place_model)

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
                PlaceStatisticsResponse(
                    id=str(place_model.id),
                    name=place_model.name or "",
                    totalVisits=total_visits,
                    averageTimeSpent=VisitTrackingService.format_duration(avg_duration),
                    firstVisit=first_visit,
                    lastVisit=last_visit,
                ),
            )
        return results

    @staticmethod
    async def get_trips_for_place(
        place: Place | PlaceResponse,
    ) -> PlaceVisitsResponse:
        """
        Get trips that visited a specific place.

        Args:
            place: Place model or PlaceResponse

        Returns:
            PlaceVisitsResponse with trips list and place name
        """
        visits = await VisitTrackingService.calculate_visits_for_place(place)

        trips_data = []
        for visit in visits:
            trip = visit["arrival_trip"]
            arrival_trip_id = str(trip.get("_id", ""))

            duration_str = VisitTrackingService.format_duration(visit["duration"])
            time_since_last_str = VisitTrackingService.format_duration(
                visit["time_since_last"],
            )

            distance = trip.get("distance", 0)
            if isinstance(distance, dict):
                distance = distance.get("value", 0)

            transaction_id = trip.get("transactionId", arrival_trip_id)

            trips_data.append(
                VisitResponse(
                    id=arrival_trip_id,
                    transactionId=transaction_id,
                    endTime=visit["arrival_time"],
                    departureTime=visit["departure_time"],
                    timeSpent=duration_str,
                    timeSinceLastVisit=time_since_last_str,
                    source=trip.get("source"),
                    distance=distance,
                ),
            )

        # Sort by endTime descending
        trips_data.sort(
            key=lambda x: x.endTime or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        # Get place name
        name = place.name if isinstance(place, PlaceResponse) else place.name or ""

        return PlaceVisitsResponse(trips=trips_data, name=name)

    @staticmethod
    async def get_non_custom_places_visits(
        timeframe: str | None = None,
    ) -> list[NonCustomPlaceVisit]:
        """
        Aggregate visits to non-custom destinations.

        The logic derives a human-readable place name from destination information,
        prioritizing actual place names over addresses:
            1. destinationPlaceName (if present - explicitly set place name)
            2. destination.formatted_address (full address from Nominatim, includes POI names)
            3. destination.address_components.street (street name as last resort)

        Args:
            timeframe: Optional time filter (day|week|month|year)

        Returns:
            List of NonCustomPlaceVisit objects

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
                msg = f"Unsupported timeframe '{timeframe}'. Choose from day, week, month, year."
                raise ValueError(
                    msg,
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
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
            {"$match": {"placeName": {"$ne": None, "$nin": ["", "Unknown"]}}},
            {
                "$group": {
                    "_id": "$placeName",
                    "totalVisits": {"$sum": 1},
                    "firstVisit": {"$min": "$endTime"},
                    "lastVisit": {"$max": "$endTime"},
                },
            },
            {"$sort": {"totalVisits": -1}},
            {"$limit": 100},
        ]

        results = await aggregate_to_list(Trip, pipeline)

        return [
            NonCustomPlaceVisit(
                name=doc["_id"],
                totalVisits=doc["totalVisits"],
                firstVisit=doc.get("firstVisit"),
                lastVisit=doc.get("lastVisit"),
            )
            for doc in results
        ]

    @staticmethod
    async def get_visit_suggestions(
        min_visits: int = 5,
        cell_size_m: int = 250,
        timeframe: str | None = None,
    ) -> list[VisitSuggestion]:
        """
        Suggest areas that are visited often but are not yet custom places.

        This endpoint groups trip destinations without destinationPlaceId
        by a spatial grid (default ~250m x 250m) and returns any cells that have
        at least min_visits visits.

        Args:
            min_visits: Minimum number of visits to suggest a place
            cell_size_m: Grid cell size in meters
            timeframe: Optional time filter (day|week|month|year)

        Returns:
            List of VisitSuggestion objects

        Raises:
            ValueError: If timeframe is invalid
        """
        from shapely.geometry import (
            Point as ShpPoint,
            shape as shp_shape,
        )

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
                msg = "Unsupported timeframe. Choose from day, week, month, year."
                raise ValueError(
                    msg,
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
                        },
                    },
                    "endTime": 1,
                },
            },
            {
                "$project": {
                    "lng": {"$arrayElemAt": ["$coordinates", 0]},
                    "lat": {"$arrayElemAt": ["$coordinates", 1]},
                    "endTime": 1,
                },
            },
            {
                "$addFields": {
                    "lngCell": {
                        "$round": [
                            {"$multiply": ["$lng", cell_precision]},
                            0,
                        ],
                    },
                    "latCell": {
                        "$round": [
                            {"$multiply": ["$lat", cell_precision]},
                            0,
                        ],
                    },
                },
            },
            {
                "$group": {
                    "_id": {"lng": "$lngCell", "lat": "$latCell"},
                    "totalVisits": {"$sum": 1},
                    "firstVisit": {"$min": "$endTime"},
                    "lastVisit": {"$max": "$endTime"},
                    "avgLng": {"$avg": "$lng"},
                    "avgLat": {"$avg": "$lat"},
                },
            },
            {"$match": {"totalVisits": {"$gte": min_visits}}},
            {"$sort": {"totalVisits": -1}},
            {"$limit": 50},
        ]

        clusters = await aggregate_to_list(Trip, pipeline)

        # Build list of existing custom place polygons for overlap check
        existing_places = await Place.find_all().to_list()
        existing_polygons = []
        for place in existing_places:
            try:
                if place.geometry:
                    existing_polygons.append(shp_shape(place.geometry))
            except Exception:
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
                    ],
                ],
            }

            suggestions.append(
                VisitSuggestion(
                    suggestedName=f"Area near {round(center_lat, 3)}, {round(center_lng, 3)}",
                    totalVisits=c["totalVisits"],
                    firstVisit=c.get("firstVisit"),
                    lastVisit=c.get("lastVisit"),
                    centroid=[center_lng, center_lat],
                    boundary=boundary,
                ),
            )

        return suggestions
