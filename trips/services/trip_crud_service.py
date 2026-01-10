"""Business logic for trip CRUD operations."""

import json
import logging
from datetime import UTC, datetime

from db import (
    delete_many_with_retry,
    delete_one_with_retry,
    get_trip_by_id,
    trips_collection,
    update_one_with_retry,
)

logger = logging.getLogger(__name__)


class TripCrudService:
    """Service class for trip create, update, and delete operations."""

    @staticmethod
    async def get_trip(trip_id: str):
        """Get a single trip by its transaction ID.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Trip document or None if not found
        """
        return await get_trip_by_id(trip_id, trips_collection)

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
        trip = await get_trip_by_id(trip_id, trips_collection)
        if not trip:
            raise ValueError("Trip not found")

        result = await delete_one_with_retry(trips_collection, {"_id": trip["_id"]})

        # Retry once more (matches original behavior)
        result = await delete_one_with_retry(trips_collection, {"_id": trip["_id"]})

        if result.deleted_count >= 1:
            return {
                "status": "success",
                "message": "Trip deleted successfully",
                "deleted_trips": result.deleted_count,
            }

        raise ValueError("Failed to delete trip after finding it.")

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

        result = await delete_many_with_retry(
            trips_collection, {"transactionId": {"$in": trip_ids}}
        )
        # Retry once more (matches original behavior)
        result = await delete_many_with_retry(
            trips_collection, {"transactionId": {"$in": trip_ids}}
        )

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
        trip_to_update = await get_trip_by_id(trip_id, trips_collection)
        if not trip_to_update:
            raise ValueError("Trip not found")

        update_payload = {}
        if geometry_data:
            if isinstance(geometry_data, str):
                try:
                    geometry_data = json.loads(geometry_data)
                except json.JSONDecodeError:
                    raise ValueError("Invalid JSON format for geometry field.")
            update_payload["gps"] = geometry_data

        if properties_data:
            for key, value in properties_data.items():
                if key not in ["_id", "transactionId"]:
                    update_payload[key] = value

        if not update_payload:
            return {"status": "no_change", "message": "No data provided to update."}

        update_payload["last_modified"] = datetime.now(UTC)

        result = await update_one_with_retry(
            trips_collection,
            {"transactionId": trip_id},
            {"$set": update_payload},
        )

        if result.modified_count > 0:
            return {"status": "success", "message": "Trip updated successfully."}

        return {"status": "no_change", "message": "Trip data was already up-to-date."}

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
        trip = await get_trip_by_id(trip_id, trips_collection)
        if not trip:
            raise ValueError("Trip not found")

        # Unset invalid flag in trips_collection (matched status is part of the same doc now)
        await trips_collection.update_one(
            {"_id": trip["_id"]},
            {"$unset": {"invalid": "", "validation_message": "", "validated_at": ""}},
        )

        return {"status": "success", "message": "Trip allocated as valid."}
