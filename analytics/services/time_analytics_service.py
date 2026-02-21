"""Business logic for time-based analytics and filtering."""

import logging
from typing import Any

from db.aggregation import aggregate_to_list
from db.aggregation_utils import build_trip_duration_fields_stage, get_mongo_tz_expr
from db.models import Trip
from core.trip_source_policy import enforce_bouncie_source

logger = logging.getLogger(__name__)


class TimeAnalyticsService:
    """Service class for time-based analytics operations."""

    @staticmethod
    async def get_time_period_trips(
        query: dict[str, Any],
        time_type: str,
        time_value: int,
    ) -> list[dict[str, Any]]:
        """
        Get trips for a specific time period (hour or day of week).

        Args:
            query: MongoDB query filter
            time_type: Type of time filter ('hour' or 'day')
            time_value: Hour (0-23) or day of week (0-6, where 0 is Sunday)

        Returns:
            List of trip documents matching the time criteria

        Raises:
            ValueError: If time_type is invalid
        """
        query = enforce_bouncie_source(query)
        tz_expr = get_mongo_tz_expr()

        # Add time-specific filter to query
        if time_type == "hour":
            query["$expr"] = {
                "$and": [
                    query.get("$expr", {"$literal": True}),
                    {
                        "$eq": [
                            {"$hour": {"date": "$startTime", "timezone": tz_expr}},
                            time_value,
                        ],
                    },
                ],
            }
        elif time_type == "day":
            # Convert JavaScript day (0=Sunday) to MongoDB day (1=Sunday)
            mongo_day = time_value + 1
            query["$expr"] = {
                "$and": [
                    query.get("$expr", {"$literal": True}),
                    {
                        "$eq": [
                            {"$dayOfWeek": {"date": "$startTime", "timezone": tz_expr}},
                            mongo_day,
                        ],
                    },
                ],
            }
        else:
            msg = "time_type must be 'hour' or 'day'"
            raise ValueError(msg)

        pipeline = [
            {"$match": query},
            build_trip_duration_fields_stage(
                tz_expr,
                default_duration_field="$duration",
            ),
            {
                "$project": {
                    "_id": 0,
                    "transactionId": 1,
                    "startTime": 1,
                    "endTime": 1,
                    "duration": "$duration_seconds",
                    "distance": 1,
                    "startLocation": 1,
                    "destination": 1,
                    "maxSpeed": 1,
                    "totalIdleDuration": "$totalIdleDuration",
                    "fuelConsumed": 1,
                    "timeZone": 1,
                },
            },
            {"$sort": {"startTime": -1}},
            {"$limit": 100},
        ]

        return await aggregate_to_list(Trip, pipeline)
