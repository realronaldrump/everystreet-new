"""
Common MongoDB aggregation pipeline utilities.

This module provides reusable aggregation pipeline builders and data
organization utilities to reduce code duplication across analytics
services.
"""

from __future__ import annotations

from typing import Any


def get_mongo_tz_expr() -> dict[str, Any]:
    """
    Return the standard MongoDB timezone expression for aggregation pipelines.

    This expression handles the timeZone field on trip documents, falling back
    to UTC when the field is missing, empty, or set to "0000".

    Returns:
        MongoDB $switch expression for use in $dateToString, $hour, $dayOfWeek, etc.
    """
    return {
        "$switch": {
            "branches": [{"case": {"$in": ["$timeZone", ["", "0000"]]}, "then": "UTC"}],
            "default": {"$ifNull": ["$timeZone", "UTC"]},
        },
    }


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
                    "input": {"$ifNull": ["$avgSpeed", "$averageSpeed"]},
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "idleSeconds": {
                "$convert": {
                    "input": {"$ifNull": ["$totalIdleDuration", "$totalIdlingTime"]},
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "hardBrakingVal": {
                "$convert": {
                    "input": {
                        "$ifNull": [
                            "$hardBrakingCounts",
                            {"$ifNull": ["$hardBrakingCount", 0]},
                        ],
                    },
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
            "hardAccelVal": {
                "$convert": {
                    "input": {
                        "$ifNull": [
                            "$hardAccelerationCounts",
                            {"$ifNull": ["$hardAccelerationCount", 0]},
                        ],
                    },
                    "to": "double",
                    "onError": 0.0,
                    "onNull": 0.0,
                },
            },
        },
    }


def build_trip_duration_fields_stage(
    tz_expr: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Common duration and date bucketing fields for trip analytics pipelines."""
    tz_expr = tz_expr or get_mongo_tz_expr()
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
                    "else": 0.0,
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
                    "input": {"$ifNull": ["$avgSpeed", "$averageSpeed"]},
                    "to": "double",
                    "onError": None,
                    "onNull": None,
                },
            },
            "hardBrakingVal": {
                "$ifNull": [
                    "$hardBrakingCounts",
                    {"$ifNull": ["$hardBrakingCount", 0]},
                ],
            },
            "hardAccelVal": {
                "$ifNull": [
                    "$hardAccelerationCounts",
                    {"$ifNull": ["$hardAccelerationCount", 0]},
                ],
            },
            "idleSeconds": {
                "$convert": {
                    "input": {"$ifNull": ["$totalIdleDuration", "$totalIdlingTime"]},
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


def build_date_grouping_stage(
    date_field: str = "$startTime",
    group_by: list[str] | None = None,
    sum_fields: dict[str, str] | None = None,
) -> dict[str, Any]:
    """
    Build a MongoDB aggregation $group stage for date-based grouping.

    Args:
        date_field: The field to extract date/time components from.
        group_by: List of grouping dimensions: "date", "hour", "dayOfWeek", "month", "year".
        sum_fields: Dictionary mapping output field names to source fields to sum.

    Returns:
        MongoDB $group stage dictionary.

    Example:
        >>> build_date_grouping_stage(
        ...     date_field="$startTime",
        ...     group_by=["date", "hour"],
        ...     sum_fields={"totalDistance": "$distance", "totalTime": "$duration"},
        ... )
    """
    if group_by is None:
        group_by = ["date"]
    if sum_fields is None:
        sum_fields = {}

    tz_expr = get_mongo_tz_expr()
    group_id: dict[str, Any] = {}

    # Build group ID based on requested dimensions
    if "date" in group_by:
        group_id["date"] = {
            "$dateToString": {
                "format": "%Y-%m-%d",
                "date": date_field,
                "timezone": tz_expr,
            },
        }
    if "hour" in group_by:
        group_id["hour"] = {
            "$hour": {
                "date": date_field,
                "timezone": tz_expr,
            },
        }
    if "dayOfWeek" in group_by:
        group_id["dayOfWeek"] = {
            "$dayOfWeek": {
                "date": date_field,
                "timezone": tz_expr,
            },
        }
    if "month" in group_by:
        group_id["month"] = {
            "$month": {
                "date": date_field,
                "timezone": tz_expr,
            },
        }
    if "year" in group_by:
        group_id["year"] = {
            "$year": {
                "date": date_field,
                "timezone": tz_expr,
            },
        }

    # Build accumulator fields
    accumulators: dict[str, Any] = {"count": {"$sum": 1}}
    for output_name, source_field in sum_fields.items():
        accumulators[output_name] = {"$sum": source_field}

    return {
        "$group": {
            "_id": group_id,
            **accumulators,
        },
    }


def organize_by_dimension(
    results: list[dict[str, Any]],
    dimension: str,
    value_fields: list[str] | None = None,
) -> list[dict[str, Any]]:
    """
    Organize aggregation results by a single dimension.

    Args:
        results: Raw MongoDB aggregation results.
        dimension: The dimension to organize by ("date", "hour", "dayOfWeek", etc.).
        value_fields: List of value field names to extract (defaults to all non-_id fields).

    Returns:
        List of organized data dictionaries.

    Example:
        >>> results = [{"_id": {"date": "2024-01-01"}, "totalDistance": 10, "count": 5}]
        >>> organize_by_dimension(results, "date")
        [{"date": "2024-01-01", "totalDistance": 10, "count": 5}]
    """
    if value_fields is None:
        # Auto-detect value fields from first result
        value_fields = [k for k in results[0] if k != "_id"] if results else []

    organized: dict[Any, dict[str, Any]] = {}
    for result in results:
        key = result["_id"].get(dimension)
        if key is None:
            continue

        if key not in organized:
            organized[key] = {dimension: key}
            for field in value_fields:
                organized[key][field] = 0

        # Accumulate values
        for field in value_fields:
            if field in result:
                organized[key][field] += result[field]

    return sorted(organized.values(), key=lambda x: x[dimension])


def organize_by_multiple_dimensions(
    results: list[dict[str, Any]],
    dimensions: list[str],
) -> list[dict[str, Any]]:
    """
    Organize aggregation results by multiple dimensions.

    Args:
        results: Raw MongoDB aggregation results.
        dimensions: List of dimensions to preserve in output.

    Returns:
        List of flattened result dictionaries.

    Example:
        >>> results = [{"_id": {"date": "2024-01-01", "hour": 14}, "distance": 10}]
        >>> organize_by_multiple_dimensions(results, ["date", "hour"])
        [{"date": "2024-01-01", "hour": 14, "distance": 10}]
    """
    output = []
    for result in results:
        row: dict[str, Any] = {}

        # Extract dimension keys
        for dim in dimensions:
            if dim in result["_id"]:
                row[dim] = result["_id"][dim]

        # Extract value fields
        row.update({key: value for key, value in result.items() if key != "_id"})

        output.append(row)

    return output


def build_match_stage(filters: dict[str, Any]) -> dict[str, Any]:
    """
    Build a MongoDB $match stage from filters.

    Args:
        filters: Dictionary of field filters.

    Returns:
        MongoDB $match stage dictionary.
    """
    return {"$match": filters}


def build_sort_stage(
    sort_by: str,
    ascending: bool = True,
) -> dict[str, Any]:
    """
    Build a MongoDB $sort stage.

    Args:
        sort_by: Field name to sort by.
        ascending: Sort direction (True for ascending, False for descending).

    Returns:
        MongoDB $sort stage dictionary.
    """
    return {"$sort": {sort_by: 1 if ascending else -1}}


def build_limit_stage(limit: int) -> dict[str, Any]:
    """
    Build a MongoDB $limit stage.

    Args:
        limit: Maximum number of documents to return.

    Returns:
        MongoDB $limit stage dictionary.
    """
    return {"$limit": limit}


def build_project_stage(fields: dict[str, Any]) -> dict[str, Any]:
    """
    Build a MongoDB $project stage.

    Args:
        fields: Dictionary mapping field names to inclusion (1/0) or expressions.

    Returns:
        MongoDB $project stage dictionary.
    """
    return {"$project": fields}
