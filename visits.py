"""Visits module for the street coverage application.

This module handles all functionality related to places and visits, including
creating, retrieving, and analyzing visit data.
"""

import logging
from datetime import datetime, timezone
from typing import Any
import pymongo

from bson import ObjectId
from dateutil import parser as dateutil_parser
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from shapely.geometry import shape

from db import (
    SerializationHelper,
    aggregate_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    insert_one_with_retry,
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
        self.created_at = created_at or datetime.now(timezone.utc)

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
            created = datetime.now(timezone.utc)
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
        logger.exception("Error deleting place: %s", str(e))
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
        logger.exception("Error updating place: %s", str(e))
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
        time_value = dateutil_parser.isoparse(time_value)
    if time_value.tzinfo is None:
        time_value = time_value.astimezone(timezone.utc)
    return time_value


async def _calculate_visits_for_place(
    place: dict, all_trips_for_bulk: list | None = None
) -> list[dict]:
    """
    Core logic to calculate visit details for a single place.
    This is the robust version that correctly handles departures.
    """
    place_id = str(place["_id"])

    # Define the query to find trips that ended at the place (arrivals).
    ended_at_place_query = {
        "$or": [
            {"destinationPlaceId": place_id},
            {
                "destinationGeoPoint": {
                    "$geoWithin": {"$geometry": place["geometry"]},
                },
            },
        ],
        "endTime": {"$ne": None},
    }

    # Fetch arrival trips. If a pre-fetched list is provided, filter it.
    if all_trips_for_bulk:
        arrival_trips = [
            t
            for t in all_trips_for_bulk
            if (
                t.get("destinationPlaceId") == place_id
                or (
                    t.get("destinationGeoPoint")
                    and shape(place["geometry"]).contains(
                        shape(t["destinationGeoPoint"])
                    )
                )
            )
        ]
        arrival_trips.sort(key=lambda x: x.get("endTime"))
    else:
        arrival_trips = await find_with_retry(
            Collections.trips,
            ended_at_place_query,
            sort=[("endTime", pymongo.ASCENDING)],
        )

    visits = []
    last_visit_departure_time = None

    # For each arrival, find the NEXT chronological trip, which marks the departure.
    for arrival_trip in arrival_trips:
        arrival_time = parse_time(arrival_trip.get("endTime"))
        if not arrival_time:
            continue

        # Find the very next trip that started AFTER this arrival.
        # This is the key change: we no longer care WHERE it started.
        if all_trips_for_bulk:
            # Find in the pre-fetched list for efficiency
            departure_trip = next(
                (
                    t
                    for t in sorted(
                        all_trips_for_bulk, key=lambda x: x.get("startTime")
                    )
                    if parse_time(t.get("startTime")) > arrival_time
                ),
                None,
            )
        else:
            departure_trip = await find_one_with_retry(
                Collections.trips,
                {"startTime": {"$gt": arrival_time}},
                sort=[("startTime", pymongo.ASCENDING)],
            )

        departure_time = None
        duration = None
        if departure_trip and departure_trip.get("startTime"):
            departure_time = parse_time(departure_trip["startTime"])
            if departure_time:
                duration = (departure_time - arrival_time).total_seconds()

        time_since_last = None
        if last_visit_departure_time:
            time_since_last = (arrival_time - last_visit_departure_time).total_seconds()

        visits.append(
            {
                "arrival_trip": arrival_trip,
                "arrival_time": arrival_time,
                "departure_time": departure_time,
                "duration": duration,
                "time_since_last": time_since_last,
            }
        )

        if departure_time:
            last_visit_departure_time = departure_time

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

        visits = await _calculate_visits_for_place(place)

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
            "firstVisit": SerializationHelper.serialize_datetime(first_visit),
            "lastVisit": SerializationHelper.serialize_datetime(last_visit),
            "averageTimeSinceLastVisit": format_duration(avg_time_between),
            "name": place["name"],
        }

    except Exception as e:
        logger.exception("Error getting place statistics for %s: %s", place_id, str(e))
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

        visits = await _calculate_visits_for_place(place)

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
                    "endTime": SerializationHelper.serialize_datetime(
                        visit["arrival_time"]
                    ),
                    "departureTime": (
                        SerializationHelper.serialize_datetime(visit["departure_time"])
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
        logger.exception("Error getting trips for place %s: %s", place_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/non_custom_places_visits")
async def get_non_custom_places_visits():
    """Get visits to non-custom places."""
    try:
        pipeline = [
            {
                "$match": {
                    "destinationPlaceName": {"$exists": True, "$ne": None},
                    "destinationPlaceId": {"$exists": False},  # Exclude custom places
                },
            },
            {
                "$group": {
                    "_id": "$destinationPlaceName",
                    "totalVisits": {"$sum": 1},
                    "firstVisit": {"$min": "$endTime"},
                    "lastVisit": {"$max": "$endTime"},
                },
            },
            {"$sort": {"totalVisits": -1}},
            {"$limit": 50},
        ]

        results = await aggregate_with_retry(Collections.trips, pipeline)

        places_data = [
            {
                "name": doc["_id"],
                "totalVisits": doc["totalVisits"],
                "firstVisit": SerializationHelper.serialize_datetime(doc["firstVisit"]),
                "lastVisit": SerializationHelper.serialize_datetime(doc["lastVisit"]),
            }
            for doc in results
        ]

        return places_data
    except Exception as e:
        logger.exception("Error getting non-custom places visits: %s", str(e))
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

        # Pre-fetch all trips once for efficiency. This is a broad query.
        all_trips = await find_with_retry(
            Collections.trips, {"startTime": {"$ne": None}, "endTime": {"$ne": None}}
        )

        results = []
        for place in places:
            visits = await _calculate_visits_for_place(
                place, all_trips_for_bulk=all_trips
            )

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
                    "firstVisit": SerializationHelper.serialize_datetime(first_visit),
                    "lastVisit": SerializationHelper.serialize_datetime(last_visit),
                }
            )
        return results
    except Exception as e:
        logger.exception("Error in get_all_places_statistics: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))
