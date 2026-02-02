"""Business logic for dashboard data aggregation and insights."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import pytz

from core.math_utils import calculate_circular_average_hour
from db.aggregation import aggregate_to_list
from db.aggregation_utils import (
    build_trip_duration_fields_stage,
    build_trip_numeric_fields_stage,
    get_mongo_tz_expr,
)
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
                                0,
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

        tz_expr = get_mongo_tz_expr()
        record_pipeline = [
            {"$match": query},
            build_trip_numeric_fields_stage(),
            build_trip_duration_fields_stage(tz_expr),
            {
                "$facet": {
                    "longest_trip": [
                        {"$match": {"numericDistance": {"$gt": 0}}},
                        {"$sort": {"numericDistance": -1, "recorded_at": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "distance": "$numericDistance",
                                "recorded_at": 1,
                            },
                        },
                    ],
                    "longest_duration": [
                        {"$match": {"duration_seconds": {"$gt": 0}}},
                        {"$sort": {"duration_seconds": -1, "recorded_at": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "duration_seconds": 1,
                                "recorded_at": 1,
                            },
                        },
                    ],
                    "max_speed": [
                        {"$match": {"numericMaxSpeed": {"$gt": 0}}},
                        {"$sort": {"numericMaxSpeed": -1, "recorded_at": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "max_speed": "$numericMaxSpeed",
                                "recorded_at": 1,
                            },
                        },
                    ],
                    "avg_speed": [
                        {"$match": {"avgSpeedValue": {"$gt": 0}}},
                        {"$sort": {"avgSpeedValue": -1, "recorded_at": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "avg_speed": "$avgSpeedValue",
                                "recorded_at": 1,
                            },
                        },
                    ],
                    "max_idle": [
                        {"$match": {"idleSeconds": {"$gt": 0}}},
                        {"$sort": {"idleSeconds": -1, "recorded_at": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "idle_seconds": "$idleSeconds",
                                "recorded_at": 1,
                            },
                        },
                    ],
                    "max_hard_braking": [
                        {"$match": {"hardBrakingVal": {"$gt": 0}}},
                        {"$sort": {"hardBrakingVal": -1, "recorded_at": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "hard_braking": "$hardBrakingVal",
                                "recorded_at": 1,
                            },
                        },
                    ],
                    "max_hard_accel": [
                        {"$match": {"hardAccelVal": {"$gt": 0}}},
                        {"$sort": {"hardAccelVal": -1, "recorded_at": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "hard_accel": "$hardAccelVal",
                                "recorded_at": 1,
                            },
                        },
                    ],
                    "max_day_distance": [
                        {"$match": {"day_key": {"$ne": None}}},
                        {
                            "$group": {
                                "_id": "$day_key",
                                "distance": {"$sum": "$numericDistance"},
                                "trips": {"$sum": 1},
                                "duration_seconds": {
                                    "$sum": "$duration_seconds",
                                },
                            },
                        },
                        {"$sort": {"distance": -1, "_id": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "date": "$_id",
                                "distance": 1,
                            },
                        },
                    ],
                    "max_day_trips": [
                        {"$match": {"day_key": {"$ne": None}}},
                        {
                            "$group": {
                                "_id": "$day_key",
                                "distance": {"$sum": "$numericDistance"},
                                "trips": {"$sum": 1},
                                "duration_seconds": {
                                    "$sum": "$duration_seconds",
                                },
                            },
                        },
                        {"$sort": {"trips": -1, "_id": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "date": "$_id",
                                "trips": 1,
                            },
                        },
                    ],
                    "max_day_duration": [
                        {"$match": {"day_key": {"$ne": None}}},
                        {
                            "$group": {
                                "_id": "$day_key",
                                "distance": {"$sum": "$numericDistance"},
                                "trips": {"$sum": 1},
                                "duration_seconds": {
                                    "$sum": "$duration_seconds",
                                },
                            },
                        },
                        {"$sort": {"duration_seconds": -1, "_id": -1}},
                        {"$limit": 1},
                        {
                            "$project": {
                                "_id": 0,
                                "date": "$_id",
                                "duration_seconds": 1,
                            },
                        },
                    ],
                },
            },
        ]

        record_results = await aggregate_to_list(Trip, record_pipeline)

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
            "records": {},
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

        def _format_location(value: Any) -> str:
            if isinstance(value, dict):
                return (
                    value.get("formatted_address")
                    or value.get("name")
                    or value.get("address")
                    or str(value)
                )
            return str(value)

        if trips_top:
            # The first entry is also the "most visited" location
            best = trips_top[0]
            best_location = _format_location(best["_id"])
            combined["most_visited"] = {
                "location": best_location,
                "count": best["visits"],
                "lastVisit": best.get("last_visit"),
                "isCustomPlace": best.get("isCustomPlace", False),
            }

            # Add formatted top destinations list
            combined["top_destinations"] = [
                {
                    "location": _format_location(d["_id"]),
                    "visits": d.get("visits", 0),
                    "distance": round(d.get("distance", 0.0), 2),
                    "duration_seconds": round(d.get("total_duration", 0.0), 0),
                    "lastVisit": d.get("last_visit"),
                    "isCustomPlace": d.get("isCustomPlace", False),
                }
                for d in trips_top
            ]

        if record_results and record_results[0]:
            record_data = record_results[0]

            def _first_record(key: str) -> dict[str, Any] | None:
                entries = record_data.get(key) or []
                return entries[0] if entries else None

            records: dict[str, Any] = {}
            longest_trip = _first_record("longest_trip")
            if longest_trip:
                records["longest_trip"] = {
                    "distance": longest_trip.get("distance", 0.0),
                    "recorded_at": longest_trip.get("recorded_at"),
                }

            longest_duration = _first_record("longest_duration")
            if longest_duration:
                records["longest_duration"] = {
                    "duration_seconds": longest_duration.get("duration_seconds", 0.0),
                    "recorded_at": longest_duration.get("recorded_at"),
                }

            max_speed = _first_record("max_speed")
            if max_speed:
                records["max_speed"] = {
                    "max_speed": max_speed.get("max_speed", 0.0),
                    "recorded_at": max_speed.get("recorded_at"),
                }

            avg_speed = _first_record("avg_speed")
            if avg_speed:
                records["avg_speed"] = {
                    "avg_speed": avg_speed.get("avg_speed", 0.0),
                    "recorded_at": avg_speed.get("recorded_at"),
                }

            max_idle = _first_record("max_idle")
            if max_idle:
                records["max_idle"] = {
                    "idle_seconds": max_idle.get("idle_seconds", 0.0),
                    "recorded_at": max_idle.get("recorded_at"),
                }

            max_braking = _first_record("max_hard_braking")
            if max_braking:
                records["max_hard_braking"] = {
                    "hard_braking": max_braking.get("hard_braking", 0),
                    "recorded_at": max_braking.get("recorded_at"),
                }

            max_accel = _first_record("max_hard_accel")
            if max_accel:
                records["max_hard_accel"] = {
                    "hard_accel": max_accel.get("hard_accel", 0),
                    "recorded_at": max_accel.get("recorded_at"),
                }

            max_day_distance = _first_record("max_day_distance")
            if max_day_distance:
                records["max_day_distance"] = {
                    "date": max_day_distance.get("date"),
                    "distance": max_day_distance.get("distance", 0.0),
                }

            max_day_trips = _first_record("max_day_trips")
            if max_day_trips:
                records["max_day_trips"] = {
                    "date": max_day_trips.get("date"),
                    "trips": max_day_trips.get("trips", 0),
                }

            max_day_duration = _first_record("max_day_duration")
            if max_day_duration:
                records["max_day_duration"] = {
                    "date": max_day_duration.get("date"),
                    "duration_seconds": max_day_duration.get("duration_seconds", 0.0),
                }

            if combined.get("most_visited"):
                records["most_visited"] = combined["most_visited"]

            combined["records"] = records

            if records.get("longest_trip"):
                combined["longest_trip_distance"] = records["longest_trip"]["distance"]

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
