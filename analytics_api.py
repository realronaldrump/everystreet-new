import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import pytz
from dateutil import parser as dateutil_parser
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse


from db import (
    aggregate_with_retry,
    build_query_from_request,
    db_manager,
)
from utils import calculate_circular_average_hour

logger = logging.getLogger(__name__)
router = APIRouter()

trips_collection = db_manager.db["trips"]


def convert_datetimes_to_isoformat(item: Any) -> Any:
    """Recursively convert datetime objects in a dictionary or list to ISO format strings."""
    if isinstance(item, dict):
        return {k: convert_datetimes_to_isoformat(v) for k, v in item.items()}
    if isinstance(item, list):
        return [convert_datetimes_to_isoformat(elem) for elem in item]
    if isinstance(item, datetime):
        return item.isoformat()
    return item


@router.get("/api/trip-analytics")
async def get_trip_analytics(request: Request):
    """Get analytics on trips over time."""
    try:
        # Build query with new timezone-aware helper
        query = await build_query_from_request(request)

        # Ensure caller provided at least a date range; with the new helper the
        # range lives under $expr instead of startTime, so we just verify that
        # either query contains a $expr date filter or the request actually
        # included start_date / end_date parameters.
        if "$expr" not in query and (
            request.query_params.get("start_date") is None
            or request.query_params.get("end_date") is None
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing date range",
            )

        pipeline = [
            {"$match": query},
            {
                "$group": {
                    "_id": {
                        "date": {
                            "$dateToString": {
                                "format": "%Y-%m-%d",
                                "date": "$startTime",
                            },
                        },
                        "hour": {"$hour": "$startTime"},
                    },
                    "totalDistance": {"$sum": "$distance"},
                    "tripCount": {"$sum": 1},
                },
            },
        ]

        results = await aggregate_with_retry(trips_collection, pipeline)

        def organize_daily_data(res):
            daily_data = {}
            for r in res:
                date_key = r["_id"]["date"]
                if date_key not in daily_data:
                    daily_data[date_key] = {
                        "distance": 0,
                        "count": 0,
                    }
                daily_data[date_key]["distance"] += r["totalDistance"]
                daily_data[date_key]["count"] += r["tripCount"]
            return [
                {
                    "date": d,
                    "distance": v["distance"],
                    "count": v["count"],
                }
                for d, v in sorted(daily_data.items())
            ]

        def organize_hourly_data(res):
            hourly_data = {}
            for r in res:
                hr = r["_id"]["hour"]
                if hr not in hourly_data:
                    hourly_data[hr] = 0
                hourly_data[hr] += r["tripCount"]
            return [{"hour": h, "count": c} for h, c in sorted(hourly_data.items())]

        daily_list = organize_daily_data(results)
        hourly_list = organize_hourly_data(results)

        return JSONResponse(
            content={
                "daily_distances": daily_list,
                "time_distribution": hourly_list,
            },
        )

    except Exception as e:
        logger.exception("Error trip analytics: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/driver-behavior")
