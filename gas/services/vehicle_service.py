"""Business logic for vehicle management."""

import logging
from typing import Any

from core.exceptions import DuplicateResourceException, ResourceNotFoundException
from db.models import Vehicle
from fleet.registry import FleetRegistry

logger = logging.getLogger(__name__)


class VehicleService:
    """Service class for vehicle operations."""

    @staticmethod
    async def upsert_active_device(
        imei: str,
        custom_name: str | None = None,
    ) -> Vehicle:
        """
        Create or update an active Fleet Registry device.

        If the vehicle already exists, it is reactivated and its name updated.

        Args:
            imei: Device IMEI (must be non-empty).
            custom_name: Optional human-readable name.

        Returns:
            The upserted Vehicle document.
        """
        return await FleetRegistry.register_device(imei, custom_name=custom_name)

    @staticmethod
    async def get_vehicles(
        imei: str | None = None,
        vin: str | None = None,
        active_only: bool = True,
    ) -> list[Vehicle]:
        """
        Get all vehicles or filter by IMEI/VIN.

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
            conditions.append(Vehicle.is_active == True)  # noqa: E712

        query = Vehicle.find(*conditions) if conditions else Vehicle.find_all()

        vehicles = await query.sort(-Vehicle.created_at).to_list()

        logger.info("Fetched %d vehicles (active_only=%s)", len(vehicles), active_only)
        return vehicles

    @staticmethod
    async def create_vehicle(vehicle_data: dict[str, Any]) -> Vehicle:
        """
        Create a new vehicle record.

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
            msg = "Vehicle with this IMEI already exists"
            raise DuplicateResourceException(msg)

        imei = vehicle_data["imei"]
        await FleetRegistry.register_device(
            imei,
            custom_name=vehicle_data.get("custom_name"),
        )
        user_fields = {
            key: value
            for key, value in vehicle_data.items()
            if key not in {"imei", "custom_name"}
        }
        vehicle = await FleetRegistry.update_user_device(imei, **user_fields)
        if vehicle is None:  # pragma: no cover - registration just created it
            msg = f"Vehicle with IMEI {imei} not found"
            raise ResourceNotFoundException(msg)
        return vehicle

    @staticmethod
    async def update_vehicle(imei: str, update_data: dict[str, Any]) -> Vehicle:
        """
        Update a vehicle's information.

        Args:
            imei: Vehicle IMEI
            update_data: Fields to update

        Returns:
            Updated Vehicle model

        Raises:
            ResourceNotFoundException: If vehicle not found
        """
        vehicle = await FleetRegistry.update_user_device(imei, **update_data)
        if vehicle is None:
            msg = f"Vehicle with IMEI {imei} not found"
            raise ResourceNotFoundException(msg)
        return vehicle

    @staticmethod
    async def delete_vehicle(imei: str) -> dict[str, str]:
        """
        Deactivate a device while preserving historical trip linkage.

        Args:
            imei: Vehicle IMEI

        Returns:
            Success message

        Raises:
            ResourceNotFoundException: If vehicle not found
        """
        vehicle = await FleetRegistry.deactivate_device(imei)
        if not vehicle:
            msg = f"Vehicle with IMEI {imei} not found"
            raise ResourceNotFoundException(msg)

        return {"status": "success", "message": "Fleet device deactivated"}
