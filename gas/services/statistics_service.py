"""Service for gas consumption statistics and vehicle synchronization."""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId

from db import (aggregate_with_retry, find_one_with_retry,
                gas_fillups_collection, insert_one_with_retry,
                trips_collection, update_one_with_retry, vehicles_collection)
from gas.serializers import parse_iso_datetime

logger = logging.getLogger(__name__)


class StatisticsService:
    """Service class for gas statistics and vehicle operations."""

    @staticmethod
    async def get_gas_statistics(
        imei: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any]:
        """Get gas consumption statistics.

        Args:
            imei: Optional IMEI filter
            start_date: Optional start date ISO string
            end_date: Optional end date ISO string

        Returns:
            Statistics dict with totals and averages
        """
        match_stage: dict[str, Any] = {}

        if imei:
            match_stage["imei"] = imei

        # Date filtering
        if start_date or end_date:
            date_query: dict[str, Any] = {}
            if start_date:
                date_query["$gte"] = parse_iso_datetime(start_date)
            if end_date:
                date_query["$lte"] = parse_iso_datetime(end_date)
            match_stage["fillup_time"] = date_query

        pipeline: list[dict[str, Any]] = []
        if match_stage:
            pipeline.append({"$match": match_stage})

        pipeline.extend(
            [
                {
                    "$group": {
                        "_id": None,
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

        return stats

    @staticmethod
    async def sync_vehicles_from_trips() -> dict[str, Any]:
        """Sync vehicles from trip data.

        Creates vehicle records with VIN info from trips for any vehicles
        that don't already exist.

        Returns:
            Dict with sync stats (synced count, updated count, total)
        """
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

        # Get all existing vehicles to memory to avoid N+1 queries
        existing_vehicles = await vehicles_collection.find().to_list(None)
        existing_map = {v["imei"]: v for v in existing_vehicles}

        for tv in trip_vehicles:
            imei = tv["_id"]
            vin = tv.get("vin")

            if not imei:
                continue

            existing = existing_map.get(imei)

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

        logger.info(
            "Vehicle sync complete: %d new, %d updated", synced_count, updated_count
        )

        return {
            "status": "success",
            "synced": synced_count,
            "updated": updated_count,
            "total_vehicles": len(trip_vehicles),
        }

    @staticmethod
    async def calculate_trip_gas_cost(
        trip_id: str, imei: str | None = None
    ) -> dict[str, Any]:
        """Calculate the gas cost for a specific trip based on latest fill-up prices.

        Args:
            trip_id: Trip transaction ID or ObjectId
            imei: Optional vehicle IMEI

        Returns:
            Dict with trip gas cost details

        Raises:
            ValueError: If trip not found or IMEI cannot be determined
        """
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
            raise ValueError("Trip not found")

        trip_imei = imei or trip.get("imei")
        if not trip_imei:
            raise ValueError("Cannot determine vehicle IMEI")

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
            # No fill-up data available
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
