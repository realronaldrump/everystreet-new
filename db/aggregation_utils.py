"""
Common MongoDB aggregation pipeline utilities.

This module provides reusable aggregation pipeline builders and data
organization utilities to reduce code duplication across analytics
services.
"""

from __future__ import annotations

from typing import Any


def get_mongo_tz_expr(date_field: str = "startTime") -> dict[str, Any]:
    """
    Return the standard MongoDB timezone expression for aggregation pipelines.

    Trips store timezone as canonical `startTimeZone` / `endTimeZone`. This helper
    selects the timezone field that corresponds to the given ``date_field``.

    The value may be an IANA name (e.g. "America/New_York") or a UTC offset
    (e.g. "-07:00"). Some upstream sources send offsets as "-0700"; normalize
    those to "-07:00" so MongoDB date operators do not error.

    Args:
        date_field: The trip date field being filtered/grouped on.
            "startTime" → uses ``$startTimeZone``,
            "endTime" → uses ``$endTimeZone``,
            anything else → uses ``$startTimeZone``.

    Returns:
        MongoDB $switch expression for use in $dateToString, $hour, $dayOfWeek, etc.
    """
    if date_field == "endTime":
        tz_candidate_expr: dict[str, Any] | str = "$endTimeZone"
    elif date_field == "startTime":
        tz_candidate_expr = "$startTimeZone"
    else:
        tz_candidate_expr = "$startTimeZone"

    return {
        "$let": {
            "vars": {"tz": tz_candidate_expr},
            "in": {
                "$switch": {
                    "branches": [
                        {
                            "case": {"$in": ["$$tz", ["", "0000", None]]},
                            "then": "UTC",
                        },
                        {"case": {"$in": ["$$tz", ["UTC", "GMT"]]}, "then": "$$tz"},
                        {
                            "case": {
                                "$regexMatch": {
                                    "input": "$$tz",
                                    "regex": r"^[+-][0-9]{4}$",
                                },
                            },
                            "then": {
                                "$concat": [
                                    {"$substrBytes": ["$$tz", 0, 3]},
                                    ":",
                                    {"$substrBytes": ["$$tz", 3, 2]},
                                ],
                            },
                        },
                        {
                            "case": {
                                "$regexMatch": {
                                    "input": "$$tz",
                                    "regex": r"^[+-][0-9]{2}:[0-9]{2}$",
                                },
                            },
                            "then": "$$tz",
                        },
                        {
                            "case": {
                                "$regexMatch": {
                                    "input": "$$tz",
                                    "regex": r"^[a-zA-Z_]+(?:/[a-zA-Z0-9_+\-]+)+$",
                                },
                            },
                            "then": "$$tz",
                        },
                    ],
                    "default": "UTC",
                },
            },
        },
    }


def build_trip_time_group_id(
    *,
    date_field: str = "startTime",
    tz_expr: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Reusable date/hour/day-of-week group ID for trip analytics."""
    tz_expr = tz_expr or get_mongo_tz_expr(date_field)
    return {
        "date": {
            "$dateToString": {
                "format": "%Y-%m-%d",
                "date": f"${date_field}",
                "timezone": tz_expr,
            },
        },
        "hour": {
            "$hour": {
                "date": f"${date_field}",
                "timezone": tz_expr,
            },
        },
        "dayOfWeek": {
            "$dayOfWeek": {
                "date": f"${date_field}",
                "timezone": tz_expr,
            },
        },
    }


def build_time_period_expr(
    *,
    time_type: str,
    time_value: int,
    date_field: str = "startTime",
    tz_expr: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a MongoDB `$expr` for hour/day period filtering."""
    tz_expr = tz_expr or get_mongo_tz_expr(date_field)
    if time_type == "hour":
        return {
            "$eq": [
                {"$hour": {"date": f"${date_field}", "timezone": tz_expr}},
                time_value,
            ],
        }
    if time_type == "day":
        # Convert JavaScript day (0=Sunday) to MongoDB day (1=Sunday)
        mongo_day = time_value + 1
        return {
            "$eq": [
                {"$dayOfWeek": {"date": f"${date_field}", "timezone": tz_expr}},
                mongo_day,
            ],
        }
    msg = "time_type must be 'hour' or 'day'"
    raise ValueError(msg)


def build_trip_numeric_fields_stage() -> dict[str, Any]:
    """Common numeric conversions for trip analytics pipelines."""
    return {
        "$addFields": {
            "numericDistance": {
                "$convert": {
                    "input": "$distance",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "numericMaxSpeed": {
                "$convert": {
                    "input": "$maxSpeed",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "avgSpeedValue": {
                "$convert": {
                    "input": "$avgSpeed",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "idleSeconds": {
                "$convert": {
                    "input": "$totalIdleDuration",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "hardBrakingVal": {
                "$convert": {
                    "input": "$hardBrakingCounts",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "hardAccelVal": {
                "$convert": {
                    "input": "$hardAccelerationCounts",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "fuelConsumedValue": {
                "$convert": {
                    "input": "$fuelConsumed",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
        },
    }


def build_numeric_sort_field_stage(
    field_name: str,
    *,
    output_field: str = "sortVal",
    default_value: float = 0.0,
) -> dict[str, Any]:
    """Build an `$addFields` stage that coerces a field to a numeric sort key."""
    return {
        "$addFields": {
            output_field: {
                "$convert": {
                    "input": f"${field_name}",
                    "to": "double",
                    "onError": default_value,
                    "onNull": default_value,
                },
            },
        },
    }


def build_trip_duration_fields_stage(
    tz_expr: dict[str, Any] | None = None,
    *,
    default_duration_field: str | None = None,
) -> dict[str, Any]:
    """Common duration and date bucketing fields for trip analytics pipelines."""
    tz_expr = tz_expr or get_mongo_tz_expr()
    default_duration: float | dict[str, Any]
    if default_duration_field:
        default_duration = {"$ifNull": [default_duration_field, 0.0]}
    else:
        default_duration = 0.0
    return {
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
                    "else": default_duration,
                },
            },
            "recorded_at": {"$ifNull": ["$endTime", "$startTime"]},
            "day_key": {
                "$dateToString": {
                    "format": "%Y-%m-%d",
                    "date": "$startTime",
                    "timezone": tz_expr,
                },
            },
        },
    }


def build_driver_behavior_fields_stage(
    tz_expr: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fields needed for driver behavior analytics (speed, braking, fuel, time)."""
    tz_expr = tz_expr or get_mongo_tz_expr()
    return {
        "$addFields": {
            "numericDistance": {
                "$convert": {
                    "input": "$distance",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "numericMaxSpeed": {
                "$convert": {
                    "input": "$maxSpeed",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "speedValue": {
                "$convert": {
                    "input": "$avgSpeed",
                    "to": "double",
                    "onError": None,
                    "onNull": None,
                },
            },
            "hardBrakingVal": {
                "$ifNull": ["$hardBrakingCounts", 0],
            },
            "hardAccelVal": {
                "$ifNull": ["$hardAccelerationCounts", 0],
            },
            "idleSeconds": {
                "$convert": {
                    "input": "$totalIdleDuration",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "fuelDouble": {
                "$convert": {
                    "input": "$fuelConsumed",
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "dtParts": {
                "$dateToParts": {
                    "date": "$startTime",
                    "timezone": tz_expr,
                    "iso8601": True,
                },
            },
        },
    }
