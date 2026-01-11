"""Business logic for trip analytics and aggregations."""

import logging
from typing import Any

from db.aggregation_utils import get_mongo_tz_expr
from db.models import Trip

logger = logging.getLogger(__name__)
# trips_collection removed, use Trip model directly


class TripAnalyticsService:
    """Service class for trip analytics operations."""

    @staticmethod
    async def get_trip_analytics(query: dict[str, Any]) -> dict[str, Any]:
        """Get analytics on trips over time.

        Args:
            query: MongoDB query filter

        Returns:
            Dictionary containing daily distances, time distribution, and weekday distribution
        """
        tz_expr = get_mongo_tz_expr()

        pipeline = [
            {"$match": query},
            {
                "$group": {
                    "_id": {
                        "date": {
                            "$dateToString": {
                                "format": "%Y-%m-%d",
                                "date": "$startTime",
                                "timezone": tz_expr,
                            },
                        },
                        "hour": {
                            "$hour": {
                                "date": "$startTime",
                                "timezone": tz_expr,
                            }
                        },
                        "dayOfWeek": {
                            "$dayOfWeek": {
                                "date": "$startTime",
                                "timezone": tz_expr,
                            }
                        },
                    },
                    "totalDistance": {"$sum": "$distance"},
                    "tripCount": {"$sum": 1},
                },
            },
        ]

        results = await Trip.aggregate(pipeline).to_list()

        # Organize data by different dimensions
        daily_list = TripAnalyticsService._organize_daily_data(results)
        hourly_list = TripAnalyticsService._organize_hourly_data(results)
        weekday_list = TripAnalyticsService._organize_weekday_data(results)

        return {
            "daily_distances": daily_list,
            "time_distribution": hourly_list,
            "weekday_distribution": weekday_list,
        }

    @staticmethod
    def _organize_daily_data(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Organize results into daily aggregates.

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
        """Organize results into hourly aggregates.

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
        """Organize data by day of week (MongoDB returns 1=Sunday, 7=Saturday).

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
    async def get_driver_behavior_analytics(query: dict[str, Any]) -> dict[str, Any]:
        """Aggregate driving behavior statistics within optional date range filters.

        Args:
            query: MongoDB query filter

        Returns:
            Dictionary containing totals, weekly, and monthly driving behavior statistics
        """
        tz_expr = get_mongo_tz_expr()

        pipeline = [
            {"$match": query},
            {
                "$addFields": {
                    "numericDistance": {
                        "$convert": {
                            "input": "$distance",
                            "to": "double",
                            "onError": 0.0,
                            "onNull": 0.0,
                        }
                    },
                    "numericMaxSpeed": {
                        "$convert": {
                            "input": "$maxSpeed",
                            "to": "double",
                            "onError": 0.0,
                            "onNull": 0.0,
                        }
                    },
                    "speedValue": {
                        "$convert": {
                            "input": {"$ifNull": ["$avgSpeed", "$averageSpeed"]},
                            "to": "double",
                            "onError": None,
                            "onNull": None,
                        }
                    },
                    "hardBrakingVal": {
                        "$ifNull": [
                            "$hardBrakingCounts",
                            {"$ifNull": ["$hardBrakingCount", 0]},
                        ]
                    },
                    "hardAccelVal": {
                        "$ifNull": [
                            "$hardAccelerationCounts",
                            {"$ifNull": ["$hardAccelerationCount", 0]},
                        ]
                    },
                    "idleSeconds": {
                        "$convert": {
                            "input": "$totalIdleDuration",
                            "to": "double",
                            "onError": 0.0,
                            "onNull": 0.0,
                        }
                    },
                    "fuelDouble": {
                        "$convert": {
                            "input": "$fuelConsumed",
                            "to": "double",
                            "onError": 0.0,
                            "onNull": 0.0,
                        }
                    },
                    "dtParts": {
                        "$dateToParts": {
                            "date": "$startTime",
                            "timezone": tz_expr,
                            "iso8601": True,
                        }
                    },
                }
            },
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
                                        ]
                                    }
                                },
                                "speedCount": {
                                    "$sum": {
                                        "$cond": [{"$ne": ["$speedValue", None]}, 1, 0]
                                    }
                                },
                                "maxSpeed": {"$max": "$numericMaxSpeed"},
                                "hardBrakingCounts": {"$sum": "$hardBrakingVal"},
                                "hardAccelerationCounts": {"$sum": "$hardAccelVal"},
                                "totalIdlingTime": {"$sum": "$idleSeconds"},
                                "fuelConsumed": {"$sum": "$fuelDouble"},
                            }
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
                                    ]
                                },
                                "maxSpeed": 1,
                                "hardBrakingCounts": 1,
                                "hardAccelerationCounts": 1,
                                "totalIdlingTime": 1,
                                "fuelConsumed": 1,
                            }
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
                            }
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
                                    ]
                                },
                                "trips": 1,
                                "distance": 1,
                                "hardBraking": 1,
                                "hardAccel": 1,
                            }
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
                            }
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
                                    ]
                                },
                                "trips": 1,
                                "distance": 1,
                                "hardBraking": 1,
                                "hardAccel": 1,
                            }
                        },
                    ],
                }
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
                                "totalIdlingTime": 0.0,
                                "fuelConsumed": 0.0,
                            },
                        ]
                    },
                    "weekly": 1,
                    "monthly": 1,
                }
            },
            {
                "$project": {
                    "totalTrips": "$totals.totalTrips",
                    "totalDistance": {"$round": ["$totals.totalDistance", 2]},
                    "avgSpeed": {"$round": ["$totals.avgSpeed", 2]},
                    "maxSpeed": {"$round": ["$totals.maxSpeed", 2]},
                    "hardBrakingCounts": "$totals.hardBrakingCounts",
                    "hardAccelerationCounts": "$totals.hardAccelerationCounts",
                    "totalIdlingTime": {"$round": ["$totals.totalIdlingTime", 2]},
                    "fuelConsumed": {"$round": ["$totals.fuelConsumed", 2]},
                    "weekly": 1,
                    "monthly": 1,
                }
            },
        ]

        results = await Trip.aggregate(pipeline).to_list()
        if not results:
            return {
                "totalTrips": 0,
                "totalDistance": 0,
                "avgSpeed": 0,
                "maxSpeed": 0,
                "hardBrakingCounts": 0,
                "hardAccelerationCounts": 0,
                "totalIdlingTime": 0,
                "fuelConsumed": 0,
                "weekly": [],
                "monthly": [],
            }

        return results[0]

    @staticmethod
    async def get_recent_trips(limit: int = 5) -> list[dict[str, Any]]:
        """Get recent trips for landing page activity feed.

        Args:
            limit: Number of trips to return (1-20)

        Returns:
            List of recent trip documents
        """
        pipeline = [
            {"$match": {"invalid": {"$ne": True}}},
            {"$sort": {"endTime": -1}},
            {"$limit": limit},
            {
                "$project": {
                    "transactionId": 1,
                    "startTime": 1,
                    "endTime": 1,
                    "distance": 1,
                    "destination": 1,
                    "startLocation": 1,
                    "maxSpeed": 1,
                }
            },
        ]

        trips = await Trip.aggregate(pipeline).to_list()
        return trips
