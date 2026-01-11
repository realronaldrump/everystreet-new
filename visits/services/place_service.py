"""Business logic for custom place management."""

import logging
from datetime import UTC, datetime
from typing import Any

from db.models import Place
from db.schemas import PlaceResponse

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
        """Get all custom places.

        Returns:
            List of PlaceResponse objects
        """
        places = await Place.find_all().to_list()
        return [PlaceService._place_to_response(p) for p in places]

    @staticmethod
    async def create_place(name: str, geometry: dict[str, Any]) -> PlaceResponse:
        """Create a new custom place.

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
    async def delete_place(place_id: str) -> dict[str, str]:
        """Delete a custom place.

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
        """Update a custom place (name and/or geometry).

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
            raise ValueError("Place not found")

        if name is not None:
            place.name = name
        if geometry is not None:
            place.geometry = geometry

        await place.save()
        return PlaceService._place_to_response(place)

    @staticmethod
    async def get_place_by_id(place_id: str) -> PlaceResponse | None:
        """Get a place by ID.

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
