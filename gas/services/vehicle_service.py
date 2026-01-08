"""Business logic for vehicle management."""

import logging
from datetime import UTC, datetime
from typing import Any

from db import (
    find_one_with_retry,
    find_with_retry,
    insert_one_with_retry,
    update_one_with_retry,
    vehicles_collection,
)

logger = logging.getLogger(__name__)


class VehicleService:
    """Service class for vehicle operations."""

    @staticmethod
    async def get_vehicles(
        imei: str | None = None,
        vin: str | None = None,
        active_only: bool = True,
    ) -> list[dict[str, Any]]:
        """Get all vehicles or filter by IMEI/VIN.

        Args:
            imei: Optional IMEI filter
            vin: Optional VIN filter
            active_only: Only return active vehicles (default True)

        Returns:
            List of vehicle documents
        """
        query: dict[str, Any] = {}

        if imei:
            query["imei"] = imei
        if vin:
            query["vin"] = vin
        if active_only:
            # Treat missing is_active field as active (backward compatibility)
            query["$or"] = [
                {"is_active": True},
                {"is_active": {"$exists": False}},
                {"is_active": None},
            ]

        vehicles = await find_with_retry(
            vehicles_collection,
            query,
            sort=[("created_at", -1)],
        )

        logger.info(f"Fetched {len(vehicles)} vehicles (active_only={active_only})")
        return vehicles

    @staticmethod
    async def create_vehicle(vehicle_data: dict[str, Any]) -> dict[str, Any]:
        """Create a new vehicle record.

        Args:
            vehicle_data: Vehicle data dictionary

        Returns:
            Created vehicle document

        Raises:
            ValueError: If vehicle with IMEI already exists
        """
        # Check if vehicle with this IMEI already exists
        existing = await find_one_with_retry(
            vehicles_collection, {"imei": vehicle_data["imei"]}
        )
        if existing:
            raise ValueError("Vehicle with this IMEI already exists")

        vehicle_data["created_at"] = datetime.now(UTC)
        vehicle_data["updated_at"] = datetime.now(UTC)

        result = await insert_one_with_retry(vehicles_collection, vehicle_data)
        vehicle_data["_id"] = result.inserted_id

        return vehicle_data

    @staticmethod
    async def update_vehicle(imei: str, update_data: dict[str, Any]) -> dict[str, Any]:
        """Update a vehicle's information.

        Args:
            imei: Vehicle IMEI
            update_data: Fields to update

        Returns:
            Updated vehicle document

        Raises:
            ValueError: If vehicle not found
        """
        # Find the vehicle
        existing = await find_one_with_retry(vehicles_collection, {"imei": imei})
        if not existing:
            raise ValueError("Vehicle not found")

        # Update fields
        update_data["updated_at"] = datetime.now(UTC)

        await update_one_with_retry(
            vehicles_collection, {"imei": imei}, {"$set": update_data}
        )

        # Fetch and return updated vehicle
        updated = await find_one_with_retry(vehicles_collection, {"imei": imei})
        return updated

    @staticmethod
    async def delete_vehicle(imei: str) -> dict[str, str]:
        """Mark a vehicle as inactive.

        Args:
            imei: Vehicle IMEI

        Returns:
            Success message

        Raises:
            ValueError: If vehicle not found
        """
        result = await update_one_with_retry(
            vehicles_collection,
            {"imei": imei},
            {
                "$set": {
                    "is_active": False,
                    "updated_at": datetime.now(UTC),
                }
            },
        )

        if result.matched_count == 0:
            raise ValueError("Vehicle not found")

        return {"status": "success", "message": "Vehicle marked as inactive"}

    @staticmethod
    async def get_vehicle_by_imei(imei: str) -> dict[str, Any] | None:
        """Get a vehicle by IMEI.

        Args:
            imei: Vehicle IMEI

        Returns:
            Vehicle document or None if not found
        """
        return await find_one_with_retry(vehicles_collection, {"imei": imei})
