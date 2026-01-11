"""API routes for vehicle management."""

import logging
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query

from db.schemas import VehicleModel
from gas.services import VehicleService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/vehicles")
async def get_vehicles(
    imei: Annotated[str | None, Query(description="Filter by IMEI")] = None,
    vin: Annotated[str | None, Query(description="Filter by VIN")] = None,
    active_only: Annotated[
        bool,
        Query(description="Only return active vehicles"),
    ] = True,
) -> list[dict[str, Any]]:
    """Get all vehicles or filter by IMEI/VIN."""
    try:
        vehicles = await VehicleService.get_vehicles(imei, vin, active_only)
        # Convert Beanie models to JSON-compatible dicts
        return [v.model_dump(by_alias=True, mode="json") for v in vehicles]

    except Exception as e:
        logger.exception("Error fetching vehicles: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/vehicles")
async def create_vehicle(vehicle_data: VehicleModel) -> dict[str, Any]:
    """Create a new vehicle record."""
    try:
        vehicle_dict = vehicle_data.model_dump(exclude={"id"}, exclude_none=True)
        vehicle = await VehicleService.create_vehicle(vehicle_dict)
        # Convert Beanie model to JSON-compatible dict
        return vehicle.model_dump(by_alias=True, mode="json")

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error creating vehicle: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/vehicles/{imei}")
async def update_vehicle(imei: str, vehicle_data: VehicleModel) -> dict[str, Any]:
    """Update a vehicle's information."""
    try:
        update_data = vehicle_data.model_dump(
            exclude={"id", "imei", "created_at"},
            exclude_none=True,
        )
        vehicle = await VehicleService.update_vehicle(imei, update_data)
        # Convert Beanie model to JSON-compatible dict
        return vehicle.model_dump(by_alias=True, mode="json")

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("Error updating vehicle: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/vehicles/{imei}")
async def delete_vehicle(imei: str) -> dict[str, str]:
    """Delete a vehicle (or mark as inactive)."""
    try:
        return await VehicleService.delete_vehicle(imei)

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("Error deleting vehicle: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
