"""Business logic for custom place management."""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId

from date_utils import normalize_to_utc_datetime
from db import (
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    insert_one_with_retry,
    update_one_with_retry,
)

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


class Collections:
    """Shared collections for places and trips."""

    places = None
    trips = None


class PlaceService:
    """Service class for custom place operations."""

    @staticmethod
    async def get_places() -> list[dict[str, Any]]:
        """Get all custom places.

        Returns:
            List of place dictionaries with _id as string
        """
        places = await find_with_retry(Collections.places, {})
        return [
            {
                "_id": str(p["_id"]),
                **CustomPlace.from_dict(p).to_dict(),
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
        place_obj = CustomPlace(name, geometry)
        result = await insert_one_with_retry(
            Collections.places,
            place_obj.to_dict(),
        )
        return {
            "_id": str(result.inserted_id),
            **place_obj.to_dict(),
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
        await delete_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
        )
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
        place = await find_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
        )
        if not place:
            raise ValueError("Place not found")

        update_fields = {}
        if name is not None:
            update_fields["name"] = name
        if geometry is not None:
            update_fields["geometry"] = geometry

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
        return await find_one_with_retry(
            Collections.places,
            {"_id": ObjectId(place_id)},
        )
