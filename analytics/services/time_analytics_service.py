"""Business logic for time-based analytics and filtering."""

import logging
from typing import Any

from core.trip_source_policy import enforce_bouncie_source
from db.aggregation import aggregate_to_list
from db.aggregation_utils import (
    build_time_period_expr,
    build_trip_duration_fields_stage,
    get_mongo_tz_expr,
)
from db.models import Trip

logger = logging.getLogger(__name__)


class TimeAnalyticsService:
    """Service class for time-based analytics operations."""

    @staticmethod
    async def get_time_period_trips(
        query: dict[str, Any],
        time_type: str,
        time_value: int,
        day_value: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Get trips for a specific time period (hour or day of week).

        Args:
            query: MongoDB query filter
            time_type: Type of time filter ('hour', 'day', or 'cell')
            time_value: Hour (0-23), day of week (0-6), or hour for 'cell'
            day_value: Day of week (0-6) for 'cell'

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
                    build_time_period_expr(
                        time_type="hour",
                        time_value=time_value,
                        date_field="startTime",
                        tz_expr=tz_expr,
                    ),
                ],
            }
        elif time_type == "day":
            query["$expr"] = {
                "$and": [
                    query.get("$expr", {"$literal": True}),
                    build_time_period_expr(
                        time_type="day",
                        time_value=time_value,
                        date_field="startTime",
                        tz_expr=tz_expr,
                    ),
                ],
            }
        elif time_type == "cell":
            if day_value is None:
                msg = "day_value is required when time_type is 'cell'"
                raise ValueError(msg)
            query["$expr"] = {
                "$and": [
                    query.get("$expr", {"$literal": True}),
                    build_time_period_expr(
                        time_type="hour",
                        time_value=time_value,
                        date_field="startTime",
                        tz_expr=tz_expr,
                    ),
                    build_time_period_expr(
                        time_type="day",
                        time_value=day_value,
                        date_field="startTime",
                        tz_expr=tz_expr,
                    ),
                ],
            }
        else:
            msg = "time_type must be 'hour', 'day', or 'cell'"
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
