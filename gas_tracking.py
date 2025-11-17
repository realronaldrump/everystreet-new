"""Gas tracking API endpoints for fuel consumption and cost analysis.

This module provides endpoints for managing gas fill-up records, calculating
MPG, and analyzing fuel costs across trips.
"""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import pymongo
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from date_utils import normalize_to_utc_datetime
from db import (
    aggregate_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    gas_fillups_collection,
    insert_one_with_retry,
    serialize_document,
    trips_collection,
    update_one_with_retry,
)
from models import GasFillupCreateModel, GasFillupModel, GasStatisticsModel

logger = logging.getLogger(__name__)
router = APIRouter()


# ==============================================================================
# Helper Functions
# ==============================================================================


async def calculate_mpg_since_last_fillup(
    current_fillup: dict[str, Any],
    previous_fillup: dict[str, Any] | None,
) -> dict[str, Any]:
    """Calculate MPG and trip statistics since the last fill-up.

    Args:
        current_fillup: Current fill-up record
        previous_fillup: Previous fill-up record (if exists)

    Returns:
        Dictionary with calculated statistics
    """
    if not previous_fillup:
        return {
            "mpg": None,
            "distance_traveled": None,
            "trips_count": 0,
        }

    # Calculate distance from odometer difference
    distance = current_fillup["odometer"] - previous_fillup["odometer"]

    # Calculate MPG (only for full tank fill-ups)
    mpg = None
    if current_fillup.get("is_full_tank", True):
        gallons = current_fillup["gallons"]
        if gallons > 0:
            mpg = distance / gallons

    # Count trips between fill-ups
    imei = current_fillup["imei"]
    trips_count = await trips_collection.count_documents(
        {
            "imei": imei,
            "endTime": {
                "$gte": previous_fillup["fillup_time"],
                "$lte": current_fillup["fillup_time"],
            },
        }
    )

    return {
        "mpg": round(mpg, 2) if mpg else None,
        "distance_traveled": round(distance, 2),
        "trips_count": trips_count,
    }


async def get_latest_odometer_reading(imei: str) -> float | None:
    """Get the most recent odometer reading from trips or fill-ups.

    Args:
        imei: Vehicle identifier

    Returns:
        Latest odometer reading or None
    """
    # Check latest trip
    latest_trip = await find_one_with_retry(
        trips_collection,
        {"imei": imei, "endOdometer": {"$exists": True}},
        projection={"endOdometer": 1},
        sort=[("endTime", pymongo.DESCENDING)],
    )

    # Check latest fillup
    latest_fillup = await find_one_with_retry(
        gas_fillups_collection,
        {"imei": imei},
        projection={"odometer": 1},
        sort=[("fillup_time", pymongo.DESCENDING)],
    )

    odometer_readings = []
    if latest_trip and latest_trip.get("endOdometer"):
        odometer_readings.append(latest_trip["endOdometer"])
    if latest_fillup and latest_fillup.get("odometer"):
        odometer_readings.append(latest_fillup["odometer"])

    return max(odometer_readings) if odometer_readings else None


async def detect_gas_station_location(
    imei: str, fillup_time: datetime
) -> dict[str, Any] | None:
    """Detect gas station location from nearby trip data.

    Args:
        imei: Vehicle identifier
        fillup_time: Time of fill-up

    Returns:
        Location dictionary with address and coordinates or None
    """
    # Find trip closest to fillup time
    time_window = 3600  # 1 hour in seconds

    # Try to find a trip that ended near the fillup time
    trip = await find_one_with_retry(
        trips_collection,
        {
            "imei": imei,
            "endTime": {
                "$gte": fillup_time.replace(microsecond=0)
                - timedelta(seconds=time_window),
                "$lte": fillup_time.replace(microsecond=0)
                + timedelta(seconds=time_window),
            },
            "destination": {"$exists": True},
        },
        projection={"destination": 1, "gps": 1},
        sort=[("endTime", pymongo.DESCENDING)],
    )

    if trip and trip.get("destination"):
        return trip["destination"]

    return None


# ==============================================================================
# API Endpoints
# ==============================================================================


