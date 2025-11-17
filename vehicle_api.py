"""Vehicle management API endpoints.

This module provides endpoints for managing vehicle information,
including custom names, VINs, and active status.
"""

import logging
from datetime import UTC, datetime

import aiohttp
import pymongo
from bson import ObjectId
from fastapi import APIRouter, HTTPException, status

from config import API_BASE_URL, get_bouncie_config
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
from models import VehicleCreateModel, VehicleModel
from utils import get_session, retry_async

logger = logging.getLogger(__name__)
router = APIRouter()


@retry_async(max_retries=3, retry_delay=1.5)
async def get_access_token(
    session: aiohttp.ClientSession,
    credentials: dict,
) -> str | None:
    """Get an access token from the Bouncie API using OAuth.

    Args:
        session: aiohttp session to use for the request
        credentials: Dictionary containing client_id, client_secret,
                    authorization_code, and redirect_uri

    Returns:
        Access token string or None if failed
    """
    from config import AUTH_URL

    payload = {
        "client_id": credentials.get("client_id"),
        "client_secret": credentials.get("client_secret"),
        "grant_type": "authorization_code",
        "code": credentials.get("authorization_code"),
        "redirect_uri": credentials.get("redirect_uri"),
    }

    try:
        async with session.post(AUTH_URL, data=payload) as response:
            response.raise_for_status()
            data = await response.json()
            access_token = data.get("access_token")
            if not access_token:
                logger.error("Access token not found in response")
                return None
            return access_token
    except Exception as e:
        logger.error(f"Error retrieving access token: {e}")
        return None


@retry_async(max_retries=3, retry_delay=1.5)
async def fetch_bouncie_vehicles(
    session: aiohttp.ClientSession, token: str
) -> list[dict]:
    """Fetch all vehicles from Bouncie API.

    Args:
        session: aiohttp session to use for the request
        token: Access token for Bouncie API

    Returns:
        List of vehicle data dictionaries from Bouncie
    """
    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    url = f"{API_BASE_URL}/vehicles"

    try:
        async with session.get(url, headers=headers) as response:
            response.raise_for_status()
            vehicles = await response.json()
            logger.info(f"Fetched {len(vehicles)} vehicles from Bouncie API")
            return vehicles
    except Exception as e:
        logger.error(f"Error fetching vehicles from Bouncie: {e}")
        return []


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


@router.post("/api/vehicles/sync-from-bouncie", tags=["Vehicles"])
async def sync_vehicles_from_bouncie():
    """Sync vehicles from Bouncie API.

    Fetches comprehensive vehicle data from Bouncie including VIN, make, model, year,
    and updates existing records or creates new ones.

    Returns:
        Summary of vehicles synced
    """
    try:
        # Get Bouncie credentials
        credentials = await get_bouncie_config()

        # Get access token
        async with get_session() as session:
            access_token = await get_access_token(session, credentials)
            if not access_token:
                logger.warning(
                    "Could not get Bouncie access token, falling back to basic sync"
                )
                return await sync_vehicles_from_trips()

            # Fetch vehicles from Bouncie API
            bouncie_vehicles = await fetch_bouncie_vehicles(session, access_token)

        if not bouncie_vehicles:
            logger.warning("No vehicles returned from Bouncie, falling back to basic sync")
            return await sync_vehicles_from_trips()

        # Get existing vehicles from database
        existing_vehicles = await find_with_retry(vehicles_collection, {})
        existing_by_imei = {v["imei"]: v for v in existing_vehicles}

        created_count = 0
        updated_count = 0

        for bouncie_vehicle in bouncie_vehicles:
            imei = bouncie_vehicle.get("imei")
            if not imei:
                continue

            # Extract vehicle information from Bouncie
            model_info = bouncie_vehicle.get("model", {})
            make = model_info.get("make")
            model = model_info.get("name")
            year = model_info.get("year")
            vin = bouncie_vehicle.get("vin")
            nickname = bouncie_vehicle.get("nickName")

            # Use Bouncie nickname if available, otherwise create a friendly name
            if nickname:
                default_name = nickname
            elif make and model and year:
                default_name = f"{year} {make} {model}"
            elif make and model:
                default_name = f"{make} {model}"
            else:
                default_name = f"Vehicle {imei}"

            vehicle_data = {
                "imei": imei,
                "vin": vin,
                "make": make,
                "model": model,
                "year": year,
                "updated_at": datetime.now(UTC),
            }

            if imei in existing_by_imei:
                # Update existing vehicle
                existing = existing_by_imei[imei]

                # Only update custom_name if it's still the default format
                if (
                    not existing.get("custom_name")
                    or existing.get("custom_name", "").startswith("Vehicle ")
                ):
                    vehicle_data["custom_name"] = default_name

                # Update the vehicle
                await update_one_with_retry(
                    vehicles_collection,
                    {"imei": imei},
                    {"$set": vehicle_data},
                )
                updated_count += 1
                logger.info(f"Updated vehicle {imei}: {default_name}")
            else:
                # Create new vehicle
                vehicle_data["custom_name"] = default_name
                vehicle_data["is_active"] = True
                vehicle_data["created_at"] = datetime.now(UTC)

                await insert_one_with_retry(vehicles_collection, vehicle_data)
                created_count += 1
                logger.info(f"Created vehicle {imei}: {default_name}")

        return {
            "message": "Vehicles synced successfully from Bouncie",
            "total_bouncie_vehicles": len(bouncie_vehicles),
            "new_vehicles_created": created_count,
            "existing_vehicles_updated": updated_count,
        }

    except Exception as e:
        logger.error(f"Error syncing vehicles from Bouncie: {str(e)}")
        # Fall back to basic sync on error
        logger.info("Falling back to basic trip-based sync")
        return await sync_vehicles_from_trips()


@router.post("/api/vehicles/sync-from-trips", tags=["Vehicles"])
async def sync_vehicles_from_trips():
    """Sync vehicles from trip data (fallback method).

    Creates basic vehicle records for any IMEIs found in trips that don't have
    vehicle records yet. This is a fallback when Bouncie API is not available.

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
            "message": "Vehicles synced from trips (basic sync)",
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
