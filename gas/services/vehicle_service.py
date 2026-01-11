"""Business logic for vehicle management."""

import logging
from datetime import UTC, datetime
from typing import Any

from core.exceptions import DuplicateResourceException, ResourceNotFoundException
from db.models import Vehicle

logger = logging.getLogger(__name__)


class VehicleService:
    """Service class for vehicle operations."""

    @staticmethod
    async def get_vehicles(
        imei: str | None = None,
        vin: str | None = None,
        active_only: bool = True,
    ) -> list[Vehicle]:
        """Get all vehicles or filter by IMEI/VIN.

        Args:
            imei: Optional IMEI filter
            vin: Optional VIN filter
            active_only: Only return active vehicles (default True)

        Returns:
            List of Vehicle models
        """
        conditions = []

        if imei:
            conditions.append(Vehicle.imei == imei)
        if vin:
            conditions.append(Vehicle.vin == vin)
        if active_only:
            conditions.append(Vehicle.is_active)

        query = Vehicle.find(*conditions) if conditions else Vehicle.find_all()

        vehicles = await query.sort(-Vehicle.created_at).to_list()

        logger.info("Fetched %d vehicles (active_only=%s)", len(vehicles), active_only)
        return vehicles

    @staticmethod
    async def create_vehicle(vehicle_data: dict[str, Any]) -> Vehicle:
        """Create a new vehicle record.

        Args:
            vehicle_data: Vehicle data dictionary

        Returns:
            Created Vehicle model

        Raises:
            DuplicateResourceException: If vehicle with IMEI already exists
        """
        # Check if vehicle with this IMEI already exists
        existing = await Vehicle.find_one(Vehicle.imei == vehicle_data["imei"])
        if existing:
            raise DuplicateResourceException("Vehicle with this IMEI already exists")

        vehicle_data["created_at"] = datetime.now(UTC)
        vehicle_data["updated_at"] = datetime.now(UTC)

        vehicle = Vehicle(**vehicle_data)
        await vehicle.insert()

        return vehicle

    @staticmethod
    async def update_vehicle(imei: str, update_data: dict[str, Any]) -> Vehicle:
        """Update a vehicle's information.

        Args:
            imei: Vehicle IMEI
            update_data: Fields to update

        Returns:
            Updated Vehicle model

        Raises:
            ResourceNotFoundException: If vehicle not found
        """
        # Find the vehicle
        vehicle = await Vehicle.find_one(Vehicle.imei == imei)
        if not vehicle:
            raise ResourceNotFoundException(f"Vehicle with IMEI {imei} not found")

        # Update fields
        for key, value in update_data.items():
            if hasattr(vehicle, key):
                setattr(vehicle, key, value)

        vehicle.updated_at = datetime.now(UTC)
        await vehicle.save()

        return vehicle

    @staticmethod
    async def delete_vehicle(imei: str) -> dict[str, str]:
        """Mark a vehicle as inactive.

        Args:
            imei: Vehicle IMEI

        Returns:
            Success message

        Raises:
            ResourceNotFoundException: If vehicle not found
        """
        vehicle = await Vehicle.find_one(Vehicle.imei == imei)
        if not vehicle:
            raise ResourceNotFoundException(f"Vehicle with IMEI {imei} not found")

        vehicle.is_active = False
        vehicle.updated_at = datetime.now(UTC)
        await vehicle.save()

        return {"status": "success", "message": "Vehicle marked as inactive"}

    @staticmethod
    async def get_vehicle_by_imei(imei: str) -> Vehicle | None:
        """Get a vehicle by IMEI.

        Args:
            imei: Vehicle IMEI

        Returns:
            Vehicle model or None if not found
        """
        return await Vehicle.find_one(Vehicle.imei == imei)