async def driver_behavior_analytics(request: Request):
    """Aggregate driving behavior statistics within optional date range filters.

    Accepts the same `start_date` and `end_date` query parameters used by other API endpoints.
    If no filters are provided, all trips are considered (back-compat)."""

    # Build the Mongo query using the shared helper so filters stay consistent app-wide
    try:
        query = await build_query_from_request(request)
    except Exception as e:
        logger.exception("Failed to build query for driver behavior analytics: %s", e)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    trips = await trips_collection.find(query).to_list(length=None)
    if not trips:
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

    def get_field(trip, *names, default=0):
        for n in names:
            v = trip.get(n)
            if v is not None:
                try:
                    return float(v) if "." in str(v) else int(v)
                except (ValueError, TypeError):
                    continue
        return default

    total_trips = len(trips)
    total_distance = sum(get_field(t, "distance", default=0.0) for t in trips)

    speeds_sum = sum(
        get_field(t, "avgSpeed", "averageSpeed", default=0.0)
        for t in trips
        if t.get("avgSpeed") is not None or t.get("averageSpeed") is not None
    )
    num_trips_with_speed = sum(
        1
        for t in trips
        if t.get("avgSpeed") is not None or t.get("averageSpeed") is not None
    )
    avg_speed = speeds_sum / num_trips_with_speed if num_trips_with_speed > 0 else 0.0

    max_speeds = [get_field(t, "maxSpeed", default=0.0) for t in trips]
    max_speed = max(max_speeds) if max_speeds else 0.0

    hard_braking = sum(
        get_field(t, "hardBrakingCounts", "hardBrakingCount", default=0) for t in trips
    )
    hard_accel = sum(
        get_field(t, "hardAccelerationCounts", "hardAccelerationCount", default=0)
        for t in trips
    )
    idling = sum(get_field(t, "totalIdleDuration", default=0.0) for t in trips)
    fuel = sum(get_field(t, "fuelConsumed", default=0.0) for t in trips)

    weekly = defaultdict(
        lambda: {
            "trips": 0,
            "distance": 0.0,
            "hardBraking": 0,
            "hardAccel": 0,
        },
    )
    monthly = defaultdict(
        lambda: {
            "trips": 0,
            "distance": 0.0,
            "hardBraking": 0,
            "hardAccel": 0,
        },
    )

    for t in trips:
        start_time_raw = t.get("startTime")
        if not start_time_raw:
            continue

        start_dt: datetime | None = None
        if isinstance(start_time_raw, datetime):
            start_dt = start_time_raw
        elif isinstance(start_time_raw, str):
            try:
                start_dt = dateutil_parser.isoparse(start_time_raw)
            except ValueError:
                logger.warning(
                    f"Could not parse startTime '{start_time_raw}' for trip {t.get('transactionId')}"
                )
                continue
        else:
            logger.warning(
                f"Unexpected startTime type '{type(start_time_raw)}' for trip {t.get('transactionId')}"
            )
            continue

        if not start_dt:
            continue

        if start_dt.tzinfo is None:
            start_dt = start_dt.replace(tzinfo=timezone.utc)

        year, week, _ = start_dt.isocalendar()
        month_val = start_dt.month

        wkey = f"{year}-W{week:02d}"
        mkey = f"{year}-{month_val:02d}"

        weekly[wkey]["trips"] += 1
        weekly[wkey]["distance"] += get_field(t, "distance", default=0.0)
        weekly[wkey]["hardBraking"] += get_field(
            t, "hardBrakingCounts", "hardBrakingCount", default=0
        )
        weekly[wkey]["hardAccel"] += get_field(
            t, "hardAccelerationCounts", "hardAccelerationCount", default=0
        )

        monthly[mkey]["trips"] += 1
        monthly[mkey]["distance"] += get_field(t, "distance", default=0.0)
        monthly[mkey]["hardBraking"] += get_field(
            t, "hardBrakingCounts", "hardBrakingCount", default=0
        )
        monthly[mkey]["hardAccel"] += get_field(
            t, "hardAccelerationCounts", "hardAccelerationCount", default=0
        )

    weekly_trend = [{"week": k, **v} for k, v in sorted(weekly.items())]
    monthly_trend = [{"month": k, **v} for k, v in sorted(monthly.items())]

    combined = {
        "totalTrips": total_trips,
        "totalDistance": round(total_distance, 2),
        "avgSpeed": round(avg_speed, 2),
        "maxSpeed": round(max_speed, 2),
        "hardBrakingCounts": hard_braking,
        "hardAccelerationCounts": hard_accel,
        "totalIdlingTime": round(idling, 2),
        "fuelConsumed": round(fuel, 2),
        "weekly": weekly_trend,
        "monthly": monthly_trend,
    }

    # Ensure all datetime objects are JSON serializable (convert to ISO strings)
    return JSONResponse(content=convert_datetimes_to_isoformat(combined))


