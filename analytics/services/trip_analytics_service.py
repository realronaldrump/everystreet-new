"""Business logic for trip analytics and aggregations."""

import logging
from typing import Any

from analytics.services.insight_query import insight_query
from db.aggregation import aggregate_to_list
from db.aggregation_utils import (
    build_trip_numeric_fields_stage,
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
        query = insight_query(query)
        tz_expr = get_mongo_tz_expr()

        pipeline = [
            {"$match": query},
            build_trip_numeric_fields_stage(),
            {
                "$group": {
                    "_id": build_trip_time_group_id(
                        date_field="startTime",
                        tz_expr=tz_expr,
                    ),
                    "totalDistance": {"$sum": {"$max": [0, "$numericDistance"]}},
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
