"""Business logic for trip CRUD operations."""

import json
import logging
from datetime import UTC, datetime

from db.models import Trip

logger = logging.getLogger(__name__)


class TripCrudService:
    """Service class for trip create, update, and delete operations."""

    @staticmethod
    async def get_trip(trip_id: str) -> Trip | None:
        """Get a single trip by its transaction ID.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Trip model or None if not found
        """
        return await Trip.find_one(Trip.transactionId == trip_id)

    @staticmethod
    async def delete_trip(trip_id: str):
        """Delete a trip by its transaction ID.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Delete result with status and count

        Raises:
            ValueError: If trip not found
        """
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if not trip:
            raise ValueError("Trip not found")

        await trip.delete()

        return {
            "status": "success",
            "message": "Trip deleted successfully",
            "deleted_trips": 1,
        }

    @staticmethod
    async def bulk_delete_trips(trip_ids: list[str]):
        """Bulk delete trips by their transaction IDs.

        Args:
            trip_ids: List of transaction IDs

        Returns:
            Delete result with status and count

        Raises:
            ValueError: If no trip IDs provided
        """
        if not trip_ids:
            raise ValueError("No trip IDs provided")

        result = await Trip.find(Trip.transactionId.in_(trip_ids)).delete()

        return {
            "status": "success",
            "deleted_trips": result.deleted_count,
            "message": f"Deleted {result.deleted_count} trips",
        }

    @staticmethod
    async def update_trip(trip_id: str, geometry_data=None, properties_data=None):
        """Update a trip's details, such as its geometry or properties.

        Args:
            trip_id: Transaction ID of the trip
            geometry_data: Optional geometry data (dict or JSON string)
            properties_data: Optional properties dict

        Returns:
            Update result with status and message

        Raises:
            ValueError: If trip not found or invalid data
        """
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if not trip:
            raise ValueError("Trip not found")

        if geometry_data:
            if isinstance(geometry_data, str):
                try:
                    geometry_data = json.loads(geometry_data)
                except json.JSONDecodeError:
                    raise ValueError("Invalid JSON format for geometry field.")
            trip.gps = geometry_data

        if properties_data:
            for key, value in properties_data.items():
                if key not in ["_id", "transactionId"] and hasattr(trip, key):
                    setattr(trip, key, value)

        if not geometry_data and not properties_data:
            return {"status": "no_change", "message": "No data provided to update."}

        trip.last_modified = datetime.now(UTC)
        await trip.save()

        return {"status": "success", "message": "Trip updated successfully."}

    @staticmethod
    async def restore_trip(trip_id: str):
        """Restore an invalid trip.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Success result

        Raises:
            ValueError: If trip not found
        """
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if not trip:
            raise ValueError("Trip not found")

        # Unset invalid flags
        trip.invalid = None
        trip.validation_message = None
        trip.validated_at = None
        await trip.save()

        return {"status": "success", "message": "Trip allocated as valid."}
