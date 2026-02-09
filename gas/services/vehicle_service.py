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
        Delete a vehicle from the local database and de-authorize it for trip sync.

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

        # Remove from the authorized_devices list so future syncs don't immediately
        # re-add it to the local database.
        try:
            from setup.services.bouncie_credentials import (
                get_bouncie_credentials,
                update_bouncie_credentials,
            )

            credentials = await get_bouncie_credentials()
            devices = credentials.get("authorized_devices") or []
            if isinstance(devices, str):
                devices = [d.strip() for d in devices.split(",") if d.strip()]
            if not isinstance(devices, list):
                devices = []
            devices = [str(d).strip() for d in devices if str(d).strip()]

            if imei in devices:
                next_devices = [d for d in devices if d != imei]
                updated = await update_bouncie_credentials(
                    {"authorized_devices": next_devices},
                )
                if not updated:
                    raise RuntimeError("Failed to update authorized devices")
        except Exception:
            # Don't silently "succeed" if we couldn't deauthorize; the vehicle would
            # likely come back on the next sync.
            logger.exception("Failed to deauthorize vehicle %s from Bouncie credentials", imei)
            raise

        await vehicle.delete()

        return {"status": "success", "message": "Vehicle deleted"}
