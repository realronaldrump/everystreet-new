"""Service for gas consumption statistics and vehicle synchronization."""

import logging
from datetime import UTC, datetime
from typing import Any

from core.date_utils import parse_timestamp
from db.aggregation import aggregate_to_list
from db.models import GasFillup, Trip, Vehicle

logger = logging.getLogger(__name__)


class StatisticsService:
    """Service class for gas statistics and vehicle operations."""

    @staticmethod
    async def get_gas_statistics(
        imei: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any]:
        """
        Get gas consumption statistics.

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
                date_query["$gte"] = parse_timestamp(start_date)
            if end_date:
                date_query["$lte"] = parse_timestamp(end_date)
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
                    },
                },
                {
                    "$project": {
                        "imei": "$_id",
                        "total_fillups": 1,
                        "total_gallons": {"$round": ["$total_gallons", 2]},
                        "total_cost": {"$round": ["$total_cost", 2]},
                        "average_mpg": {"$round": ["$average_mpg", 2]},
                        "average_price_per_gallon": {
                            "$round": ["$average_price_per_gallon", 2],
                        },
                        "period_start": "$min_date",
                        "period_end": "$max_date",
                    },
                },
            ],
        )

        results = await aggregate_to_list(GasFillup, pipeline)

        record_pipeline: list[dict[str, Any]] = []
        if match_stage:
            record_pipeline.append({"$match": match_stage})
        record_pipeline.extend(
            [
                {
                    "$addFields": {
                        "numeric_mpg": {
                            "$convert": {
                                "input": "$calculated_mpg",
                                "to": "double",
                                "onError": 0.0,
                                "onNull": 0.0,
                            },
                        },
                        "numeric_price": {
                            "$convert": {
                                "input": "$price_per_gallon",
                                "to": "double",
                                "onError": 0.0,
                                "onNull": 0.0,
                            },
                        },
                    },
                },
                {
                    "$facet": {
                        "best_mpg": [
                            {"$match": {"numeric_mpg": {"$gt": 0}}},
                            {
                                "$sort": {
                                    "numeric_mpg": -1,
                                    "fillup_time": -1,
                                },
                            },
                            {"$limit": 1},
                            {
                                "$project": {
                                    "_id": 0,
                                    "mpg": "$numeric_mpg",
                                    "fillup_time": 1,
                                    "price_per_gallon": "$numeric_price",
                                },
                            },
                        ],
                        "cheapest_price": [
                            {"$match": {"numeric_price": {"$gt": 0}}},
                            {
                                "$sort": {
                                    "numeric_price": 1,
                                    "fillup_time": -1,
                                },
                            },
                            {"$limit": 1},
                            {
                                "$project": {
                                    "_id": 0,
                                    "price_per_gallon": "$numeric_price",
                                    "fillup_time": 1,
                                },
                            },
                        ],
                    },
                },
            ],
        )

        record_results = await aggregate_to_list(GasFillup, record_pipeline)

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
                "records": {},
            }

        stats = results[0]

        # Calculate cost per mile if we have MPG
        if stats.get("average_mpg") and stats["average_mpg"] > 0:
            avg_price = stats.get("average_price_per_gallon", 0)
            stats["cost_per_mile"] = round(avg_price / stats["average_mpg"], 3)
        else:
            stats["cost_per_mile"] = None

        records: dict[str, Any] = {}
        if record_results and record_results[0]:
            record_data = record_results[0]
            best_mpg = record_data.get("best_mpg") or []
            cheapest_price = record_data.get("cheapest_price") or []
            if best_mpg:
                record = best_mpg[0]
                records["best_mpg"] = {
                    "mpg": record.get("mpg", 0.0),
                    "fillup_time": record.get("fillup_time"),
                    "price_per_gallon": record.get("price_per_gallon"),
                }
            if cheapest_price:
                record = cheapest_price[0]
                records["cheapest_price"] = {
                    "price_per_gallon": record.get("price_per_gallon", 0.0),
                    "fillup_time": record.get("fillup_time"),
                }

        stats["records"] = records

        return stats

    @staticmethod
    async def sync_vehicles_from_trips() -> dict[str, Any]:
        """
        Sync vehicles from trip data.

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
                },
            },
            {"$match": {"_id": {"$ne": None}}},
        ]

        trip_vehicles = await aggregate_to_list(Trip, pipeline)

        synced_count = 0
        updated_count = 0

        # Get all existing vehicles to memory to avoid N+1 queries
        existing_vehicles = await Vehicle.find_all().to_list()
        existing_map = {v.imei: v for v in existing_vehicles}

        for tv in trip_vehicles:
            imei = tv["_id"]
            vin = tv.get("vin")

            if not imei:
                continue

            existing = existing_map.get(imei)

            if existing:
                # Update VIN if we have it and it's not set
                if vin and not existing.vin:
                    existing.vin = vin
                    existing.updated_at = datetime.now(UTC)
                    await existing.save()
                    updated_count += 1
            else:
                # Create new vehicle
                vehicle = Vehicle(
                    imei=imei,
                    vin=vin,
                    custom_name=None,
                    is_active=True,
                    created_at=datetime.now(UTC),
                    updated_at=datetime.now(UTC),
                )
                await vehicle.insert()
                synced_count += 1

        logger.info(
            "Vehicle sync complete: %d new, %d updated",
            synced_count,
            updated_count,
        )

        return {
            "status": "success",
            "synced": synced_count,
            "updated": updated_count,
            "total_vehicles": len(trip_vehicles),
        }
