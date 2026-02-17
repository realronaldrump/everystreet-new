"""Business logic for drill-down trip lists used by the insights UI."""

import logging
from typing import Any, ClassVar

from db.aggregation import aggregate_to_list
from db.aggregation_utils import (
    build_trip_duration_fields_stage,
    build_trip_numeric_fields_stage,
)
from db.models import Trip

logger = logging.getLogger(__name__)


class DrilldownService:
    """Service class for insight drill-down trip lists."""

    SUPPORTED_KINDS: ClassVar[frozenset[str]] = frozenset(
        {
            "trips",
            "distance",
            "duration",
            "fuel",
            "top_speed",
            "avg_speed",
            "idle_time",
            "hard_braking",
        },
    )

    SORT_BY_KIND: ClassVar[dict[str, dict[str, int]]] = {
        "trips": {"startTime": -1},
        "distance": {"numericDistance": -1, "startTime": -1},
        "duration": {"duration_seconds": -1, "startTime": -1},
        "fuel": {"fuelConsumedValue": -1, "startTime": -1},
        "top_speed": {"numericMaxSpeed": -1, "startTime": -1},
        "avg_speed": {"avgSpeedValue": -1, "startTime": -1},
        "idle_time": {"idleSeconds": -1, "startTime": -1},
        "hard_braking": {"hardBrakingVal": -1, "startTime": -1},
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

        sort_spec = DrilldownService.SORT_BY_KIND.get(kind, {"startTime": -1})

        match_query = dict(query)
        if extra_match:
            match_query.update(extra_match)

        pipeline = [
            {"$match": match_query},
            build_trip_numeric_fields_stage(),
            build_trip_duration_fields_stage(default_duration_field="$duration"),
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
