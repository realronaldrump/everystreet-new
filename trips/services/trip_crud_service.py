"""Business logic for trip CRUD operations."""

import logging
from datetime import UTC, datetime

from beanie.operators import In

from db.models import Trip

logger = logging.getLogger(__name__)


class TripCrudService:
    """Service class for trip create, update, and delete operations."""

    @staticmethod
    async def get_trip(trip_id: str) -> Trip | None:
        """
        Get a single trip by its transaction ID.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Trip model or None if not found
        """
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if not trip:
            return None
        if trip.duration is None and trip.startTime and trip.endTime:
            trip.duration = (trip.endTime - trip.startTime).total_seconds()
        return trip

    @staticmethod
    async def delete_trip(trip_id: str):
        """
        Delete a trip by its transaction ID.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Delete result with status and count

        Raises:
            ValueError: If trip not found
        """
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if not trip:
            msg = "Trip not found"
            raise ValueError(msg)

        await trip.delete()

        return {
            "status": "success",
            "message": "Trip deleted successfully",
            "deleted_trips": 1,
        }

    @staticmethod
    async def bulk_delete_trips(trip_ids: list[str]):
        """
        Bulk delete trips by their transaction IDs.

        Args:
            trip_ids: List of transaction IDs

        Returns:
            Delete result with status and count

        Raises:
            ValueError: If no trip IDs provided
        """
        if not trip_ids:
            msg = "No trip IDs provided"
            raise ValueError(msg)

        result = await Trip.find(In(Trip.transactionId, trip_ids)).delete()

        return {
            "status": "success",
            "deleted_trips": result.deleted_count,
            "message": f"Deleted {result.deleted_count} trips",
        }

    @staticmethod
    async def unmatch_trip(trip_id: str):
        """
        Clear matched GPS data for a single trip.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Result with status and count

        Raises:
            ValueError: If trip not found
        """
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if not trip:
            msg = "Trip not found"
            raise ValueError(msg)

        trip.matchedGps = None
        trip.matchStatus = None
        trip.matched_at = None
        trip.last_modified = datetime.now(UTC)
        await trip.save()

        return {
            "status": "success",
            "message": "Matched data cleared",
            "updated_trips": 1,
        }

    @staticmethod
    async def bulk_unmatch_trips(trip_ids: list[str]):
        """
        Bulk clear matched GPS data for trips.

        Args:
            trip_ids: List of transaction IDs

        Returns:
            Result with status and count

        Raises:
            ValueError: If no trip IDs provided
        """
        if not trip_ids:
            msg = "No trip IDs provided"
            raise ValueError(msg)

        trips = await Trip.find(In(Trip.transactionId, trip_ids)).to_list()
        for trip in trips:
            trip.matchedGps = None
            trip.matchStatus = None
            trip.matched_at = None
            trip.last_modified = datetime.now(UTC)
            await trip.save()

        return {
            "status": "success",
            "updated_trips": len(trips),
            "message": f"Cleared matched data for {len(trips)} trips",
        }

    @staticmethod
    async def restore_trip(trip_id: str):
        """
        Restore an invalid trip.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Success result

        Raises:
            ValueError: If trip not found
        """
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if not trip:
            msg = "Trip not found"
            raise ValueError(msg)

        # Unset invalid flags
        trip.invalid = None
        trip.validation_message = None
        trip.validated_at = None
        await trip.save()

        return {"status": "success", "message": "Trip allocated as valid."}