@router.get("/api/driving-insights")
async def get_driving_insights(request: Request):
    """Get aggregated driving insights."""
    try:
        query = await build_query_from_request(request)

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

        trips_result = await aggregate_with_retry(trips_collection, pipeline)

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
                                ]
                            },
                            "then": {
                                "$divide": [
                                    {"$subtract": ["$endTime", "$startTime"]},
                                    1000,
                                ]
                            },
                            "else": 0.0,
                        }
                    }
                }
            },
            {
                "$group": {
                    "_id": "$destination",
                    "visits": {"$sum": 1},
                    "distance": {"$sum": {"$ifNull": ["$distance", 0]}},
                    "total_duration": {"$sum": "$duration_seconds"},
                    "last_visit": {"$max": "$endTime"},
                    "isCustomPlace": {"$first": "$isCustomPlace"},
                }
            },
            {"$sort": {"visits": -1}},
            {"$limit": 5},
        ]

        trips_top = await aggregate_with_retry(
            trips_collection, pipeline_top_destinations
        )

        combined = {
            "total_trips": 0,
            "total_distance": 0.0,
            "total_fuel_consumed": 0.0,
            "max_speed": 0.0,
            "total_idle_duration": 0,
            "longest_trip_distance": 0.0,
            "most_visited": {},
            "top_destinations": [],
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

        if trips_top:
            # The first entry is also the "most visited" location
            best = trips_top[0]
            combined["most_visited"] = {
                "_id": best["_id"],
                "count": best["visits"],
                "isCustomPlace": best.get("isCustomPlace", False),
            }

            # Add formatted top destinations list
            combined["top_destinations"] = [
                {
                    "location": (
                        d["_id"].get("formatted_address")
                        if isinstance(d["_id"], dict)
                        else (
                            d["_id"].get("name")
                            if isinstance(d["_id"], dict)
                            else str(d["_id"])
                        )
                    ),
                    "visits": d.get("visits", 0),
                    "distance": round(d.get("distance", 0.0), 2),
                    "duration_seconds": round(d.get("total_duration", 0.0), 0),
                    "lastVisit": d.get("last_visit"),
                    "isCustomPlace": d.get("isCustomPlace", False),
                }
                for d in trips_top
            ]

        return JSONResponse(content=convert_datetimes_to_isoformat(combined))
    except Exception as e:
        logger.exception(
            "Error in get_driving_insights: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/metrics")
async def get_metrics(request: Request):
    """Get trip metrics and statistics using database aggregation."""
    try:
        query = await build_query_from_request(request)
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

        results = await aggregate_with_retry(trips_collection, pipeline)

        if not results:
            empty_data = {
                "total_trips": 0,
                "total_distance": "0.00",
                "avg_distance": "0.00",
                "avg_start_time": "00:00 AM",
                "avg_driving_time": "00:00",
                "avg_speed": "0.00",
                "max_speed": "0.00",
            }
            return JSONResponse(content=empty_data)

        metrics = results[0]
        total_trips = metrics.get("total_trips", 0)

        start_hours_utc_list = metrics.get("start_hours_utc", [])
        avg_start_time_str = "00:00 AM"
        if start_hours_utc_list:
            avg_hour_utc_float = calculate_circular_average_hour(
                start_hours_utc_list,
            )

            base_date = datetime.now(timezone.utc).replace(
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

        avg_driving_time_str = "00:00"
        if total_trips > 0:
            total_duration_seconds = metrics.get("total_duration_seconds", 0.0)
            avg_duration_seconds = total_duration_seconds / total_trips
            avg_driving_h = int(avg_duration_seconds // 3600)
            avg_driving_m = int((avg_duration_seconds % 3600) // 60)
            avg_driving_time_str = f"{avg_driving_h:02d}:{avg_driving_m:02d}"

        response_content = {
            "total_trips": total_trips,
            "total_distance": f"{round(metrics.get('total_distance', 0.0), 2)}",
            "avg_distance": f"{round(metrics.get('avg_distance', 0.0), 2)}",
            "avg_start_time": avg_start_time_str,
            "avg_driving_time": avg_driving_time_str,
            "avg_speed": f"{round(metrics.get('avg_speed', 0.0), 2)}",
            "max_speed": f"{round(metrics.get('max_speed', 0.0), 2)}",
            "total_duration_seconds": round(
                metrics.get("total_duration_seconds", 0.0), 0
            ),
        }

        return JSONResponse(content=response_content)

    except Exception as e:
        logger.exception("Error in get_metrics: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )