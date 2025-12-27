"""Visits module for the street coverage application.

This module handles all functionality related to places and visits, including
creating, retrieving, and analyzing visit data.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from date_utils import parse_timestamp
from db import (
    aggregate_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    insert_one_with_retry,
    serialize_datetime,
    update_one_with_retry,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["visits"])


class PlaceModel(BaseModel):
    """Model for custom place data."""

    name: str
    geometry: dict[str, Any]


class CustomPlace:
    """A utility class for user-defined places."""

    def __init__(
        self,
        name: str,
        geometry: dict,
        created_at: datetime | None = None,
    ):
        """Initialize a CustomPlace.

        Args:
            name: The name of the place
            geometry: GeoJSON geometry object defining the place boundaries
            created_at: When the place was created, defaults to current UTC time
        """
        self.name = name
        self.geometry = geometry
        self.created_at = created_at or datetime.now(UTC)

    def to_dict(self) -> dict[str, Any]:
        """Convert the CustomPlace to a dictionary for storage.

        Returns:
            Dict with the place's data
        """
        return {
            "name": self.name,
            "geometry": self.geometry,
            "created_at": self.created_at.isoformat(),
        }

    @staticmethod
    def from_dict(data: dict) -> "CustomPlace":
        """Create a CustomPlace from a dictionary.

        Args:
            data: Dictionary with place data

        Returns:
            CustomPlace instance
        """
        created_raw = data.get("created_at")
        if isinstance(created_raw, str):
            created = datetime.fromisoformat(created_raw)
        elif isinstance(created_raw, datetime):
            created = created_raw
        else:
            created = datetime.now(UTC)
        return CustomPlace(
            name=data["name"],
            geometry=data["geometry"],
            created_at=created,
        )


class Collections:
    places = None
    trips = None


def init_collections(places_coll, trips_coll):
    """Initialize the database collections for this module.

    Args:
        places_coll: MongoDB collection for places
        trips_coll: MongoDB collection for trips
    """
    Collections.places = places_coll
    Collections.trips = trips_coll


@router.get("/places")
async def get_places():
    """Get all custom places."""
    places = await find_with_retry(Collections.places, {})
    return [
        {
            "_id": str(p["_id"]),
            **CustomPlace.from_dict(p).to_dict(),
        }
        for p in places
    ]


@router.post("/places")
async def create_place(place: PlaceModel):
    """Create a new custom place."""
    place_obj = CustomPlace(place.name, place.geometry)
    result = await insert_one_with_retry(
        Collections.places,
        place_obj.to_dict(),
    )
    return {
        "_id": str(result.inserted_id),
        **place_obj.to_dict(),
    }


@router.delete("/places/{place_id}")
async def delete_place(place_id: str):
    """Delete a custom place."""
    try:
        await delete_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
        )
        return {
            "status": "success",
            "message": "Place deleted",
        }
    except Exception as e:
        logger.exception("Error deleting place: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


class PlaceUpdateModel(BaseModel):
    """Model for updating a custom place."""

    name: str | None = None
    geometry: dict[str, Any] | None = None


@router.patch("/places/{place_id}")
async def update_place(place_id: str, update_data: PlaceUpdateModel):
    """Update a custom place (name and/or geometry)."""
    try:
        place = await find_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
        )
        if not place:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Place not found",
            )

        update_fields = {}
        if update_data.name is not None:
            update_fields["name"] = update_data.name
        if update_data.geometry is not None:
            update_fields["geometry"] = update_data.geometry

        if not update_fields:
            return {
                "_id": place_id,
                **CustomPlace.from_dict(place).to_dict(),
            }

        await update_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
            {"$set": update_fields},
        )

        updated_place = await find_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
        )
        return {
            "_id": place_id,
            **CustomPlace.from_dict(updated_place).to_dict(),
        }
    except Exception as e:
        logger.exception("Error updating place: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


def format_duration(seconds):
    """Format duration in seconds to a human-readable string."""
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


def parse_time(time_value):
    """Parse a time value into a timezone-aware datetime."""
    if not time_value:
        return None
    if isinstance(time_value, str):
        return parse_timestamp(time_value)
    if time_value.tzinfo is None:
        return time_value.astimezone(UTC)
    return time_value


async def _calculate_visits_for_place_agg(place: dict) -> list[dict]:
    """Calculate visits for a place using a single MongoDB aggregation.

    This avoids the N+1 query pattern by:
    - Matching all trips that end at the place (destinationPlaceId or within geometry)
    - Looking up the next global trip with startTime > arrival endTime
    - Using $setWindowFields to compute time since previous visit's departure

    Returns a list of visit dicts compatible with the existing callers.
    """
    place_id = str(place["_id"])

    ended_at_place_match = {
        "$or": [
            {"destinationPlaceId": place_id},
            {
                "destinationGeoPoint": {
                    "$geoWithin": {"$geometry": place["geometry"]},
                }
            },
        ],
        "endTime": {"$ne": None},
    }

    pipeline = [
        {"$match": ended_at_place_match},
        {"$sort": {"endTime": 1}},
        {
            "$lookup": {
                "from": (
                    Collections.trips.name
                    if hasattr(Collections.trips, "name")
                    else "trips"
                ),
                "let": {"arrivalEnd": "$endTime"},
                "pipeline": [
                    {"$match": {"$expr": {"$gt": ["$startTime", "$$arrivalEnd"]}}},
                    {"$sort": {"startTime": 1}},
                    {"$limit": 1},
                    {"$project": {"_id": 0, "startTime": 1}},
                ],
                "as": "nextTrip",
            }
        },
        {
            "$addFields": {
                "departure_time": {"$arrayElemAt": ["$nextTrip.startTime", 0]},
            }
        },
        {
            "$addFields": {
                "duration_seconds": {
                    "$cond": [
                        {
                            "$and": [
                                {"$ne": ["$departure_time", None]},
                                {"$ne": ["$endTime", None]},
                            ]
                        },
                        {
                            "$divide": [
                                {"$subtract": ["$departure_time", "$endTime"]},
                                1000,
                            ]
                        },
                        None,
                    ]
                }
            }
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
                        }
                    }
                },
            }
        },
        {
            "$addFields": {
                "time_since_last_seconds": {
                    "$cond": [
                        {
                            "$and": [
                                {"$ne": ["$previous_departure_time", None]},
                                {"$ne": ["$endTime", None]},
                            ]
                        },
                        {
                            "$divide": [
                                {"$subtract": ["$endTime", "$previous_departure_time"]},
                                1000,
                            ]
                        },
                        None,
                    ]
                }
            }
        },
        {
            "$project": {
                "nextTrip": 0,
                "previous_departure_time": 0,
            }
        },
    ]

    docs = await aggregate_with_retry(Collections.trips, pipeline)

    visits: list[dict] = []
    for doc in docs:
        arrival_time = parse_time(doc.get("endTime"))
        departure_time = (
            parse_time(doc.get("departure_time")) if doc.get("departure_time") else None
        )
        duration = doc.get("duration_seconds")
        time_since_last = doc.get("time_since_last_seconds")

        visits.append(
            {
                "arrival_trip": doc,
                "arrival_time": arrival_time,
                "departure_time": departure_time,
                "duration": duration,
                "time_since_last": time_since_last,
            }
        )

    return visits


@router.get("/places/{place_id}/statistics")
async def get_place_statistics(place_id: str):
    """Get statistics about visits to a place using robust calculation."""
    try:
        place = await find_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
        )
        if not place:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Place not found",
            )

        # Use aggregation-based calculation to avoid N+1
        visits = await _calculate_visits_for_place_agg(place)

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

        avg_duration = sum(durations) / len(durations) if durations else 0
        avg_time_between = (
            sum(time_between_visits) / len(time_between_visits)
            if time_between_visits
            else 0
        )

        first_visit = min((v["arrival_time"] for v in visits), default=None)
        last_visit = max((v["arrival_time"] for v in visits), default=None)

        return {
            "totalVisits": total_visits,
            "averageTimeSpent": format_duration(avg_duration),
            "firstVisit": serialize_datetime(first_visit),
            "lastVisit": serialize_datetime(last_visit),
            "averageTimeSinceLastVisit": format_duration(avg_time_between),
            "name": place["name"],
        }

    except Exception as e:
        logger.exception("Error getting place statistics for %s: %s", place_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/places/{place_id}/trips")
async def get_trips_for_place(place_id: str):
    """Get trips that visited a specific place, with corrected duration logic."""
    try:
        place = await find_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
        )
        if not place:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Place not found",
            )

        # Use aggregation-based calculation to avoid N+1
        visits = await _calculate_visits_for_place_agg(place)

        trips_data = []
        for visit in visits:
            trip = visit["arrival_trip"]
            arrival_trip_id = str(trip["_id"])

            duration_str = format_duration(visit["duration"])
            time_since_last_str = format_duration(visit["time_since_last"])

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

    except Exception as e:
        logger.exception("Error getting trips for place %s: %s", place_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/non_custom_places_visits")
async def get_non_custom_places_visits(timeframe: str | None = None):
    """Aggregate visits to *non-custom* destinations.

    The logic derives a human-readable *place name* from destination information,
    prioritizing actual place names over addresses:

       1. ``destinationPlaceName`` (if present - explicitly set place name)
       2. ``destination.formatted_address`` (full address from Mapbox, includes POI names)
       3. ``destination.address_components.street`` (street name as last resort)

    Supports an optional ``timeframe`` query-param (``day`` | ``week`` |
    ``month`` | ``year``). When supplied, only trips whose *endTime* falls
    inside that rolling window are considered.
    """
    from datetime import datetime, timedelta  # Local import to avoid circular issues

    try:
        # ------------------------------------------------------------------
        # Build the dynamic $match stage
        # ------------------------------------------------------------------
        match_stage: dict[str, Any] = {
            # Exclude trips that already map to a custom place
            "destinationPlaceId": {"$exists": False},
            # Require that we at least have *some* destination information
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
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unsupported timeframe '{timeframe}'. Choose from day, week, month, year.",
                )

            start_date = now - delta_map[timeframe]
            match_stage["endTime"] = {"$gte": start_date}

        # ------------------------------------------------------------------
        # Build the aggregation pipeline
        # ------------------------------------------------------------------
        pipeline = [
            {"$match": match_stage},
            # Consolidate a single 'placeName' field
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
            # Filter out docs where placeName is still null/Unknown
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
    except Exception as e:
        logger.exception("Error getting non-custom places visits: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/places/statistics")
async def get_all_places_statistics():
    """Get statistics for all custom places using robust, efficient calculation."""
    try:
        places = await find_with_retry(Collections.places, {})
        if not places:
            return []

        results = []
        for place in places:
            # Use aggregation-based calculation per place to avoid loading all trips
            visits = await _calculate_visits_for_place_agg(place)

            total_visits = len(visits)
            durations = [
                v["duration"]
                for v in visits
                if v.get("duration") is not None and v["duration"] >= 0
            ]

            avg_duration = sum(durations) / len(durations) if durations else 0

            first_visit = min((v["arrival_time"] for v in visits), default=None)
            last_visit = max((v["arrival_time"] for v in visits), default=None)

            results.append(
                {
                    "_id": str(place["_id"]),
                    "name": place["name"],
                    "totalVisits": total_visits,
                    "averageTimeSpent": format_duration(avg_duration),
                    "firstVisit": serialize_datetime(first_visit),
                    "lastVisit": serialize_datetime(last_visit),
                }
            )
        return results
    except Exception as e:
        logger.exception("Error in get_all_places_statistics: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ========================================================================== #
#  SUGGESTED CUSTOM PLACES                                                  #
# ========================================================================== #


@router.get("/visit_suggestions")
async def get_visit_suggestions(
    min_visits: int = 5,
    cell_size_m: int = 250,
    timeframe: str | None = None,
):
    """Suggest areas that are visited often but are *not* yet custom places.

    This endpoint groups trip destinations **without** ``destinationPlaceId``
    by a spatial grid (default ≈250 m × 250 m) and returns any cells that have
    at least ``min_visits`` visits.  It supports an optional rolling
    ``timeframe`` (day/week/month/year) similar to other endpoints.

    The response is a list of dictionaries:

        [
            {
              "suggestedName": "Downtown Coffee Strip",
              "totalVisits": 17,
              "firstVisit": "…",
              "lastVisit": "…",
              "centroid": [lng, lat],
              "boundary": { …GeoJSON Polygon… }
            },
            …
        ]

    where *boundary* is a square cell polygon the frontend can edit/fine-tune
    before saving as a real custom place.
    """

    from datetime import datetime, timedelta  # Local import

    try:
        match_stage: dict[str, Any] = {
            "destinationPlaceId": {"$exists": False},
            # Ensure destinationGeoPoint has coordinates (i.e., is a GeoJSON point)
            "destinationGeoPoint.type": "Point",
            "destinationGeoPoint.coordinates": {"$exists": True, "$ne": []},
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
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        "Unsupported timeframe. Choose from day, week, month, year."
                    ),
                )

            match_stage["endTime"] = {"$gte": now - delta_map[timeframe]}

        # ------------------------------------------------------------------
        # Grid bucketing – approximate a cell by truncating coordinates to a
        # fixed precision.  0.0025° ≈ 277 m at the equator.
        # ------------------------------------------------------------------

        cell_precision = max(1, int(1 / (cell_size_m / 111_320)))  # ~meters/deg

        pipeline = [
            {"$match": match_stage},
            {
                "$project": {
                    "lng": {"$arrayElemAt": ["$destinationGeoPoint.coordinates", 0]},
                    "lat": {"$arrayElemAt": ["$destinationGeoPoint.coordinates", 1]},
                    "endTime": 1,
                }
            },
            # Bucket key = rounded lng/lat
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

        # ------------------------------------------------------------------
        # Build list of existing custom place polygons for overlap check
        # ------------------------------------------------------------------
        from shapely.geometry import Point as ShpPoint
        from shapely.geometry import shape as shp_shape

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

    except Exception as e:
        logger.exception("Error generating visit suggestions: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
