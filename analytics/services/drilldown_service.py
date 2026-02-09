"""Business logic for drill-down trip lists used by the insights UI."""

import logging
from typing import Any

from db.aggregation import aggregate_to_list
from db.models import Trip

logger = logging.getLogger(__name__)


class DrilldownService:
    """Service class for insight drill-down trip lists."""

    SUPPORTED_KINDS: set[str] = {
        "trips",
        "distance",
        "duration",
        "fuel",
        "top_speed",
        "avg_speed",
        "idle_time",
        "hard_braking",
    }

    @staticmethod
    async def get_drilldown_trips(
        query: dict[str, Any],
        kind: str,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """
        Get a list of trips for a drill-down modal.

        The base `query` is typically produced by `build_query_from_request()` and may
        include an `$expr` for date filters (start_date/end_date).
        """
        if kind not in DrilldownService.SUPPORTED_KINDS:
            msg = f"Unsupported drilldown kind: {kind}"
            raise ValueError(msg)

        limit = max(1, min(int(limit or 100), 500))

        # Extra match constraints depending on the drilldown kind.
        extra_match: dict[str, Any] = {}
        if kind == "hard_braking":
            extra_match["hardBrakingCounts"] = {"$gt": 0}

        # Compute duration + numeric sort fields safely (handles strings / nulls).
        add_fields = {
            "duration_seconds": {
                "$cond": {
                    "if": {
                        "$and": [
                            {"$ifNull": ["$startTime", False]},
                            {"$ifNull": ["$endTime", False]},
                            {"$lt": ["$startTime", "$endTime"]},
                        ],
                    },
                    "then": {
                        "$divide": [
                            {"$subtract": ["$endTime", "$startTime"]},
                            1000.0,
                        ],
                    },
                    "else": {"$ifNull": ["$duration", 0]},
                },
            },
            "sort_distance": {
                "$convert": {
                    "input": "$distance",
                    "to": "double",
                    "onError": 0,
                    "onNull": 0,
                },
            },
            "sort_fuel": {
                "$convert": {
                    "input": "$fuelConsumed",
                    "to": "double",
                    "onError": 0,
                    "onNull": 0,
                },
            },
            "sort_max_speed": {
                "$convert": {
                    "input": "$maxSpeed",
                    "to": "double",
                    "onError": 0,
                    "onNull": 0,
                },
            },
            "sort_avg_speed": {
                "$convert": {
                    "input": "$avgSpeed",
                    "to": "double",
                    "onError": 0,
                    "onNull": 0,
                },
            },
            "sort_idle": {
                "$convert": {
                    "input": "$totalIdleDuration",
                    "to": "double",
                    "onError": 0,
                    "onNull": 0,
                },
            },
            "sort_hard_braking": {
                "$convert": {
                    "input": "$hardBrakingCounts",
                    "to": "double",
                    "onError": 0,
                    "onNull": 0,
                },
            },
        }

        sort_spec: dict[str, int]
        if kind == "trips":
            sort_spec = {"startTime": -1}
        elif kind == "distance":
            sort_spec = {"sort_distance": -1, "startTime": -1}
        elif kind == "duration":
            sort_spec = {"duration_seconds": -1, "startTime": -1}
        elif kind == "fuel":
            sort_spec = {"sort_fuel": -1, "startTime": -1}
        elif kind == "top_speed":
            sort_spec = {"sort_max_speed": -1, "startTime": -1}
        elif kind == "avg_speed":
            sort_spec = {"sort_avg_speed": -1, "startTime": -1}
        elif kind == "idle_time":
            sort_spec = {"sort_idle": -1, "startTime": -1}
        elif kind == "hard_braking":
            sort_spec = {"sort_hard_braking": -1, "startTime": -1}
        else:
            # Should be unreachable due to SUPPORTED_KINDS check.
            sort_spec = {"startTime": -1}

        match_query = dict(query)
        if extra_match:
            match_query.update(extra_match)

        pipeline = [
            {"$match": match_query},
            {"$addFields": add_fields},
            {"$sort": sort_spec},
            {"$limit": limit},
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
                    "avgSpeed": 1,
                    "hardBrakingCounts": 1,
                    "hardAccelerationCounts": 1,
                    "totalIdleDuration": "$totalIdleDuration",
                    "fuelConsumed": 1,
                    "timeZone": 1,
                },
            },
        ]

        return await aggregate_to_list(Trip, pipeline)
