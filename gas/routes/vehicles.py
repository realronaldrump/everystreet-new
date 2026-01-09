"""API routes for vehicle management."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from db import serialize_document
from gas.services import VehicleService
from models import VehicleModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/vehicles")
async def get_vehicles(
    imei: str | None = Query(None, description="Filter by IMEI"),
    vin: str | None = Query(None, description="Filter by VIN"),
    active_only: bool = Query(True, description="Only return active vehicles"),
) -> list[dict[str, Any]]:
    """Get all vehicles or filter by IMEI/VIN."""
    try:
        vehicles = await VehicleService.get_vehicles(imei, vin, active_only)
        return [serialize_document(v) for v in vehicles]

    except Exception as e:
        logger.error("Error fetching vehicles: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/vehicles")
async def create_vehicle(vehicle_data: VehicleModel) -> dict[str, Any]:
    """Create a new vehicle record."""
    try:
        vehicle_dict = vehicle_data.model_dump(exclude={"id"}, exclude_none=True)
        vehicle = await VehicleService.create_vehicle(vehicle_dict)
        return serialize_document(vehicle)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error creating vehicle: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/vehicles/{imei}")
async def update_vehicle(imei: str, vehicle_data: VehicleModel) -> dict[str, Any]:
    """Update a vehicle's information."""
    try:
        update_data = vehicle_data.model_dump(
            exclude={"id", "imei", "created_at"}, exclude_none=True
        )
        vehicle = await VehicleService.update_vehicle(imei, update_data)
        return serialize_document(vehicle)

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("Error updating vehicle: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/vehicles/{imei}")
async def delete_vehicle(imei: str) -> dict[str, str]:
    """Delete a vehicle (or mark as inactive)."""
    try:
        result = await VehicleService.delete_vehicle(imei)
        return result

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("Error deleting vehicle: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
