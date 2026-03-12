"""Business logic for custom place management."""

import logging
from datetime import UTC, datetime
from typing import Any

from shapely.geometry import Point, mapping, shape

from db.models import Place
from db.schemas import DestinationBloomPlaceResponse, PlaceResponse
from visits.services.destination_clusters import (
    build_destination_cluster_boundary,
    extract_destination_coords,
)

logger = logging.getLogger(__name__)


class PlaceService:
    """Service class for custom place operations."""

    @staticmethod
    def _place_to_response(place: Place) -> PlaceResponse:
        """Convert a Place model to a PlaceResponse."""
        return PlaceResponse(
            id=str(place.id),
            name=place.name or "",
            geometry=place.geometry,
            created_at=place.created_at,
        )

    @staticmethod
    async def get_places() -> list[PlaceResponse]:
        """
        Get all custom places.

        Returns:
            List of PlaceResponse objects
        """
        places = await Place.find_all().to_list()
        return [PlaceService._place_to_response(p) for p in places]

    @staticmethod
    async def create_place(name: str, geometry: dict[str, Any]) -> PlaceResponse:
        """
        Create a new custom place.

        Args:
            name: The name of the place
            geometry: GeoJSON geometry object

        Returns:
            Created place as PlaceResponse
        """
        place = Place(
            name=name,
            geometry=geometry,
            created_at=datetime.now(UTC),
        )
        await place.insert()
        return PlaceService._place_to_response(place)

    @staticmethod
    async def create_place_from_destination_bloom(
        name: str,
        transaction_ids: list[str],
    ) -> DestinationBloomPlaceResponse:
        """
        Create a Visits place from a destination bloom cluster and backfill trips.

        Args:
            name: User-provided place name
            transaction_ids: Seed trip transaction IDs from the clicked cluster

        Returns:
            Created place and backfill counts

        Raises:
            ValueError: If input is invalid or no seed trips can be resolved
        """
        cleaned_name = str(name or "").strip()
        cleaned_ids = [
            str(transaction_id).strip()
            for transaction_id in transaction_ids or []
            if str(transaction_id or "").strip()
        ]
        deduped_ids = list(dict.fromkeys(cleaned_ids))

        if not cleaned_name:
            msg = "Place name is required"
            raise ValueError(msg)
        if not deduped_ids:
            msg = "At least one transactionId is required"
            raise ValueError(msg)

        from db.models import Trip

        seed_trips = await Trip.find(
            {"transactionId": {"$in": deduped_ids}},
        ).to_list()
        if not seed_trips:
            msg = "No persisted trips found for the supplied transactionIds"
            raise ValueError(msg)

        points: list[tuple[float, float]] = []
        for trip in seed_trips:
            coords = extract_destination_coords(trip.model_dump())
            if coords is not None:
                points.append(coords)

        if not points:
            msg = "Selected trips do not contain usable destination coordinates"
            raise ValueError(msg)

        boundary_geom = build_destination_cluster_boundary(points=points, cell_size_m=250)
        now = datetime.now(UTC)
        place = Place(
            name=cleaned_name,
            geometry=mapping(boundary_geom),
            created_at=now,
            updated_at=now,
        )
        await place.insert()

        boundary = shape(place.geometry)
        candidates = await Trip.find(
            {
                "$or": [
                    {"transactionId": {"$in": deduped_ids}},
                    {"destinationGeoPoint": {"$exists": True, "$ne": None}},
                ],
            },
        ).to_list()

        matched_trip_ids = []
        for candidate in candidates:
            candidate_id = getattr(candidate, "id", None)
            if candidate_id is None:
                continue

            if str(getattr(candidate, "transactionId", "") or "").strip() in deduped_ids:
                matched_trip_ids.append(candidate_id)
                continue

            destination_geo = getattr(candidate, "destinationGeoPoint", None)
            coords = destination_geo.get("coordinates") if isinstance(destination_geo, dict) else None
            if (
                isinstance(coords, list)
                and len(coords) >= 2
                and isinstance(coords[0], int | float)
                and isinstance(coords[1], int | float)
                and boundary.covers(Point(float(coords[0]), float(coords[1])))
            ):
                matched_trip_ids.append(candidate_id)

        trip_collection = Trip.get_pymongo_collection()
        result = await trip_collection.update_many(
            {"_id": {"$in": matched_trip_ids}},
            {
                "$set": {
                    "destinationPlaceId": str(place.id),
                    "destinationPlaceName": cleaned_name,
                },
            },
        )

        return DestinationBloomPlaceResponse(
            place=PlaceService._place_to_response(place),
            linkedTrips=int(getattr(result, "modified_count", 0) or 0),
            seedTrips=len(seed_trips),
        )

    @staticmethod
    async def delete_place(place_id: str) -> dict[str, str]:
        """
        Delete a custom place.

        Args:
            place_id: The place ID to delete

        Returns:
            Success message

        Raises:
            ValueError: If place_id is invalid
        """
        place = await Place.get(place_id)
        if place:
            await place.delete()
        return {
            "status": "success",
            "message": "Place deleted",
        }

    @staticmethod
    async def update_place(
        place_id: str,
        name: str | None = None,
        geometry: dict[str, Any] | None = None,
    ) -> PlaceResponse:
        """
        Update a custom place (name and/or geometry).

        Args:
            place_id: The place ID to update
            name: Optional new name
            geometry: Optional new geometry

        Returns:
            Updated place as PlaceResponse

        Raises:
            ValueError: If place not found or invalid
        """
        place = await Place.get(place_id)
        if not place:
            msg = "Place not found"
            raise ValueError(msg)

        if name is not None:
            place.name = name
        if geometry is not None:
            place.geometry = geometry

        await place.save()
        return PlaceService._place_to_response(place)

    @staticmethod
    async def get_place_by_id(place_id: str) -> PlaceResponse | None:
        """
        Get a place by ID.

        Args:
            place_id: The place ID

        Returns:
            PlaceResponse or None if not found

        Raises:
            ValueError: If place_id is invalid
        """
        place = await Place.get(place_id)
        if not place:
            return None
        return PlaceService._place_to_response(place)
