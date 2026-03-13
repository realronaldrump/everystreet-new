"""Shared temporal analytics helpers for recurring-route features."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from core.serialization import serialize_datetime

DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def build_temporal_facet_pipeline(
    *,
    match_query: dict[str, Any],
    tz_expr: Any,
    include_timeline: bool = False,
    month_limit: int | None = None,
    include_extended_stats: bool = False,
) -> list[dict[str, Any]]:
    project: dict[str, Any] = {
        "startTime": 1,
        "distance": 1,
        "duration": 1,
        "hour": {"$hour": {"date": "$startTime", "timezone": tz_expr}},
        "dayOfWeek": {"$dayOfWeek": {"date": "$startTime", "timezone": tz_expr}},
        "yearMonth": {
            "$dateToString": {
                "format": "%Y-%m",
                "date": "$startTime",
                "timezone": tz_expr,
            },
        },
    }
    if include_timeline or include_extended_stats:
        project["maxSpeed"] = 1
    if include_extended_stats:
        project["fuelConsumed"] = 1

    stats_group: dict[str, Any] = {
        "_id": None,
        "totalTrips": {"$sum": 1},
        "totalDistance": {"$sum": "$distance"},
        "totalDuration": {"$sum": "$duration"},
        "avgDistance": {"$avg": "$distance"},
        "avgDuration": {"$avg": "$duration"},
        "firstTrip": {"$min": "$startTime"},
        "lastTrip": {"$max": "$startTime"},
    }
    if include_extended_stats:
        stats_group.update(
            {
                "minDistance": {"$min": "$distance"},
                "maxDistance": {"$max": "$distance"},
                "minDuration": {"$min": "$duration"},
                "maxDuration": {"$max": "$duration"},
                "avgMaxSpeed": {"$avg": "$maxSpeed"},
                "maxMaxSpeed": {"$max": "$maxSpeed"},
                "totalFuel": {"$sum": "$fuelConsumed"},
                "avgFuel": {"$avg": "$fuelConsumed"},
            },
        )

    by_month = [
        {
            "$group": {
                "_id": "$yearMonth",
                "count": {"$sum": 1},
                "totalDistance": {"$sum": "$distance"},
                "avgDistance": {"$avg": "$distance"},
                "avgDuration": {"$avg": "$duration"},
            },
        },
    ]
    if month_limit is not None and month_limit > 0:
        by_month.extend(
            [
                {"$sort": {"_id": -1}},
                {"$limit": int(month_limit)},
                {"$sort": {"_id": 1}},
            ],
        )
    else:
        by_month.append({"$sort": {"_id": 1}})

    facet: dict[str, Any] = {
        "byHour": [
            {
                "$group": {
                    "_id": "$hour",
                    "count": {"$sum": 1},
                    "avgDistance": {"$avg": "$distance"},
                    "avgDuration": {"$avg": "$duration"},
                },
            },
            {"$sort": {"_id": 1}},
        ],
        "byDayOfWeek": [
            {
                "$group": {
                    "_id": "$dayOfWeek",
                    "count": {"$sum": 1},
                    "avgDistance": {"$avg": "$distance"},
                    "avgDuration": {"$avg": "$duration"},
                },
            },
            {"$sort": {"_id": 1}},
        ],
        "byMonth": by_month,
        "stats": [{"$group": stats_group}],
    }
    if include_timeline:
        facet["tripTimeline"] = [
            {"$sort": {"startTime": 1}},
            {
                "$project": {
                    "startTime": 1,
                    "distance": 1,
                    "duration": 1,
                    "maxSpeed": 1,
                },
            },
        ]

    return [
        {"$match": match_query},
        {"$project": project},
        {"$facet": facet},
    ]


def normalize_hour_buckets(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    row_map = {row.get("_id"): row for row in rows or []}
    result = []
    for hour in range(24):
        row = row_map.get(hour, {})
        result.append(
            {
                "hour": hour,
                "count": row.get("count", 0),
                "avgDistance": row.get("avgDistance"),
                "avgDuration": row.get("avgDuration"),
            },
        )
    return result


def normalize_day_buckets(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    row_map = {row.get("_id"): row for row in rows or []}
    result = []
    for day in range(1, 8):
        row = row_map.get(day, {})
        result.append(
            {
                "day": day,
                "dayName": DAY_NAMES[day - 1],
                "count": row.get("count", 0),
                "avgDistance": row.get("avgDistance"),
                "avgDuration": row.get("avgDuration"),
            },
        )
    return result


def normalize_month_buckets(
    rows: list[dict[str, Any]] | None,
    *,
    include_month_alias: bool = False,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for row in rows or []:
        month_id = row.get("_id")
        item = {
            "_id": month_id,
            "count": row.get("count", 0),
            "totalDistance": row.get("totalDistance"),
            "avgDistance": row.get("avgDistance"),
            "avgDuration": row.get("avgDuration"),
        }
        if include_month_alias:
            item["month"] = month_id
        result.append(item)
    return result


def serialize_stats_for_response(
    raw_stats: dict[str, Any] | None,
) -> tuple[dict[str, Any], datetime | None, datetime | None]:
    stats = dict(raw_stats or {})
    stats.pop("_id", None)

    first_trip = stats.get("firstTrip")
    last_trip = stats.get("lastTrip")
    first_trip_dt = first_trip if isinstance(first_trip, datetime) else None
    last_trip_dt = last_trip if isinstance(last_trip, datetime) else None

    if first_trip is not None:
        stats["firstTrip"] = serialize_datetime(first_trip)
    if last_trip is not None:
        stats["lastTrip"] = serialize_datetime(last_trip)

    return stats, first_trip_dt, last_trip_dt


__all__ = [
    "DAY_NAMES",
    "build_temporal_facet_pipeline",
    "normalize_day_buckets",
    "normalize_hour_buckets",
    "normalize_month_buckets",
    "serialize_stats_for_response",
]
