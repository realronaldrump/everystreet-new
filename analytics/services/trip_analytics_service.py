"""Business logic for trip analytics and aggregations."""

import logging
from typing import Any

from core.trip_source_policy import enforce_bouncie_source
from db.aggregation import aggregate_to_list
from db.aggregation_utils import (
    build_driver_behavior_fields_stage,
    build_trip_time_group_id,
    get_mongo_tz_expr,
)
from db.models import Trip

logger = logging.getLogger(__name__)
# trips_collection removed, use Trip model directly


class TripAnalyticsService:
    """Service class for trip analytics operations."""

    @staticmethod
    async def get_trip_analytics(query: dict[str, Any]) -> dict[str, Any]:
        """
        Get analytics on trips over time.

        Args:
            query: MongoDB query filter

        Returns:
            Dictionary containing daily distances, time distribution, and weekday distribution
        """
        query = enforce_bouncie_source(query)
        tz_expr = get_mongo_tz_expr()

        pipeline = [
            {"$match": query},
            {
                "$group": {
                    "_id": build_trip_time_group_id(
                        date_field="startTime",
                        tz_expr=tz_expr,
                    ),
                    "totalDistance": {"$sum": "$distance"},
                    "tripCount": {"$sum": 1},
                },
            },
        ]

        results = await aggregate_to_list(Trip, pipeline)

        # Organize data by different dimensions
        daily_list = TripAnalyticsService._organize_daily_data(results)
        hourly_list = TripAnalyticsService._organize_hourly_data(results)
        weekday_list = TripAnalyticsService._organize_weekday_data(results)
        time_heatmap = TripAnalyticsService._organize_time_heatmap_data(results)

        return {
            "daily_distances": daily_list,
            "time_distribution": hourly_list,
            "weekday_distribution": weekday_list,
            "time_heatmap": time_heatmap,
        }

    @staticmethod
    def _organize_daily_data(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Organize results into daily aggregates.

        Args:
            results: Raw aggregation results

        Returns:
            List of daily distance and count data
        """
        daily_data = {}
        for r in results:
            date_key = r["_id"]["date"]
            if date_key not in daily_data:
                daily_data[date_key] = {"distance": 0, "count": 0}
            daily_data[date_key]["distance"] += r["totalDistance"]
            daily_data[date_key]["count"] += r["tripCount"]
        return [
            {"date": d, "distance": v["distance"], "count": v["count"]}
            for d, v in sorted(daily_data.items())
        ]

    @staticmethod
    def _organize_hourly_data(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Organize results into hourly aggregates.

        Args:
            results: Raw aggregation results

        Returns:
            List of hourly trip counts
        """
        hourly_data = {}
        for r in results:
            hr = r["_id"]["hour"]
            if hr not in hourly_data:
                hourly_data[hr] = 0
            hourly_data[hr] += r["tripCount"]
        return [{"hour": h, "count": c} for h, c in sorted(hourly_data.items())]

    @staticmethod
    def _organize_weekday_data(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Organize data by day of week (MongoDB returns 1=Sunday, 7=Saturday).

        Args:
            results: Raw aggregation results

        Returns:
            List of weekday trip counts
        """
        weekday_data = {}
        for r in results:
            day_of_week = r["_id"]["dayOfWeek"] - 1
            if day_of_week not in weekday_data:
                weekday_data[day_of_week] = 0
            weekday_data[day_of_week] += r["tripCount"]
        return [{"day": d, "count": c} for d, c in sorted(weekday_data.items())]

    @staticmethod
    def _organize_time_heatmap_data(
        results: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """
        Organize trip starts into a complete weekday-by-hour grid.

        Day values use the frontend convention: 0=Sunday, 6=Saturday.
        """
        cells: dict[tuple[int, int], dict[str, float | int]] = {
            (day, hour): {"count": 0, "distance": 0.0}
            for day in range(7)
            for hour in range(24)
        }

        for row in results:
            group_id = row.get("_id") or {}
            hour = int(group_id.get("hour", 0))
            day = int(group_id.get("dayOfWeek", 1)) - 1
            if not (0 <= day <= 6 and 0 <= hour <= 23):
                continue

            cell = cells[(day, hour)]
            cell["count"] = int(cell["count"]) + int(row.get("tripCount") or 0)
            cell["distance"] = float(cell["distance"]) + float(
                row.get("totalDistance") or 0,
            )

        return [
            {
                "day": day,
                "hour": hour,
                "count": int(values["count"]),
                "distance": float(values["distance"]),
            }
            for day in range(7)
            for hour in range(24)
            if (values := cells[(day, hour)])
        ]

    @staticmethod
    async def get_driver_behavior_analytics(query: dict[str, Any]) -> dict[str, Any]:
        """
        Aggregate driving behavior statistics within optional date range filters.

        Args:
            query: MongoDB query filter

        Returns:
            Dictionary containing totals, weekly, and monthly driving behavior statistics
        """
        query = enforce_bouncie_source(query)
        tz_expr = get_mongo_tz_expr()

        pipeline = [
            {"$match": query},
            build_driver_behavior_fields_stage(tz_expr),
            {
                "$facet": {
                    "totals": [
                        {
                            "$group": {
                                "_id": None,
                                "totalTrips": {"$sum": 1},
                                "totalDistance": {"$sum": "$numericDistance"},
                                "speedSum": {
                                    "$sum": {
                                        "$cond": [
                                            {"$ne": ["$speedValue", None]},
                                            "$speedValue",
                                            0,
                                        ],
                                    },
                                },
                                "speedCount": {
                                    "$sum": {
                                        "$cond": [{"$ne": ["$speedValue", None]}, 1, 0],
                                    },
                                },
                                "maxSpeed": {"$max": "$numericMaxSpeed"},
                                "hardBrakingCounts": {"$sum": "$hardBrakingVal"},
                                "hardAccelerationCounts": {"$sum": "$hardAccelVal"},
                                "totalIdleDuration": {"$sum": "$idleSeconds"},
                                "fuelConsumed": {"$sum": "$fuelDouble"},
                            },
                        },
                        {
                            "$project": {
                                "_id": 0,
                                "totalTrips": 1,
                                "totalDistance": 1,
                                "avgSpeed": {
                                    "$cond": [
                                        {"$gt": ["$speedCount", 0]},
                                        {"$divide": ["$speedSum", "$speedCount"]},
                                        0,
                                    ],
                                },
                                "maxSpeed": 1,
                                "hardBrakingCounts": 1,
                                "hardAccelerationCounts": 1,
                                "totalIdleDuration": 1,
                                "fuelConsumed": 1,
                            },
                        },
                    ],
                    "weekly": [
                        {
                            "$group": {
                                "_id": {
                                    "wy": "$dtParts.isoWeekYear",
                                    "wk": "$dtParts.isoWeek",
                                },
                                "trips": {"$sum": 1},
                                "distance": {"$sum": "$numericDistance"},
                                "hardBraking": {"$sum": "$hardBrakingVal"},
                                "hardAccel": {"$sum": "$hardAccelVal"},
                            },
                        },
                        {"$sort": {"_id.wy": 1, "_id.wk": 1}},
                        {
                            "$project": {
                                "_id": 0,
                                "week": {
                                    "$concat": [
                                        {"$toString": "$_id.wy"},
                                        "-W",
                                        {"$cond": [{"$lt": ["$_id.wk", 10]}, "0", ""]},
                                        {"$toString": "$_id.wk"},
                                    ],
                                },
                                "trips": 1,
                                "distance": 1,
                                "hardBraking": 1,
                                "hardAccel": 1,
                            },
                        },
                    ],
                    "monthly": [
                        {
                            "$group": {
                                "_id": {"y": "$dtParts.year", "m": "$dtParts.month"},
                                "trips": {"$sum": 1},
                                "distance": {"$sum": "$numericDistance"},
                                "hardBraking": {"$sum": "$hardBrakingVal"},
                                "hardAccel": {"$sum": "$hardAccelVal"},
                            },
                        },
                        {"$sort": {"_id.y": 1, "_id.m": 1}},
                        {
                            "$project": {
                                "_id": 0,
                                "month": {
                                    "$concat": [
                                        {"$toString": "$_id.y"},
                                        "-",
                                        {"$cond": [{"$lt": ["$_id.m", 10]}, "0", ""]},
                                        {"$toString": "$_id.m"},
                                    ],
                                },
                                "trips": 1,
                                "distance": 1,
                                "hardBraking": 1,
                                "hardAccel": 1,
                            },
                        },
                    ],
                },
            },
            {
                "$project": {
                    "totals": {
                        "$ifNull": [
                            {"$arrayElemAt": ["$totals", 0]},
                            {
                                "totalTrips": 0,
                                "totalDistance": 0.0,
                                "avgSpeed": 0.0,
                                "maxSpeed": 0.0,
                                "hardBrakingCounts": 0,
                                "hardAccelerationCounts": 0,
                                "totalIdleDuration": 0.0,
                                "fuelConsumed": 0.0,
                            },
                        ],
                    },
                    "weekly": 1,
                    "monthly": 1,
                },
            },
            {
                "$project": {
                    "totalTrips": "$totals.totalTrips",
                    "totalDistance": {"$round": ["$totals.totalDistance", 2]},
                    "avgSpeed": {"$round": ["$totals.avgSpeed", 2]},
                    "maxSpeed": {"$round": ["$totals.maxSpeed", 2]},
                    "hardBrakingCounts": "$totals.hardBrakingCounts",
                    "hardAccelerationCounts": "$totals.hardAccelerationCounts",
                    "totalIdleDuration": {"$round": ["$totals.totalIdleDuration", 2]},
                    "fuelConsumed": {"$round": ["$totals.fuelConsumed", 2]},
                    "weekly": 1,
                    "monthly": 1,
                },
            },
        ]

        results = await aggregate_to_list(Trip, pipeline)
        if not results:
            return {
                "totalTrips": 0,
                "totalDistance": 0,
                "avgSpeed": 0,
                "maxSpeed": 0,
                "hardBrakingCounts": 0,
                "hardAccelerationCounts": 0,
                "totalIdleDuration": 0,
                "fuelConsumed": 0,
                "weekly": [],
                "monthly": [],
            }

        return results[0]
