"""Vehicle management API endpoints.

This module provides endpoints for managing vehicle information,
including custom names, VINs, and active status.
"""

import logging
from datetime import UTC, datetime

import pymongo
from bson import ObjectId
from fastapi import APIRouter, HTTPException, status

from db import (
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    insert_one_with_retry,
    serialize_document,
    trips_collection,
    update_one_with_retry,
    vehicles_collection,
)
from models import VehicleCreateModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/vehicles", tags=["Vehicles"])
async def get_vehicles(active_only: bool = False):
    """Get all vehicles.

    Args:
        active_only: If True, only return active vehicles

    Returns:
        List of vehicles
    """
    try:
        query = {}
        if active_only:
            query["is_active"] = True

        vehicles = await find_with_retry(
            vehicles_collection,
            query,
            sort=[("custom_name", pymongo.ASCENDING)],
        )

        return [serialize_document(vehicle) for vehicle in vehicles]

    except Exception as e:
        logger.error(f"Error retrieving vehicles: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving vehicles: {str(e)}",
        )


@router.get("/api/vehicles/{vehicle_id}", tags=["Vehicles"])
async def get_vehicle(vehicle_id: str):
    """Get a specific vehicle by ID.

    Args:
        vehicle_id: Vehicle ID

    Returns:
        Vehicle information
    """
    try:
        if not ObjectId.is_valid(vehicle_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid vehicle ID format",
            )

        vehicle = await find_one_with_retry(
            vehicles_collection, {"_id": ObjectId(vehicle_id)}
        )

        if not vehicle:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Vehicle not found",
            )

        return serialize_document(vehicle)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving vehicle: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving vehicle: {str(e)}",
        )


@router.get("/api/vehicles/by-imei/{imei}", tags=["Vehicles"])
async def get_vehicle_by_imei(imei: str):
    """Get a vehicle by IMEI.

    Args:
        imei: Vehicle IMEI

    Returns:
        Vehicle information
    """
    try:
        vehicle = await find_one_with_retry(vehicles_collection, {"imei": imei})

        if not vehicle:
            # Return a default vehicle structure if not found
            return {
                "imei": imei,
                "custom_name": f"Vehicle {imei}",
                "is_active": True,
                "exists": False,
            }

        return serialize_document(vehicle)

    except Exception as e:
        logger.error(f"Error retrieving vehicle by IMEI: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving vehicle: {str(e)}",
        )


@router.post("/api/vehicles", tags=["Vehicles"])
async def create_vehicle(vehicle_data: VehicleCreateModel):
    """Create a new vehicle.

    Args:
        vehicle_data: Vehicle information

    Returns:
        Created vehicle
    """
    try:
        # Check if vehicle with this IMEI already exists
        existing_vehicle = await find_one_with_retry(
            vehicles_collection, {"imei": vehicle_data.imei}
        )

        if existing_vehicle:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Vehicle with this IMEI already exists",
            )

        # Create vehicle document
        vehicle_doc = {
            "imei": vehicle_data.imei,
            "custom_name": vehicle_data.custom_name,
            "vin": vehicle_data.vin,
            "make": vehicle_data.make,
            "model": vehicle_data.model,
            "year": vehicle_data.year,
            "is_active": vehicle_data.is_active,
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
        }

        # Insert into database
        result = await insert_one_with_retry(vehicles_collection, vehicle_doc)

        # Retrieve and return the created document
        created_vehicle = await find_one_with_retry(
            vehicles_collection, {"_id": result.inserted_id}
        )

        return serialize_document(created_vehicle)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating vehicle: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error creating vehicle: {str(e)}",
        )


@router.put("/api/vehicles/{vehicle_id}", tags=["Vehicles"])
async def update_vehicle(vehicle_id: str, vehicle_data: VehicleCreateModel):
    """Update a vehicle.

    Args:
        vehicle_id: Vehicle ID
        vehicle_data: Updated vehicle information

    Returns:
        Updated vehicle
    """
    try:
        if not ObjectId.is_valid(vehicle_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid vehicle ID format",
            )

        # Check if vehicle exists
        existing_vehicle = await find_one_with_retry(
            vehicles_collection, {"_id": ObjectId(vehicle_id)}
        )

        if not existing_vehicle:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Vehicle not found",
            )

        # Check if another vehicle has this IMEI (if IMEI is being changed)
        if vehicle_data.imei != existing_vehicle["imei"]:
            conflicting_vehicle = await find_one_with_retry(
                vehicles_collection, {"imei": vehicle_data.imei}
            )
            if conflicting_vehicle:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Another vehicle with this IMEI already exists",
                )

        # Prepare update document
        update_doc = {
            "imei": vehicle_data.imei,
            "custom_name": vehicle_data.custom_name,
            "vin": vehicle_data.vin,
            "make": vehicle_data.make,
            "model": vehicle_data.model,
            "year": vehicle_data.year,
            "is_active": vehicle_data.is_active,
            "updated_at": datetime.now(UTC),
        }

        # Update in database
        await update_one_with_retry(
            vehicles_collection,
            {"_id": ObjectId(vehicle_id)},
            {"$set": update_doc},
        )

        # Retrieve and return updated document
        updated_vehicle = await find_one_with_retry(
            vehicles_collection, {"_id": ObjectId(vehicle_id)}
        )

        return serialize_document(updated_vehicle)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating vehicle: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error updating vehicle: {str(e)}",
        )


@router.delete("/api/vehicles/{vehicle_id}", tags=["Vehicles"])
async def delete_vehicle(vehicle_id: str):
    """Delete a vehicle.

    Args:
        vehicle_id: Vehicle ID

    Returns:
        Success message
    """
    try:
        if not ObjectId.is_valid(vehicle_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid vehicle ID format",
            )

        result = await delete_one_with_retry(
            vehicles_collection, {"_id": ObjectId(vehicle_id)}
        )

        if result.deleted_count == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Vehicle not found",
            )

        return {"message": "Vehicle deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting vehicle: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting vehicle: {str(e)}",
        )


@router.post("/api/vehicles/sync-from-trips", tags=["Vehicles"])
async def sync_vehicles_from_trips():
    """Sync vehicles from trip data.

    Creates vehicle records for any IMEIs found in trips that don't have vehicle records yet.

    Returns:
        Summary of vehicles synced
    """
    try:
        # Get all unique IMEIs from trips
        imeis = await trips_collection.distinct("imei")

        # Get existing vehicle IMEIs
        existing_vehicles = await find_with_retry(
            vehicles_collection, {}, projection={"imei": 1}
        )
        existing_imeis = {v["imei"] for v in existing_vehicles}

        # Find IMEIs that don't have vehicle records
        new_imeis = [imei for imei in imeis if imei and imei not in existing_imeis]

        # Create vehicle records for new IMEIs
        created_count = 0
        for imei in new_imeis:
            vehicle_doc = {
                "imei": imei,
                "custom_name": f"Vehicle {imei}",
                "vin": None,
                "make": None,
                "model": None,
                "year": None,
                "is_active": True,
                "created_at": datetime.now(UTC),
                "updated_at": datetime.now(UTC),
            }
            await insert_one_with_retry(vehicles_collection, vehicle_doc)
            created_count += 1

        return {
            "message": "Vehicles synced successfully",
            "total_imeis": len(imeis),
            "existing_vehicles": len(existing_imeis),
            "new_vehicles_created": created_count,
        }

    except Exception as e:
        logger.error(f"Error syncing vehicles: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error syncing vehicles: {str(e)}",
        )
