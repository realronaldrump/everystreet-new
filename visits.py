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


class PlaceUpdateModel(BaseModel):
    """Model for updating a custom place."""
    name: Optional[str] = None
    geometry: Optional[Dict[str, Any]] = None


@router.patch("/places/{place_id}")
async def update_place(place_id: str, update_data: PlaceUpdateModel):
    """Update a custom place (name and/or geometry)."""
    try:
        # Find the existing place
        place = await find_one_with_retry(places_collection, {"_id": ObjectId(place_id)})
        if not place:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Place not found"
            )
            
        # Prepare update data
        update_fields = {}
        if update_data.name is not None:
            update_fields["name"] = update_data.name
        if update_data.geometry is not None:
            update_fields["geometry"] = update_data.geometry
            
        if not update_fields:
            return {"_id": place_id, **CustomPlace.from_dict(place).to_dict()}
            
        # Update the place
        from db import update_one_with_retry
        await update_one_with_retry(
            places_collection, 
            {"_id": ObjectId(place_id)}, 
            {"$set": update_fields}
        )
        
        # Get the updated place
        updated_place = await find_one_with_retry(places_collection, {"_id": ObjectId(place_id)})
        return {"_id": place_id, **CustomPlace.from_dict(updated_place).to_dict()}
    except Exception as e:
        logger.exception("Error updating place: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


def format_duration(seconds):
    """Format duration in seconds to a human-readable string."""
    if seconds is None:
        return "N/A"

    if seconds < 60:  # Less than a minute
        return f"{int(seconds)}s"
    elif seconds < 3600:  # Less than an hour
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{mins}m {secs}s"
    elif seconds < 86400:  # Less than a day
        hrs = int(seconds // 3600)
        mins = int((seconds % 3600) // 60)
        return f"{hrs}h {mins:02d}m"
    else:  # One or more days
        days = int(seconds // 86400)
        hrs = int((seconds % 86400) // 3600)
        mins = int((seconds % 3600) // 60)
        return f"{days}d {hrs}h {mins:02d}m"


def is_point_in_place(point, place_geometry):
    """Check if a point is within a place's geometry."""
    if not point or not isinstance(point, dict) or "coordinates" not in point:
        return False
    try:
        return shape(place_geometry).contains(shape(point))
    except Exception:
        return False


def parse_time(time_value):
    """Parse a time value into a timezone-aware datetime."""
    if not time_value:
        return None
    if isinstance(time_value, str):
        time_value = dateutil_parser.isoparse(time_value)
    if time_value.tzinfo is None:
        time_value = time_value.replace(tzinfo=timezone.utc)
    return time_value


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

        # Find trips ending at this place
        ended_at_place_query = {
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

        # Find trips starting from this place
        started_from_place_query = {
            "$or": [
                {"startPlaceId": place_id},
                {"startGeoPoint": {"$geoWithin": {"$geometry": place["geometry"]}}},
            ],
            "startTime": {"$ne": None},
        }

        # Fetch all relevant trips
        trips_ending_at_place = []
        trips_starting_from_place = []

        for coll in [trips_collection, uploaded_trips_collection]:
            ending_trips = await find_with_retry(coll, ended_at_place_query)
            starting_trips = await find_with_retry(coll, started_from_place_query)
            trips_ending_at_place.extend(ending_trips)
            trips_starting_from_place.extend(starting_trips)

        # Create a timeline of all events for visit calculation
        timeline = []

        for trip in trips_ending_at_place + trips_starting_from_place:
            trip_id = str(trip["_id"])

            # Add start event if it exists
            if "startTime" in trip and trip["startTime"]:
                start_time = parse_time(trip["startTime"])
                if start_time:
                    is_at_place = trip.get(
                        "startPlaceId"
                    ) == place_id or is_point_in_place(
                        trip.get("startGeoPoint"), place["geometry"]
                    )
                    timeline.append(
                        {
                            "time": start_time,
                            "type": "start",
                            "trip_id": trip_id,
                            "is_at_place": is_at_place,
                        }
                    )

            # Add end event if it exists
            if "endTime" in trip and trip["endTime"]:
                end_time = parse_time(trip["endTime"])
                if end_time:
                    is_at_place = trip.get(
                        "destinationPlaceId"
                    ) == place_id or is_point_in_place(
                        trip.get("destinationGeoPoint"), place["geometry"]
                    )
                    timeline.append(
                        {
                            "time": end_time,
                            "type": "end",
                            "trip_id": trip_id,
                            "is_at_place": is_at_place,
                        }
                    )

        # Sort timeline chronologically
        timeline = sorted(timeline, key=lambda x: x["time"])

        # Calculate visits
        visits = []
        current_visit_start = None
        last_visit_end = None

        for i, event in enumerate(timeline):
            # Trip ended at the place = start of a visit
            if event["type"] == "end" and event["is_at_place"]:
                current_visit_start = event["time"]

                # Find when this visit ends (next trip start of any kind)
                visit_end = None
                for j in range(i + 1, len(timeline)):
                    if timeline[j]["type"] == "start":
                        visit_end = timeline[j]["time"]
                        break

                # Calculate time since last visit
                time_since_last = None
                if last_visit_end is not None and current_visit_start is not None:
                    time_since_last = (
                        current_visit_start - last_visit_end
                    ).total_seconds()

                # Calculate visit duration
                duration = None
                if visit_end is not None and current_visit_start is not None:
                    duration = (visit_end - current_visit_start).total_seconds()

                visits.append(
                    {
                        "start": current_visit_start,
                        "end": visit_end,
                        "duration": duration,
                        "time_since_last": time_since_last,
                    }
                )

            # Trip started from the place = end of current visit cycle
            if event["type"] == "start" and event["is_at_place"]:
                last_visit_end = event["time"]

        # Calculate statistics
        total_visits = len(visits)
        durations = [v["duration"] for v in visits if v["duration"] is not None]
        time_between_visits = [
            v["time_since_last"] for v in visits if v["time_since_last"] is not None
        ]

        avg_duration = sum(durations) / len(durations) if durations else 0
        avg_time_between = (
            sum(time_between_visits) / len(time_between_visits)
            if time_between_visits
            else 0
        )

        first_visit = (
            min([v["start"] for v in visits], default=None) if visits else None
        )
        last_visit = max([v["start"] for v in visits], default=None) if visits else None

        return {
            "totalVisits": total_visits,
            "averageTimeSpent": format_duration(avg_duration),
            "firstVisit": SerializationHelper.serialize_datetime(first_visit),
            "lastVisit": SerializationHelper.serialize_datetime(last_visit),
            "averageTimeSinceLastVisit": (
                avg_time_between / 3600 if avg_time_between else 0
            ),  # Convert to hours
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

        # Find trips ending at this place
        ended_at_place_query = {
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

        # Find trips starting from this place
        started_from_place_query = {
            "$or": [
                {"startPlaceId": place_id},
                {"startGeoPoint": {"$geoWithin": {"$geometry": place["geometry"]}}},
            ],
            "startTime": {"$ne": None},
        }

        # Fetch all relevant trips
        trips_ending_at_place = []
        trips_starting_from_place = []

        for coll in [trips_collection, uploaded_trips_collection]:
            ending_trips = await find_with_retry(coll, ended_at_place_query)
            starting_trips = await find_with_retry(coll, started_from_place_query)
            trips_ending_at_place.extend(ending_trips)
            trips_starting_from_place.extend(starting_trips)

        # Create a dictionary to look up trips by ID
        trips_by_id = {
            str(t["_id"]): t for t in trips_ending_at_place + trips_starting_from_place
        }

        # Create a timeline of all events
        timeline = []

        for trip in trips_ending_at_place + trips_starting_from_place:
            trip_id = str(trip["_id"])

            # Add start event if it exists
            if "startTime" in trip and trip["startTime"]:
                start_time = parse_time(trip["startTime"])
                if start_time:
                    is_at_place = trip.get(
                        "startPlaceId"
                    ) == place_id or is_point_in_place(
                        trip.get("startGeoPoint"), place["geometry"]
                    )
                    timeline.append(
                        {
                            "time": start_time,
                            "type": "start",
                            "trip_id": trip_id,
                            "is_at_place": is_at_place,
                        }
                    )

            # Add end event if it exists
            if "endTime" in trip and trip["endTime"]:
                end_time = parse_time(trip["endTime"])
                if end_time:
                    is_at_place = trip.get(
                        "destinationPlaceId"
                    ) == place_id or is_point_in_place(
                        trip.get("destinationGeoPoint"), place["geometry"]
                    )
                    timeline.append(
                        {
                            "time": end_time,
                            "type": "end",
                            "trip_id": trip_id,
                            "is_at_place": is_at_place,
                        }
                    )

        # Sort timeline chronologically
        timeline = sorted(timeline, key=lambda x: x["time"])

        # Calculate visits and create trips data
        visits = []
        current_visit_start = None
        last_visit_end = None

        for i, event in enumerate(timeline):
            # Trip ended at the place = start of a visit
            if event["type"] == "end" and event["is_at_place"]:
                current_visit_start = event["time"]
                arrival_trip_id = event["trip_id"]

                # Find when this visit ends (next trip start of any kind)
                visit_end = None
                departure_trip_id = None
                for j in range(i + 1, len(timeline)):
                    if timeline[j]["type"] == "start":
                        visit_end = timeline[j]["time"]
                        departure_trip_id = timeline[j]["trip_id"]
                        break

                # Calculate time since last visit
                time_since_last = None
                if last_visit_end is not None and current_visit_start is not None:
                    time_since_last = (
                        current_visit_start - last_visit_end
                    ).total_seconds()

                # Calculate visit duration
                duration = None
                if visit_end is not None and current_visit_start is not None:
                    duration = (visit_end - current_visit_start).total_seconds()

                visits.append(
                    {
                        "arrival_trip_id": arrival_trip_id,
                        "departure_trip_id": departure_trip_id,
                        "arrival_time": current_visit_start,
                        "departure_time": visit_end,
                        "duration": duration,
                        "time_since_last": time_since_last,
                    }
                )

            # Trip started from the place = end of current visit cycle
            if event["type"] == "start" and event["is_at_place"]:
                last_visit_end = event["time"]

        # Format visit data for display
        trips_data = []
        for visit in visits:
            arrival_trip_id = visit["arrival_trip_id"]
            trip = trips_by_id.get(arrival_trip_id)

            if not trip:
                continue

            duration_str = format_duration(visit["duration"])
            time_since_last_str = format_duration(visit["time_since_last"])

            # Add to final data
            trip_source = "Uploaded"
            if "_source" in trip and trip["_source"] == "bouncie":
                trip_source = "Bouncie"

            distance = trip.get("distance", 0)
            if isinstance(distance, dict):
                distance = distance.get("value", 0)

            # Get transaction ID (if available) or use trip ID as fallback
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
                    "source": trip_source,
                    "distance": distance,
                }
            )

        # Sort by arrival time (when trip arrived at place) in descending order
        trips_data.sort(key=lambda x: x["endTime"], reverse=True)

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
