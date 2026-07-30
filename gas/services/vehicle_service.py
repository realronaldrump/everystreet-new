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
        now = datetime.now(UTC)
        vehicle = await Vehicle.find_one(Vehicle.imei == imei)
        if vehicle:
            if custom_name is not None:
                vehicle.custom_name = custom_name
            vehicle.is_active = True
            vehicle.updated_at = now
            await vehicle.save()
        else:
            vehicle = Vehicle(
                imei=imei,
                custom_name=custom_name,
                is_active=True,
                created_at=now,
                updated_at=now,
            )
            await vehicle.insert()

        return vehicle

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

        vehicle_data["created_at"] = datetime.now(UTC)
        vehicle_data["updated_at"] = datetime.now(UTC)

        vehicle = Vehicle(**vehicle_data)
        await vehicle.insert()

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
        # Find the vehicle
        vehicle = await Vehicle.find_one(Vehicle.imei == imei)
        if not vehicle:
            msg = f"Vehicle with IMEI {imei} not found"
            raise ResourceNotFoundException(msg)

        # Track if odometer is being updated
        odometer_updated = "odometer_reading" in update_data

        if odometer_updated:
            reading = update_data.get("odometer_reading")
            if reading is not None and reading < 0:
                msg = "odometer_reading must be greater than or equal to 0"
                raise ValueError(msg)
            if reading is None:
                update_data["odometer_source"] = None
                update_data["odometer_is_estimated"] = False
            elif update_data.get("odometer_is_estimated") is None:
                update_data["odometer_is_estimated"] = update_data.get(
                    "odometer_source"
                ) in {"estimated", "bouncie_untrusted"}

        # Update fields
        for key, value in update_data.items():
            if hasattr(vehicle, key):
                setattr(vehicle, key, value)

        vehicle.updated_at = datetime.now(UTC)

        # Set odometer timestamp if odometer was updated
        if odometer_updated:
            vehicle.odometer_updated_at = datetime.now(UTC)

        await vehicle.save()

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
        vehicle = await Vehicle.find_one(Vehicle.imei == imei)
        if not vehicle:
            msg = f"Vehicle with IMEI {imei} not found"
            raise ResourceNotFoundException(msg)

        vehicle.is_active = False
        vehicle.updated_at = datetime.now(UTC)
        await vehicle.save()

        return {"status": "success", "message": "Fleet device deactivated"}