@router.post("/api/gas-fillups", tags=["Gas Tracking"])
async def create_fillup(fillup_data: GasFillupCreateModel):
    """Create a new gas fill-up record.

    Args:
        fillup_data: Fill-up information

    Returns:
        Created fill-up record with calculated MPG
    """
    try:
        # Normalize fillup_time to datetime
        if isinstance(fillup_data.fillup_time, str):
            fillup_time = normalize_to_utc_datetime(fillup_data.fillup_time)
        else:
            fillup_time = fillup_data.fillup_time

        if not fillup_time:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid fillup_time format",
            )

        # Calculate total cost
        total_cost = fillup_data.price_per_gallon * fillup_data.gallons

        # Find previous fill-up for this vehicle
        previous_fillup = await find_one_with_retry(
            gas_fillups_collection,
            {
                "imei": fillup_data.imei,
                "fillup_time": {"$lt": fillup_time},
            },
            sort=[("fillup_time", pymongo.DESCENDING)],
        )

        # Auto-detect location if not provided
        location = fillup_data.location
        if not location:
            location = await detect_gas_station_location(fillup_data.imei, fillup_time)

        # Prepare fillup document
        fillup_doc = {
            "imei": fillup_data.imei,
            "fillup_time": fillup_time,
            "location": location,
            "price_per_gallon": fillup_data.price_per_gallon,
            "gallons": fillup_data.gallons,
            "total_cost": round(total_cost, 2),
            "odometer": fillup_data.odometer,
            "is_full_tank": fillup_data.is_full_tank,
            "notes": fillup_data.notes,
            "previous_fillup_id": (
                previous_fillup["_id"] if previous_fillup else None
            ),
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
        }

        # Calculate MPG if we have a previous fillup
        stats = await calculate_mpg_since_last_fillup(fillup_doc, previous_fillup)
        fillup_doc["calculated_mpg"] = stats["mpg"]
        fillup_doc["trip_since_last_fillup"] = {
            "distance_traveled": stats["distance_traveled"],
            "trips_count": stats["trips_count"],
        }

        # Insert into database
        result = await insert_one_with_retry(gas_fillups_collection, fillup_doc)

        # Retrieve and return the created document
        created_fillup = await find_one_with_retry(
            gas_fillups_collection, {"_id": result.inserted_id}
        )

        return serialize_document(created_fillup)

    except Exception as e:
        logger.error(f"Error creating gas fillup: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error creating gas fillup: {str(e)}",
        )


@router.get("/api/gas-fillups", tags=["Gas Tracking"])
async def get_fillups(
    imei: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = 100,
):
    """Get gas fill-up records with optional filtering.

    Args:
        imei: Filter by vehicle identifier
        start_date: Filter by start date
        end_date: Filter by end date
        limit: Maximum number of records to return

    Returns:
        List of fill-up records
    """
    try:
        query = {}

        if imei:
            query["imei"] = imei

        if start_date or end_date:
            time_query = {}
            if start_date:
                start_dt = normalize_to_utc_datetime(start_date)
                if start_dt:
                    time_query["$gte"] = start_dt
            if end_date:
                end_dt = normalize_to_utc_datetime(end_date)
                if end_dt:
                    time_query["$lte"] = end_dt
            if time_query:
                query["fillup_time"] = time_query

        fillups = await find_with_retry(
            gas_fillups_collection,
            query,
            sort=[("fillup_time", pymongo.DESCENDING)],
            limit=limit,
        )

        return [serialize_document(fillup) for fillup in fillups]

    except Exception as e:
        logger.error(f"Error retrieving gas fillups: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving gas fillups: {str(e)}",
        )


@router.get("/api/gas-fillups/{fillup_id}", tags=["Gas Tracking"])
async def get_fillup(fillup_id: str):
    """Get a specific gas fill-up record by ID.

    Args:
        fillup_id: Fill-up record ID

    Returns:
        Fill-up record
    """
    try:
        if not ObjectId.is_valid(fillup_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid fillup ID format",
            )

        fillup = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )

        if not fillup:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Fill-up record not found",
            )

        return serialize_document(fillup)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving gas fillup: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving gas fillup: {str(e)}",
        )


@router.put("/api/gas-fillups/{fillup_id}", tags=["Gas Tracking"])
async def update_fillup(fillup_id: str, fillup_data: GasFillupCreateModel):
    """Update a gas fill-up record.

    Args:
        fillup_id: Fill-up record ID
        fillup_data: Updated fill-up information

    Returns:
        Updated fill-up record
    """
    try:
        if not ObjectId.is_valid(fillup_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid fillup ID format",
            )

        # Check if fillup exists
        existing_fillup = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )

        if not existing_fillup:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Fill-up record not found",
            )

        # Normalize fillup_time
        if isinstance(fillup_data.fillup_time, str):
            fillup_time = normalize_to_utc_datetime(fillup_data.fillup_time)
        else:
            fillup_time = fillup_data.fillup_time

        # Calculate total cost
        total_cost = fillup_data.price_per_gallon * fillup_data.gallons

        # Find previous fill-up
        previous_fillup = await find_one_with_retry(
            gas_fillups_collection,
            {
                "imei": fillup_data.imei,
                "fillup_time": {"$lt": fillup_time},
                "_id": {"$ne": ObjectId(fillup_id)},
            },
            sort=[("fillup_time", pymongo.DESCENDING)],
        )

        # Prepare update document
        update_doc = {
            "imei": fillup_data.imei,
            "fillup_time": fillup_time,
            "location": fillup_data.location,
            "price_per_gallon": fillup_data.price_per_gallon,
            "gallons": fillup_data.gallons,
            "total_cost": round(total_cost, 2),
            "odometer": fillup_data.odometer,
            "is_full_tank": fillup_data.is_full_tank,
            "notes": fillup_data.notes,
            "previous_fillup_id": (
                previous_fillup["_id"] if previous_fillup else None
            ),
            "updated_at": datetime.now(UTC),
        }

        # Recalculate MPG
        stats = await calculate_mpg_since_last_fillup(update_doc, previous_fillup)
        update_doc["calculated_mpg"] = stats["mpg"]
        update_doc["trip_since_last_fillup"] = {
            "distance_traveled": stats["distance_traveled"],
            "trips_count": stats["trips_count"],
        }

        # Update in database
        await update_one_with_retry(
            gas_fillups_collection,
            {"_id": ObjectId(fillup_id)},
            {"$set": update_doc},
        )

        # Retrieve and return updated document
        updated_fillup = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )

        return serialize_document(updated_fillup)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating gas fillup: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error updating gas fillup: {str(e)}",
        )


@router.delete("/api/gas-fillups/{fillup_id}", tags=["Gas Tracking"])
async def delete_fillup(fillup_id: str):
    """Delete a gas fill-up record.

    Args:
        fillup_id: Fill-up record ID

    Returns:
        Success message
    """
    try:
        if not ObjectId.is_valid(fillup_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid fillup ID format",
            )

        result = await delete_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )

        if result.deleted_count == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Fill-up record not found",
            )

        return {"message": "Fill-up record deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting gas fillup: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting gas fillup: {str(e)}",
        )


@router.get("/api/gas-statistics", tags=["Gas Tracking"])
async def get_gas_statistics(
    imei: str,
    start_date: str | None = None,
    end_date: str | None = None,
):
    """Get comprehensive gas consumption statistics for a vehicle.

    Args:
        imei: Vehicle identifier
        start_date: Optional start date for filtering
        end_date: Optional end date for filtering

    Returns:
        Gas consumption statistics
    """
    try:
        # Build query
        match_query: dict[str, Any] = {"imei": imei}

        if start_date or end_date:
            time_query = {}
            if start_date:
                start_dt = normalize_to_utc_datetime(start_date)
                if start_dt:
                    time_query["$gte"] = start_dt
            if end_date:
                end_dt = normalize_to_utc_datetime(end_date)
                if end_dt:
                    time_query["$lte"] = end_dt
            if time_query:
                match_query["fillup_time"] = time_query

        # Aggregation pipeline for statistics
        pipeline = [
            {"$match": match_query},
            {
                "$group": {
                    "_id": "$imei",
                    "total_fillups": {"$sum": 1},
                    "total_gallons": {"$sum": "$gallons"},
                    "total_cost": {"$sum": "$total_cost"},
                    "average_price_per_gallon": {"$avg": "$price_per_gallon"},
                    "mpg_values": {
                        "$push": {
                            "$cond": [
                                {"$ne": ["$calculated_mpg", None]},
                                "$calculated_mpg",
                                "$$REMOVE",
                            ]
                        }
                    },
                    "min_fillup_time": {"$min": "$fillup_time"},
                    "max_fillup_time": {"$max": "$fillup_time"},
                    "first_odometer": {"$min": "$odometer"},
                    "last_odometer": {"$max": "$odometer"},
                }
            },
            {
                "$project": {
                    "imei": "$_id",
                    "total_fillups": 1,
                    "total_gallons": {"$round": ["$total_gallons", 2]},
                    "total_cost": {"$round": ["$total_cost", 2]},
                    "average_price_per_gallon": {
                        "$round": ["$average_price_per_gallon", 3]
                    },
                    "average_mpg": {
                        "$cond": [
                            {"$gt": [{"$size": "$mpg_values"}, 0]},
                            {"$round": [{"$avg": "$mpg_values"}, 2]},
                            None,
                        ]
                    },
                    "best_mpg": {
                        "$cond": [
                            {"$gt": [{"$size": "$mpg_values"}, 0]},
                            {"$round": [{"$max": "$mpg_values"}, 2]},
                            None,
                        ]
                    },
                    "worst_mpg": {
                        "$cond": [
                            {"$gt": [{"$size": "$mpg_values"}, 0]},
                            {"$round": [{"$min": "$mpg_values"}, 2]},
                            None,
                        ]
                    },
                    "total_distance": {
                        "$round": [{"$subtract": ["$last_odometer", "$first_odometer"]}, 2]
                    },
                    "date_range": {
                        "start": "$min_fillup_time",
                        "end": "$max_fillup_time",
                    },
                }
            },
        ]

        results = await aggregate_with_retry(gas_fillups_collection, pipeline)

        if not results:
            return {
                "imei": imei,
                "total_fillups": 0,
                "total_gallons": 0,
                "total_cost": 0,
                "average_price_per_gallon": 0,
                "average_mpg": None,
                "best_mpg": None,
                "worst_mpg": None,
                "total_distance": None,
                "date_range": None,
            }

        return serialize_document(results[0])

    except Exception as e:
        logger.error(f"Error calculating gas statistics: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error calculating gas statistics: {str(e)}",
        )


@router.get("/api/latest-odometer/{imei}", tags=["Gas Tracking"])
async def get_latest_odometer(imei: str):
    """Get the latest odometer reading for a vehicle.

    Args:
        imei: Vehicle identifier

    Returns:
        Latest odometer reading
    """
    try:
        odometer = await get_latest_odometer_reading(imei)

        return {
            "imei": imei,
            "odometer": odometer,
            "timestamp": datetime.now(UTC).isoformat(),
        }

    except Exception as e:
        logger.error(f"Error getting latest odometer: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error getting latest odometer: {str(e)}",
        )


@router.get("/api/trip-gas-cost/{trip_id}", tags=["Gas Tracking"])
async def get_trip_gas_cost(trip_id: str):
    """Calculate estimated gas cost for a specific trip.

    Args:
        trip_id: Trip transaction ID or ObjectId

    Returns:
        Estimated gas cost for the trip
    """
    try:
        # Get trip data
        trip_query = {"transactionId": trip_id}
        if ObjectId.is_valid(trip_id):
            trip_query = {"$or": [{"transactionId": trip_id}, {"_id": ObjectId(trip_id)}]}

        trip = await find_one_with_retry(trips_collection, trip_query)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        # Get latest fill-up before trip end
        latest_fillup = await find_one_with_retry(
            gas_fillups_collection,
            {
                "imei": trip.get("imei"),
                "fillup_time": {"$lte": trip.get("endTime", datetime.now(UTC))},
            },
            sort=[("fillup_time", pymongo.DESCENDING)],
        )

        if not latest_fillup:
            return {
                "trip_id": trip_id,
                "distance": trip.get("distance"),
                "estimated_cost": None,
                "estimated_gallons": None,
                "message": "No fill-up data available for cost estimation",
            }

        # Calculate estimated cost
        distance = trip.get("distance", 0)
        mpg = latest_fillup.get("calculated_mpg")
        price_per_gallon = latest_fillup.get("price_per_gallon")

        if not mpg or not price_per_gallon:
            return {
                "trip_id": trip_id,
                "distance": distance,
                "estimated_cost": None,
                "estimated_gallons": None,
                "message": "Insufficient data for cost estimation",
            }

        estimated_gallons = distance / mpg
        estimated_cost = estimated_gallons * price_per_gallon

        return {
            "trip_id": trip_id,
            "distance": round(distance, 2),
            "estimated_gallons": round(estimated_gallons, 2),
            "estimated_cost": round(estimated_cost, 2),
            "mpg_used": round(mpg, 2),
            "price_per_gallon": round(price_per_gallon, 2),
            "based_on_fillup": {
                "fillup_id": str(latest_fillup["_id"]),
                "fillup_time": serialize_document(latest_fillup)["fillup_time"],
            },
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error calculating trip gas cost: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error calculating trip gas cost: {str(e)}",
        )
