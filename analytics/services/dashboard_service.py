"""Business logic for dashboard data aggregation and insights."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import pytz

from core.math_utils import calculate_circular_average_hour
from db.aggregation import aggregate_to_list
from db.models import Trip

logger = logging.getLogger(__name__)


class DashboardService:
    """Service class for dashboard and insights operations."""

    @staticmethod
    async def get_driving_insights(query: dict[str, Any]) -> dict[str, Any]:
        """
        Get aggregated driving insights.

        Args:
            query: MongoDB query filter

        Returns:
            Dictionary containing driving insights and top destinations
        """
        # Main aggregation pipeline
        pipeline = [
            {"$match": query},
            {
                "$group": {
                    "_id": None,
                    "total_trips": {"$sum": 1},
                    "total_distance": {
                        "$sum": {
                            "$ifNull": [
                                "$distance",
                                0,
                            ],
                        },
                    },
                    "total_fuel_consumed": {
                        "$sum": {
                            "$ifNull": [
                                "$fuelConsumed",
                                0,
                            ],
                        },
                    },
                    "max_speed": {
                        "$max": {
                            "$ifNull": [
                                "$maxSpeed",
                                0,
                            ],
                        },
                    },
                    "total_idle_duration": {
                        "$sum": {
                            "$ifNull": [
                                "$totalIdleDuration",
                                {"$ifNull": ["$totalIdlingTime", 0]},
                            ],
                        },
                    },
                    "longest_trip_distance": {
                        "$max": {
                            "$ifNull": [
                                "$distance",
                                0,
                            ],
                        },
                    },
                },
            },
        ]

        # Use aggregation helper
        trips_result = await aggregate_to_list(Trip, pipeline)

        # Top destinations (up to 5) with basic stats
        pipeline_top_destinations = [
            {"$match": query},
            {
                "$addFields": {
                    "duration_seconds": {
                        "$cond": {
                            "if": {
                                "$and": [
                                    {"$ifNull": ["$startTime", None]},
                                    {"$ifNull": ["$endTime", None]},
                                    {"$lt": ["$startTime", "$endTime"]},
                                ],
                            },
                            "then": {
                                "$divide": [
                                    {"$subtract": ["$endTime", "$startTime"]},
                                    1000,
                                ],
                            },
                            "else": 0.0,
                        },
                    },
                },
            },
            {
                "$group": {
                    "_id": "$destination",
                    "visits": {"$sum": 1},
                    "distance": {"$sum": {"$ifNull": ["$distance", 0]}},
                    "total_duration": {"$sum": "$duration_seconds"},
                    "last_visit": {"$max": "$endTime"},
                    "isCustomPlace": {"$first": "$isCustomPlace"},
                },
            },
            {"$sort": {"visits": -1}},
            {"$limit": 5},
        ]

        trips_top = await aggregate_to_list(Trip, pipeline_top_destinations)

        # Build response
        combined = {
            "total_trips": 0,
            "total_distance": 0.0,
            "total_fuel_consumed": 0.0,
            "max_speed": 0.0,
            "total_idle_duration": 0,
            "longest_trip_distance": 0.0,
            "most_visited": {},
            "top_destinations": [],
        }

        if trips_result and trips_result[0]:
            r = trips_result[0]
            combined["total_trips"] = r.get("total_trips", 0)
            combined["total_distance"] = r.get("total_distance", 0)
            combined["total_fuel_consumed"] = r.get("total_fuel_consumed", 0)
            combined["max_speed"] = r.get("max_speed", 0)
            combined["total_idle_duration"] = r.get("total_idle_duration", 0)
            combined["longest_trip_distance"] = r.get(
                "longest_trip_distance",
                0,
            )

        if trips_top:
            # The first entry is also the "most visited" location
            best = trips_top[0]
            combined["most_visited"] = {
                "_id": best["_id"],
                "count": best["visits"],
                "isCustomPlace": best.get("isCustomPlace", False),
            }

            # Add formatted top destinations list
            combined["top_destinations"] = [
                {
                    "location": (
                        d["_id"].get("formatted_address")
                        if isinstance(d["_id"], dict)
                        else (
                            d["_id"].get("name")
                            if isinstance(d["_id"], dict)
                            else str(d["_id"])
                        )
                    ),
                    "visits": d.get("visits", 0),
                    "distance": round(d.get("distance", 0.0), 2),
                    "duration_seconds": round(d.get("total_duration", 0.0), 0),
                    "lastVisit": d.get("last_visit"),
                    "isCustomPlace": d.get("isCustomPlace", False),
                }
                for d in trips_top
            ]

        return combined

    @staticmethod
    async def get_metrics(query: dict[str, Any]) -> dict[str, Any]:
        """
        Get trip metrics and statistics using database aggregation.

        Args:
            query: MongoDB query filter

        Returns:
            Dictionary containing trip metrics including totals, averages, and statistics
        """
        target_timezone_str = "America/Chicago"
        target_tz = pytz.timezone(target_timezone_str)

        pipeline = [
            {"$match": query},
            {
                "$addFields": {
                    "numericDistance": {
                        "$ifNull": [
                            {"$toDouble": "$distance"},
                            0.0,
                        ],
                    },
                    "numericMaxSpeed": {
                        "$ifNull": [
                            {"$toDouble": "$maxSpeed"},
                            0.0,
                        ],
                    },
                    "duration_seconds": {
                        "$cond": {
                            "if": {
                                "$and": [
                                    {
                                        "$ifNull": [
                                            "$startTime",
                                            None,
                                        ],
                                    },
                                    {
                                        "$ifNull": [
                                            "$endTime",
                                            None,
                                        ],
                                    },
                                    {
                                        "$lt": [
                                            "$startTime",
                                            "$endTime",
                                        ],
                                    },
                                ],
                            },
                            "then": {
                                "$divide": [
                                    {
                                        "$subtract": [
                                            "$endTime",
                                            "$startTime",
                                        ],
                                    },
                                    1000,
                                ],
                            },
                            "else": 0.0,
                        },
                    },
                    "startHourUTC": {
                        "$hour": {
                            "date": "$startTime",
                            "timezone": "UTC",
                        },
                    },
                },
            },
            {
                "$group": {
                    "_id": None,
                    "total_trips": {"$sum": 1},
                    "total_distance": {"$sum": "$numericDistance"},
                    "max_speed": {"$max": "$numericMaxSpeed"},
                    "total_duration_seconds": {"$sum": "$duration_seconds"},
                    "start_hours_utc": {"$push": "$startHourUTC"},
                },
            },
            {
                "$project": {
                    "_id": 0,
                    "total_trips": 1,
                    "total_distance": {
                        "$ifNull": [
                            "$total_distance",
                            0.0,
                        ],
                    },
                    "max_speed": {
                        "$ifNull": [
                            "$max_speed",
                            0.0,
                        ],
                    },
                    "total_duration_seconds": {
                        "$ifNull": [
                            "$total_duration_seconds",
                            0.0,
                        ],
                    },
                    "start_hours_utc": {
                        "$ifNull": [
                            "$start_hours_utc",
                            [],
                        ],
                    },
                    "avg_distance": {
                        "$cond": {
                            "if": {
                                "$gt": [
                                    "$total_trips",
                                    0,
                                ],
                            },
                            "then": {
                                "$divide": [
                                    "$total_distance",
                                    "$total_trips",
                                ],
                            },
                            "else": 0.0,
                        },
                    },
                    "avg_speed": {
                        "$cond": {
                            "if": {
                                "$gt": [
                                    "$total_duration_seconds",
                                    0,
                                ],
                            },
                            "then": {
                                "$divide": [
                                    "$total_distance",
                                    {
                                        "$divide": [
                                            "$total_duration_seconds",
                                            3600.0,
                                        ],
                                    },
                                ],
                            },
                            "else": 0.0,
                        },
                    },
                },
            },
        ]

        results = await aggregate_to_list(Trip, pipeline)

        if not results:
            return {
                "total_trips": 0,
                "total_distance": "0.00",
                "avg_distance": "0.00",
                "avg_start_time": "00:00 AM",
                "avg_driving_time": "00:00",
                "avg_speed": "0.00",
                "max_speed": "0.00",
            }

        metrics = results[0]
        total_trips = metrics.get("total_trips", 0)

        # Calculate average start time
        start_hours_utc_list = metrics.get("start_hours_utc", [])
        avg_start_time_str = "00:00 AM"
        if start_hours_utc_list:
            avg_hour_utc_float = calculate_circular_average_hour(
                start_hours_utc_list,
            )

            base_date = datetime.now(UTC).replace(
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )
            avg_utc_dt = base_date + timedelta(hours=avg_hour_utc_float)

            avg_local_dt = avg_utc_dt.astimezone(target_tz)

            local_hour = avg_local_dt.hour
            local_minute = avg_local_dt.minute

            am_pm = "AM" if local_hour < 12 else "PM"
            display_hour = local_hour % 12
            if display_hour == 0:
                display_hour = 12

            avg_start_time_str = f"{display_hour:02d}:{local_minute:02d} {am_pm}"

        # Calculate average driving time
        avg_driving_time_str = "00:00"
        if total_trips > 0:
            total_duration_seconds = metrics.get("total_duration_seconds", 0.0)
            avg_duration_seconds = total_duration_seconds / total_trips
            avg_driving_h = int(avg_duration_seconds // 3600)
            avg_driving_m = int((avg_duration_seconds % 3600) // 60)
            avg_driving_time_str = f"{avg_driving_h:02d}:{avg_driving_m:02d}"

        return {
            "total_trips": total_trips,
            "total_distance": f"{round(metrics.get('total_distance', 0.0), 2)}",
            "avg_distance": f"{round(metrics.get('avg_distance', 0.0), 2)}",
            "avg_start_time": avg_start_time_str,
            "avg_driving_time": avg_driving_time_str,
            "avg_speed": f"{round(metrics.get('avg_speed', 0.0), 2)}",
            "max_speed": f"{round(metrics.get('max_speed', 0.0), 2)}",
            "total_duration_seconds": round(
                metrics.get("total_duration_seconds", 0.0),
                0,
            ),
        }
