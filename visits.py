"""
Visits module for the street coverage application.

This module handles all functionality related to places and visits,
including creating, retrieving, and analyzing visit data.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

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
)

# Setup logging
logger = logging.getLogger(__name__)

# Create a router for visit-related endpoints
router = APIRouter(prefix="/api", tags=["visits"])


class PlaceModel(BaseModel):
    """Model for custom place data."""

    name: str
    geometry: Dict[str, Any]


class CustomPlace:
    """
    A utility class for user-defined places.
    """

    def __init__(
        self, name: str, geometry: dict, created_at: Optional[datetime] = None
    ):
        """
        Initialize a CustomPlace.

        Args:
            name: The name of the place
            geometry: GeoJSON geometry object defining the place boundaries
            created_at: When the place was created, defaults to current UTC time
        """
        self.name = name
        self.geometry = geometry
        self.created_at = created_at or datetime.now(timezone.utc)

    def to_dict(self) -> Dict[str, Any]:
        """
        Convert the CustomPlace to a dictionary for storage.

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
        """
        Create a CustomPlace from a dictionary.

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
            name=data["name"], geometry=data["geometry"], created_at=created
        )


# Reference to database collections - these will be set during initialization
places_collection = None
trips_collection = None
uploaded_trips_collection = None


def init_collections(places_coll, trips_coll, uploaded_trips_coll):
    """
    Initialize the database collections for this module.

    Args:
        places_coll: MongoDB collection for places
        trips_coll: MongoDB collection for trips
        uploaded_trips_coll: MongoDB collection for uploaded trips
    """
    global places_collection, trips_collection, uploaded_trips_collection
    places_collection = places_coll
    trips_collection = trips_coll
    uploaded_trips_collection = uploaded_trips_coll


@router.get("/places")
async def get_places():
    """Get all custom places."""
    places = await find_with_retry(places_collection, {})
    return [
        {"_id": str(p["_id"]), **CustomPlace.from_dict(p).to_dict()} for p in places
    ]


@router.post("/places")
async def create_place(place: PlaceModel):
    """Create a new custom place."""
    place_obj = CustomPlace(place.name, place.geometry)
    result = await insert_one_with_retry(places_collection, place_obj.to_dict())
    return {"_id": str(result.inserted_id), **place_obj.to_dict()}


@router.delete("/places/{place_id}")
async def delete_place(place_id: str):
    """Delete a custom place."""
    try:
        await delete_one_with_retry(places_collection, {"_id": ObjectId(place_id)})
        return {"status": "success", "message": "Place deleted"}
    except Exception as e:
        logger.exception("Error deleting place: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/places/{place_id}/statistics")
async def get_place_statistics(place_id: str):
    """Get statistics about visits to a place."""
    try:
        place = await find_one_with_retry(
            places_collection, {"_id": ObjectId(place_id)}
        )
        if not place:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Place not found"
            )

        query = {
            "$or": [
                {"destinationPlaceId": place_id},
                {
                    "destinationGeoPoint": {
                        "$geoWithin": {"$geometry": place["geometry"]}
                    }
                },
            ],
            "endTime": {"$ne": None},
        }

        valid_trips = []
        for coll in [trips_collection, uploaded_trips_collection]:
            trips_list = await find_with_retry(coll, query)
            valid_trips.extend(trips_list)

        valid_trips.sort(key=lambda x: x["endTime"])
        visits = []
        durations = []
        time_since_last_visits = []
        first_visit = None
        last_visit = None

        for i, t in enumerate(valid_trips):
            try:
                t_end = t["endTime"]
                if isinstance(t_end, str):
                    t_end = dateutil_parser.isoparse(t_end)
                if t_end.tzinfo is None:
                    t_end = t_end.replace(tzinfo=timezone.utc)

                if first_visit is None:
                    first_visit = t_end
                last_visit = t_end

                if i < len(valid_trips) - 1:
                    next_trip = valid_trips[i + 1]
                    same_place = False
                    if next_trip.get("startPlaceId") == place_id:
                        same_place = True
                    else:
                        start_pt = next_trip.get("startGeoPoint")
                        if (
                            start_pt
                            and isinstance(start_pt, dict)
                            and "coordinates" in start_pt
                        ):
                            if shape(place["geometry"]).contains(shape(start_pt)):
                                same_place = True

                    if same_place:
                        next_start = next_trip.get("startTime")
                        if isinstance(next_start, str):
                            next_start = dateutil_parser.isoparse(next_start)
                        if next_start and next_start.tzinfo is None:
                            next_start = next_start.replace(tzinfo=timezone.utc)
                        if next_start and next_start > t_end:
                            duration_minutes = (
                                next_start - t_end
                            ).total_seconds() / 60.0
                            if duration_minutes > 0:
                                durations.append(duration_minutes)

                if i > 0:
                    prev_trip_end = valid_trips[i - 1].get("endTime")
                    if isinstance(prev_trip_end, str):
                        prev_trip_end = dateutil_parser.isoparse(prev_trip_end)
                    if prev_trip_end and prev_trip_end.tzinfo is None:
                        prev_trip_end = prev_trip_end.replace(tzinfo=timezone.utc)
                    if prev_trip_end and t_end > prev_trip_end:
                        hrs_since_last = (
                            t_end - prev_trip_end
                        ).total_seconds() / 3600.0
                        if hrs_since_last >= 0:
                            time_since_last_visits.append(hrs_since_last)

                visits.append(t_end)
            except Exception as e:
                logger.exception(
                    "Issue processing trip for place %s: %s", place_id, str(e)
                )
                continue

        total_visits = len(visits)
        avg_duration = sum(durations) / len(durations) if durations else 0

        def format_h_m(m: float) -> str:
            hh = int(m // 60)
            mm = int(m % 60)
            return f"{hh}h {mm:02d}m"

        avg_duration_str = format_h_m(avg_duration) if avg_duration > 0 else "0h 00m"
        avg_time_since_last = (
            sum(time_since_last_visits) / len(time_since_last_visits)
            if time_since_last_visits
            else 0
        )
        return {
            "totalVisits": total_visits,
            "averageTimeSpent": avg_duration_str,
            "firstVisit": SerializationHelper.serialize_datetime(first_visit),
            "lastVisit": SerializationHelper.serialize_datetime(last_visit),
            "averageTimeSinceLastVisit": avg_time_since_last,
            "name": place["name"],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error place stats %s: %s", place_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/places/{place_id}/trips")
async def get_trips_for_place(place_id: str):
    """Get trips that visited a specific place."""
    try:
        place = await find_one_with_retry(
            places_collection, {"_id": ObjectId(place_id)}
        )
        if not place:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Place not found"
            )

        query = {
            "$or": [
                {"destinationPlaceId": place_id},
                {
                    "destinationGeoPoint": {
                        "$geoWithin": {"$geometry": place["geometry"]}
                    }
                },
            ],
            "endTime": {"$ne": None},
        }

        valid_trips = []
        for coll in [trips_collection, uploaded_trips_collection]:
            trips_list = await find_with_retry(coll, query)
            valid_trips.extend(trips_list)

        valid_trips.sort(key=lambda x: x["endTime"])
        trips_data = []

        for i, trip in enumerate(valid_trips):
            end_time = trip["endTime"]
            if isinstance(end_time, str):
                end_time = dateutil_parser.isoparse(end_time)
            if end_time.tzinfo is None:
                end_time = end_time.replace(tzinfo=timezone.utc)

            duration_str = "0h 00m"
            time_since_last_str = "N/A"

            if i < len(valid_trips) - 1:
                next_trip = valid_trips[i + 1]
                same_place = False
                if next_trip.get("startPlaceId") == place_id:
                    same_place = True
                else:
                    start_pt = next_trip.get("startGeoPoint")
                    if (
                        start_pt
                        and isinstance(start_pt, dict)
                        and "coordinates" in start_pt
                    ):
                        if shape(place["geometry"]).contains(shape(start_pt)):
                            same_place = True

                if same_place:
                    next_start = next_trip.get("startTime")
                    if isinstance(next_start, str):
                        next_start = dateutil_parser.isoparse(next_start)
                    if next_start and next_start.tzinfo is None:
                        next_start = next_start.replace(tzinfo=timezone.utc)
                    if next_start and next_start > end_time:
                        duration_seconds = (next_start - end_time).total_seconds()
                        if duration_seconds > 0:
                            # Format duration in a more readable way
                            if duration_seconds < 60:  # Less than a minute
                                duration_str = f"{int(duration_seconds)}s"
                            elif duration_seconds < 3600:  # Less than an hour
                                mins = int(duration_seconds // 60)
                                secs = int(duration_seconds % 60)
                                duration_str = f"{mins}m {secs}s"
                            elif duration_seconds < 86400:  # Less than a day
                                hrs = int(duration_seconds // 3600)
                                mins = int((duration_seconds % 3600) // 60)
                                duration_str = f"{hrs}h {mins:02d}m"
                            else:  # One or more days
                                days = int(duration_seconds // 86400)
                                hrs = int((duration_seconds % 86400) // 3600)
                                mins = int((duration_seconds % 3600) // 60)
                                duration_str = f"{days}d {hrs}h {mins:02d}m"

            if i > 0:
                prev_trip_end = valid_trips[i - 1].get("endTime")
                if isinstance(prev_trip_end, str):
                    prev_trip_end = dateutil_parser.isoparse(prev_trip_end)
                if prev_trip_end and prev_trip_end.tzinfo is None:
                    prev_trip_end = prev_trip_end.replace(tzinfo=timezone.utc)
                if prev_trip_end and end_time > prev_trip_end:
                    seconds_since_last = (end_time - prev_trip_end).total_seconds()

                    # Format in a more readable way
                    if seconds_since_last < 60:  # Less than a minute
                        time_since_last_str = f"{int(seconds_since_last)}s"
                    elif seconds_since_last < 3600:  # Less than an hour
                        mins = int(seconds_since_last // 60)
                        secs = int(seconds_since_last % 60)
                        time_since_last_str = f"{mins}m {secs}s"
                    elif seconds_since_last < 86400:  # Less than a day
                        hrs = int(seconds_since_last // 3600)
                        mins = int((seconds_since_last % 3600) // 60)
                        time_since_last_str = f"{hrs}h {mins:02d}m"
                    else:  # One or more days
                        days = int(seconds_since_last // 86400)
                        if days < 30:  # Less than a month
                            hrs = int((seconds_since_last % 86400) // 3600)
                            time_since_last_str = f"{days}d {hrs}h"
                        else:  # More than a month
                            months = int(days // 30)
                            days = days % 30
                            time_since_last_str = f"{months}mo {days}d"

            # Add trip data
            trip_id = str(trip["_id"])
            trip_source = "Uploaded"
            if "_source" in trip and trip["_source"] == "bouncie":
                trip_source = "Bouncie"

            # Handling 'distance' field, checking if it's a dictionary or float
            distance = trip.get(
                "distance", 0
            )  # Default to 0 if no "distance" key is found

            # Check if distance is a dictionary and extract the value
            if isinstance(distance, dict):
                distance = distance.get("value", 0)

            # Now, you can safely use distance
            trips_data.append(
                {
                    "id": trip_id,
                    "endTime": SerializationHelper.serialize_datetime(end_time),
                    "timeSpent": duration_str,
                    "timeSinceLastVisit": time_since_last_str,
                    "source": trip_source,
                    "distance": distance,
                }
            )

        return {"trips": trips_data, "name": place["name"]}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error getting trips for place %s: %s", place_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/non_custom_places_visits")
async def get_non_custom_places_visits():
    """Get visits to non-custom places."""
    try:
        # Find all trips with valid destination places
        pipeline = [
            {"$match": {"destinationPlaceName": {"$exists": True, "$ne": None}}},
            {
                "$group": {
                    "_id": "$destinationPlaceName",
                    "count": {"$sum": 1},
                    "lastVisit": {"$max": "$endTime"},
                }
            },
            {"$sort": {"count": -1}},
            {"$limit": 30},  # Limit to top 30 places
        ]

        places_data = []
        for coll in [trips_collection, uploaded_trips_collection]:
            results = await aggregate_with_retry(coll, pipeline)
            for doc in results:
                place_name = doc["_id"]
                visit_count = doc["count"]
                last_visit = doc["lastVisit"]

                # Check if this place is already in our results
                existing = next(
                    (p for p in places_data if p["name"] == place_name), None
                )
                if existing:
                    existing["visitCount"] += visit_count
                    if last_visit > existing["lastVisit"]:
                        existing["lastVisit"] = last_visit
                else:
                    places_data.append(
                        {
                            "name": place_name,
                            "visitCount": visit_count,
                            "lastVisit": last_visit,
                        }
                    )

        # Sort by visit count
        places_data.sort(key=lambda x: x["visitCount"], reverse=True)

        # Format dates
        for place in places_data:
            place["lastVisit"] = SerializationHelper.serialize_datetime(
                place["lastVisit"]
            )

        return {"places": places_data}
    except Exception as e:
        logger.exception("Error getting non-custom places visits: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )
