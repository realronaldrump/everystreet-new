"""API endpoints for gas tracking and vehicle management."""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError

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
    vehicles_collection,
)
from models import GasFillupCreateModel, VehicleModel

logger = logging.getLogger(__name__)
router = APIRouter()


# === Vehicle Management Endpoints ===


@router.get("/api/vehicles")
async def get_vehicles(
    imei: str | None = Query(None, description="Filter by IMEI"),
    vin: str | None = Query(None, description="Filter by VIN"),
    active_only: bool = Query(True, description="Only return active vehicles"),
) -> list[dict[str, Any]]:
    """Get all vehicles or filter by IMEI/VIN."""
    try:
        query: dict[str, Any] = {}

        if imei:
            query["imei"] = imei
        if vin:
            query["vin"] = vin
        if active_only:
            query["is_active"] = True

        vehicles = await find_with_retry(
            vehicles_collection,
            query,
            sort=[("created_at", -1)],
        )

        return [serialize_document(v) for v in vehicles]

    except Exception as e:
        logger.error(f"Error fetching vehicles: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/vehicles")
async def create_vehicle(vehicle_data: VehicleModel) -> dict[str, Any]:
    """Create a new vehicle record."""
    try:
        # Check if vehicle with this IMEI already exists
        existing = await find_one_with_retry(
            vehicles_collection, {"imei": vehicle_data.imei}
        )
        if existing:
            raise HTTPException(
                status_code=400, detail="Vehicle with this IMEI already exists"
            )

        vehicle_dict = vehicle_data.model_dump(exclude={"id"}, exclude_none=True)
        vehicle_dict["created_at"] = datetime.now(UTC)
        vehicle_dict["updated_at"] = datetime.now(UTC)

        result = await insert_one_with_retry(vehicles_collection, vehicle_dict)
        vehicle_dict["_id"] = result.inserted_id

        return serialize_document(vehicle_dict)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating vehicle: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/vehicles/{imei}")
async def update_vehicle(imei: str, vehicle_data: VehicleModel) -> dict[str, Any]:
    """Update a vehicle's information."""
    try:
        # Find the vehicle
        existing = await find_one_with_retry(vehicles_collection, {"imei": imei})
        if not existing:
            raise HTTPException(status_code=404, detail="Vehicle not found")

        # Update fields
        update_data = vehicle_data.model_dump(
            exclude={"id", "imei", "created_at"}, exclude_none=True
        )
        update_data["updated_at"] = datetime.now(UTC)

        await update_one_with_retry(
            vehicles_collection, {"imei": imei}, {"$set": update_data}
        )

        # Fetch and return updated vehicle
        updated = await find_one_with_retry(vehicles_collection, {"imei": imei})
        return serialize_document(updated)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating vehicle: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/vehicles/{imei}")
async def delete_vehicle(imei: str) -> dict[str, str]:
    """Delete a vehicle (or mark as inactive)."""
    try:
        # Instead of deleting, mark as inactive
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
            raise HTTPException(status_code=404, detail="Vehicle not found")

        return {"status": "success", "message": "Vehicle marked as inactive"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting vehicle: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# === Gas Fill-up Endpoints ===


@router.get("/api/gas-fillups")
async def get_gas_fillups(
    imei: str | None = Query(None, description="Filter by vehicle IMEI"),
    vin: str | None = Query(None, description="Filter by VIN"),
    start_date: str | None = Query(None, description="Start date filter"),
    end_date: str | None = Query(None, description="End date filter"),
    limit: int = Query(100, description="Maximum number of records to return"),
) -> list[dict[str, Any]]:
    """Get gas fill-up records with optional filters."""
    try:
        query: dict[str, Any] = {}

        if imei:
            query["imei"] = imei
        if vin:
            query["vin"] = vin

        # Date filtering
        if start_date or end_date:
            date_query: dict[str, Any] = {}
            if start_date:
                date_query["$gte"] = datetime.fromisoformat(
                    start_date.replace("Z", "+00:00")
                )
            if end_date:
                date_query["$lte"] = datetime.fromisoformat(
                    end_date.replace("Z", "+00:00")
                )
            query["fillup_time"] = date_query

        fillups = await find_with_retry(
            gas_fillups_collection,
            query,
            sort=[("fillup_time", -1)],
            limit=limit,
        )

        return [serialize_document(f) for f in fillups]

    except Exception as e:
        logger.error(f"Error fetching gas fillups: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/gas-fillups/{fillup_id}")
async def get_gas_fillup(fillup_id: str) -> dict[str, Any]:
    """Get a specific gas fill-up by ID."""
    try:
        if not ObjectId.is_valid(fillup_id):
            raise HTTPException(status_code=400, detail="Invalid fillup ID")

        fillup = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )
        if not fillup:
            raise HTTPException(status_code=404, detail="Fill-up not found")

        return serialize_document(fillup)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching gas fillup: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/gas-fillups")
async def create_gas_fillup(
    fillup_data: GasFillupCreateModel,
) -> dict[str, Any]:
    """Create a new gas fill-up record."""
    try:
        # Convert string datetime to datetime object if needed
        fillup_time = fillup_data.fillup_time
        if isinstance(fillup_time, str):
            fillup_time = datetime.fromisoformat(fillup_time.replace("Z", "+00:00"))

        # Get vehicle info if available
        vehicle = await find_one_with_retry(
            vehicles_collection, {"imei": fillup_data.imei}
        )
        vin = vehicle.get("vin") if vehicle else None

        # Get previous fill-up to calculate MPG
        previous_fillup = await find_one_with_retry(
            gas_fillups_collection,
            {"imei": fillup_data.imei, "fillup_time": {"$lt": fillup_time}},
            sort=[("fillup_time", -1)],
        )

        # Calculate MPG if we have odometer readings
        calculated_mpg = None
        miles_since_last = None
        previous_odometer = None

        if fillup_data.odometer and previous_fillup:
            previous_odometer = previous_fillup.get("odometer")
            if previous_odometer:
                miles_since_last = fillup_data.odometer - previous_odometer
                if miles_since_last > 0 and fillup_data.gallons > 0:
                    calculated_mpg = miles_since_last / fillup_data.gallons

        # Calculate total cost if not provided
        total_cost = fillup_data.total_cost
        if not total_cost and fillup_data.price_per_gallon and fillup_data.gallons:
            total_cost = fillup_data.price_per_gallon * fillup_data.gallons

        # Create fill-up document
        fillup_doc = {
            "imei": fillup_data.imei,
            "vin": vin,
            "fillup_time": fillup_time,
            "gallons": fillup_data.gallons,
            "price_per_gallon": fillup_data.price_per_gallon,
            "total_cost": total_cost,
            "odometer": fillup_data.odometer,
            "latitude": fillup_data.latitude,
            "longitude": fillup_data.longitude,
            "is_full_tank": fillup_data.is_full_tank,
            "notes": fillup_data.notes,
            "previous_odometer": previous_odometer,
            "miles_since_last_fillup": miles_since_last,
            "calculated_mpg": calculated_mpg,
            "detected_automatically": False,
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
        }

        result = await insert_one_with_retry(gas_fillups_collection, fillup_doc)
        fillup_doc["_id"] = result.inserted_id

        return serialize_document(fillup_doc)

    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating gas fillup: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/gas-fillups/{fillup_id}")
async def update_gas_fillup(
    fillup_id: str, fillup_data: GasFillupCreateModel
) -> dict[str, Any]:
    """Update a gas fill-up record."""
    try:
        if not ObjectId.is_valid(fillup_id):
            raise HTTPException(status_code=400, detail="Invalid fillup ID")

        # Check if fillup exists
        existing = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )
        if not existing:
            raise HTTPException(status_code=404, detail="Fill-up not found")

        # Update document
        update_data = fillup_data.model_dump(exclude_none=True)
        update_data["updated_at"] = datetime.now(UTC)

        # Recalculate MPG and total cost if needed
        if "gallons" in update_data or "odometer" in update_data:
            # Get previous fill-up
            previous_fillup = await find_one_with_retry(
                gas_fillups_collection,
                {
                    "imei": fillup_data.imei,
                    "fillup_time": {"$lt": existing["fillup_time"]},
                },
                sort=[("fillup_time", -1)],
            )

            if previous_fillup and update_data.get("odometer"):
                previous_odometer = previous_fillup.get("odometer")
                if previous_odometer:
                    miles_since_last = update_data["odometer"] - previous_odometer
                    if miles_since_last > 0 and update_data.get("gallons", 0) > 0:
                        update_data["calculated_mpg"] = (
                            miles_since_last / update_data["gallons"]
                        )
                        update_data["miles_since_last_fillup"] = miles_since_last

        if update_data.get("price_per_gallon") and update_data.get("gallons"):
            update_data["total_cost"] = (
                update_data["price_per_gallon"] * update_data["gallons"]
            )

        await update_one_with_retry(
            gas_fillups_collection,
            {"_id": ObjectId(fillup_id)},
            {"$set": update_data},
        )

        # Fetch and return updated fill-up
        updated = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )
        return serialize_document(updated)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating gas fillup: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/gas-fillups/{fillup_id}")
async def delete_gas_fillup(fillup_id: str) -> dict[str, str]:
    """Delete a gas fill-up record."""
    try:
        if not ObjectId.is_valid(fillup_id):
            raise HTTPException(status_code=400, detail="Invalid fillup ID")

        result = await delete_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )

        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Fill-up not found")

        return {"status": "success", "message": "Fill-up deleted"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting gas fillup: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# === Vehicle Location and Odometer Lookup ===


@router.get("/api/vehicle-location")
async def get_vehicle_location_at_time(
    imei: str = Query(..., description="Vehicle IMEI"),
    timestamp: str = Query(..., description="ISO datetime to lookup"),
    use_now: bool = Query(
        False, description="Use last known location instead of timestamp"
    ),
) -> dict[str, Any]:
    """Get vehicle location and odometer at a specific time."""
    try:
        if use_now:
            # Get the most recent trip for this vehicle
            trip = await find_one_with_retry(
                trips_collection,
                {"imei": imei},
                sort=[("endTime", -1)],
            )
        else:
            # Parse timestamp
            target_time = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))

            # Find the trip closest to this timestamp
            # First, try to find a trip that contains this timestamp
            trip = await find_one_with_retry(
                trips_collection,
                {
                    "imei": imei,
                    "startTime": {"$lte": target_time},
                    "endTime": {"$gte": target_time},
                },
            )

            # If no trip contains the timestamp, find the closest trip before it
            if not trip:
                trip = await find_one_with_retry(
                    trips_collection,
                    {"imei": imei, "endTime": {"$lte": target_time}},
                    sort=[("endTime", -1)],
                )

            # If still no trip, find the closest trip after it
            if not trip:
                trip = await find_one_with_retry(
                    trips_collection,
                    {"imei": imei, "startTime": {"$gte": target_time}},
                    sort=[("startTime", 1)],
                )

        if not trip:
            raise HTTPException(
                status_code=404, detail="No trip data found for this vehicle"
            )

        # Extract location from the end of the trip (or interpolate if needed)
        location_data = {
            "latitude": None,
            "longitude": None,
            "odometer": trip.get("endOdometer"),
            "timestamp": trip.get("endTime"),
            "address": trip.get("destination", {}).get("formatted_address"),
        }

        # Try to get coordinates from various sources
        if trip.get("gps"):
            # Get the last coordinate from GPS data
            gps = trip["gps"]
            if isinstance(gps, dict) and gps.get("type") == "FeatureCollection":
                features = gps.get("features", [])
                if features and features[0].get("geometry", {}).get("coordinates"):
                    coords = features[0]["geometry"]["coordinates"]
                    if coords:
                        # Get last coordinate [lon, lat]
                        last_coord = coords[-1]
                        location_data["longitude"] = last_coord[0]
                        location_data["latitude"] = last_coord[1]

        # Fallback to destinationGeoPoint if available
        if not location_data["latitude"] and trip.get("destinationGeoPoint"):
            geo_point = trip["destinationGeoPoint"]
            if geo_point.get("coordinates"):
                location_data["longitude"] = geo_point["coordinates"][0]
                location_data["latitude"] = geo_point["coordinates"][1]

        return serialize_document(location_data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting vehicle location: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# === Gas Statistics Endpoints ===


@router.get("/api/gas-statistics")
async def get_gas_statistics(
    imei: str | None = Query(None, description="Filter by vehicle IMEI"),
    start_date: str | None = Query(None, description="Start date filter"),
    end_date: str | None = Query(None, description="End date filter"),
) -> dict[str, Any]:
    """Get gas consumption statistics."""
    try:
        match_stage: dict[str, Any] = {}

        if imei:
            match_stage["imei"] = imei

        # Date filtering
        if start_date or end_date:
            date_query: dict[str, Any] = {}
            if start_date:
                date_query["$gte"] = datetime.fromisoformat(
                    start_date.replace("Z", "+00:00")
                )
            if end_date:
                date_query["$lte"] = datetime.fromisoformat(
                    end_date.replace("Z", "+00:00")
                )
            match_stage["fillup_time"] = date_query

        pipeline: list[dict[str, Any]] = []
        if match_stage:
            pipeline.append({"$match": match_stage})

        pipeline.extend(
            [
                {
                    "$group": {
                        "_id": "$imei" if not imei else None,
                        "total_fillups": {"$sum": 1},
                        "total_gallons": {"$sum": "$gallons"},
                        "total_cost": {"$sum": "$total_cost"},
                        "average_mpg": {"$avg": "$calculated_mpg"},
                        "average_price_per_gallon": {"$avg": "$price_per_gallon"},
                        "min_date": {"$min": "$fillup_time"},
                        "max_date": {"$max": "$fillup_time"},
                    }
                },
                {
                    "$project": {
                        "imei": "$_id",
                        "total_fillups": 1,
                        "total_gallons": {"$round": ["$total_gallons", 2]},
                        "total_cost": {"$round": ["$total_cost", 2]},
                        "average_mpg": {"$round": ["$average_mpg", 2]},
                        "average_price_per_gallon": {
                            "$round": ["$average_price_per_gallon", 2]
                        },
                        "period_start": "$min_date",
                        "period_end": "$max_date",
                    }
                },
            ]
        )

        results = await aggregate_with_retry(gas_fillups_collection, pipeline)

        if not results:
            return {
                "imei": imei,
                "total_fillups": 0,
                "total_gallons": 0,
                "total_cost": 0,
                "average_mpg": None,
                "average_price_per_gallon": None,
                "cost_per_mile": None,
                "period_start": start_date,
                "period_end": end_date,
            }

        stats = results[0]

        # Calculate cost per mile if we have MPG
        if stats.get("average_mpg") and stats["average_mpg"] > 0:
            avg_price = stats.get("average_price_per_gallon", 0)
            stats["cost_per_mile"] = round(avg_price / stats["average_mpg"], 3)
        else:
            stats["cost_per_mile"] = None

        return serialize_document(stats)

    except Exception as e:
        logger.error(f"Error calculating gas statistics: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/vehicles/sync-from-trips")
async def sync_vehicles_from_trips() -> dict[str, Any]:
    """Sync vehicles from trip data - creates vehicle records with VIN info from trips."""
    try:
        # Get unique vehicles from trips
        pipeline = [
            {
                "$group": {
                    "_id": "$imei",
                    "vin": {"$first": "$vin"},
                    "latest_trip": {"$max": "$endTime"},
                }
            },
            {"$match": {"_id": {"$ne": None}}},
        ]

        trip_vehicles = await aggregate_with_retry(trips_collection, pipeline)

        synced_count = 0
        updated_count = 0

        for tv in trip_vehicles:
            imei = tv["_id"]
            vin = tv.get("vin")

            if not imei:
                continue

            # Check if vehicle exists
            existing = await find_one_with_retry(vehicles_collection, {"imei": imei})

            if existing:
                # Update VIN if we have it and it's not set
                if vin and not existing.get("vin"):
                    await update_one_with_retry(
                        vehicles_collection,
                        {"imei": imei},
                        {
                            "$set": {
                                "vin": vin,
                                "updated_at": datetime.now(UTC),
                            }
                        },
                    )
                    updated_count += 1
            else:
                # Create new vehicle
                vehicle_doc = {
                    "imei": imei,
                    "vin": vin,
                    "custom_name": None,
                    "is_active": True,
                    "created_at": datetime.now(UTC),
                    "updated_at": datetime.now(UTC),
                }
                await insert_one_with_retry(vehicles_collection, vehicle_doc)
                synced_count += 1

        return {
            "status": "success",
            "synced": synced_count,
            "updated": updated_count,
            "total_vehicles": len(trip_vehicles),
        }

    except Exception as e:
        logger.error(f"Error syncing vehicles: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/trip-gas-cost")
async def calculate_trip_gas_cost(
    trip_id: str = Query(..., description="Trip transaction ID or ObjectId"),
    imei: str | None = Query(None, description="Vehicle IMEI"),
) -> dict[str, Any]:
    """Calculate the gas cost for a specific trip based on latest fill-up prices."""
    try:
        # Get the trip
        trip = None
        if ObjectId.is_valid(trip_id):
            trip = await find_one_with_retry(
                trips_collection, {"_id": ObjectId(trip_id)}
            )
        if not trip:
            trip = await find_one_with_retry(
                trips_collection, {"transactionId": trip_id}
            )
        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")

        trip_imei = imei or trip.get("imei")
        if not trip_imei:
            raise HTTPException(status_code=400, detail="Cannot determine vehicle IMEI")

        # Get the most recent fill-up before or during this trip
        fillup = await find_one_with_retry(
            gas_fillups_collection,
            {
                "imei": trip_imei,
                "fillup_time": {"$lte": trip.get("endTime")},
            },
            sort=[("fillup_time", -1)],
        )

        if not fillup:
            # No fill-up data, use a default or return null
            return {
                "trip_id": trip_id,
                "distance": trip.get("distance", 0),
                "estimated_cost": None,
                "message": "No fill-up data available",
            }

        # Calculate cost based on fuel consumed or estimated MPG
        fuel_consumed = trip.get("fuelConsumed")
        price_per_gallon = fillup.get("price_per_gallon")

        if fuel_consumed and price_per_gallon:
            estimated_cost = fuel_consumed * price_per_gallon
        elif fillup.get("calculated_mpg") and price_per_gallon:
            # Estimate based on distance and MPG
            distance = trip.get("distance", 0)
            mpg = fillup["calculated_mpg"]
            estimated_gallons = distance / mpg if mpg > 0 else 0
            estimated_cost = estimated_gallons * price_per_gallon
        else:
            estimated_cost = None

        return {
            "trip_id": trip_id,
            "distance": trip.get("distance", 0),
            "fuel_consumed": fuel_consumed,
            "price_per_gallon": price_per_gallon,
            "estimated_cost": round(estimated_cost, 2) if estimated_cost else None,
            "mpg_used": fillup.get("calculated_mpg"),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error calculating trip gas cost: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
