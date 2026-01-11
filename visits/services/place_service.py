"""Business logic for custom place management."""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId

from date_utils import normalize_to_utc_datetime
from db.models import Place

logger = logging.getLogger(__name__)


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
        created = normalize_to_utc_datetime(created_raw)
        if not created:
            created = datetime.now(UTC)
        return CustomPlace(
            name=data["name"],
            geometry=data["geometry"],
            created_at=created,
        )


class PlaceService:
    """Service class for custom place operations."""

    @staticmethod
    async def get_places() -> list[dict[str, Any]]:
        """Get all custom places.

        Returns:
            List of place dictionaries with _id as string
        """
        places = await Place.find_all().to_list()
        return [
            {
                "_id": str(p.id),
                "name": p.name,
                "geometry": p.geometry,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in places
        ]

    @staticmethod
    async def create_place(name: str, geometry: dict[str, Any]) -> dict[str, Any]:
        """Create a new custom place.

        Args:
            name: The name of the place
            geometry: GeoJSON geometry object

        Returns:
            Created place dictionary
        """
        place = Place(
            name=name,
            geometry=geometry,
            created_at=datetime.now(UTC),
        )
        await place.insert()
        return {
            "_id": str(place.id),
            "name": place.name,
            "geometry": place.geometry,
            "created_at": place.created_at.isoformat() if place.created_at else None,
        }

    @staticmethod
    async def delete_place(place_id: str) -> dict[str, str]:
        """Delete a custom place.

        Args:
            place_id: The place ID to delete

        Returns:
            Success message

        Raises:
            ValueError: If place_id is invalid ObjectId
        """
        place = await Place.get(ObjectId(place_id))
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
    ) -> dict[str, Any]:
        """Update a custom place (name and/or geometry).

        Args:
            place_id: The place ID to update
            name: Optional new name
            geometry: Optional new geometry

        Returns:
            Updated place dictionary

        Raises:
            ValueError: If place not found or invalid ObjectId
        """
        place = await Place.get(ObjectId(place_id))
        if not place:
            raise ValueError("Place not found")

        if name is not None:
            place.name = name
        if geometry is not None:
            place.geometry = geometry

        await place.save()

        return {
            "_id": place_id,
            "name": place.name,
            "geometry": place.geometry,
            "created_at": place.created_at.isoformat() if place.created_at else None,
        }

    @staticmethod
    async def get_place_by_id(place_id: str) -> dict[str, Any] | None:
        """Get a place by ID.

        Args:
            place_id: The place ID

        Returns:
            Place document or None if not found

        Raises:
            ValueError: If place_id is invalid ObjectId
        """
        place = await Place.get(ObjectId(place_id))
        if not place:
            return None
        return {
            "_id": str(place.id),
            "name": place.name,
            "geometry": place.geometry,
            "created_at": place.created_at.isoformat() if place.created_at else None,
        }
