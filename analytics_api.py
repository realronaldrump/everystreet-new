import logging
from datetime import UTC, datetime, timedelta

import pytz
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse

from db import (
    aggregate_with_retry,
    build_query_from_request,
    db_manager,
    serialize_for_json,
)
from utils import calculate_circular_average_hour

logger = logging.getLogger(__name__)
router = APIRouter()

trips_collection = db_manager.db["trips"]


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

        # Build timezone expression (same logic used elsewhere in the app)
        tz_expr = {
            "$switch": {
                "branches": [
                    {"case": {"$in": ["$timeZone", ["", "0000"]]}, "then": "UTC"}
                ],
                "default": {"$ifNull": ["$timeZone", "UTC"]},
            }
        }

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

        def organize_weekday_data(res):
            """Organize data by day of week (MongoDB returns 1=Sunday, 7=Saturday)."""
            weekday_data = {}
            for r in res:
                # MongoDB $dayOfWeek returns 1-7 (1=Sunday, 2=Monday, ..., 7=Saturday)
                # Convert to JavaScript 0-6 (0=Sunday, 1=Monday, ..., 6=Saturday)
                day_of_week = r["_id"]["dayOfWeek"] - 1
                if day_of_week not in weekday_data:
                    weekday_data[day_of_week] = 0
                weekday_data[day_of_week] += r["tripCount"]
            return [{"day": d, "count": c} for d, c in sorted(weekday_data.items())]

        daily_list = organize_daily_data(results)
        hourly_list = organize_hourly_data(results)
        weekday_list = organize_weekday_data(results)

        return JSONResponse(
            content={
                "daily_distances": daily_list,
                "time_distribution": hourly_list,
                "weekday_distribution": weekday_list,
            },
        )

    except Exception as e:
        logger.exception("Error trip analytics: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/time-period-trips")
async def get_time_period_trips(request: Request):
    """Get trips for a specific time period (hour or day of week)."""
    try:
        query = await build_query_from_request(request)

        time_type = request.query_params.get("time_type")  # "hour" or "day"
        time_value = request.query_params.get("time_value")  # hour (0-23) or day (0-6)

        if not time_type or time_value is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing time_type or time_value parameter",
            )

        try:
            time_value = int(time_value)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="time_value must be an integer",
            )

        # Build timezone expression
        tz_expr = {
            "$switch": {
                "branches": [
                    {"case": {"$in": ["$timeZone", ["", "0000"]]}, "then": "UTC"}
                ],
                "default": {"$ifNull": ["$timeZone", "UTC"]},
            }
        }

        # Add time-specific filter
        if time_type == "hour":
            query["$expr"] = {
                "$and": [
                    query.get("$expr", {"$literal": True}),
                    {
                        "$eq": [
                            {"$hour": {"date": "$startTime", "timezone": tz_expr}},
                            time_value,
                        ]
                    },
                ]
            }
        elif time_type == "day":
            # MongoDB returns 1-7 (1=Sunday), we get 0-6 (0=Sunday) from frontend
            mongo_day = time_value + 1
            query["$expr"] = {
                "$and": [
                    query.get("$expr", {"$literal": True}),
                    {
                        "$eq": [
                            {"$dayOfWeek": {"date": "$startTime", "timezone": tz_expr}},
                            mongo_day,
                        ]
                    },
                ]
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="time_type must be 'hour' or 'day'",
            )

        # Fetch trips with relevant fields, calculating duration if needed
        pipeline = [
            {"$match": query},
            {
                "$addFields": {
                    "duration_seconds": {
                        "$cond": {
                            "if": {
                                "$and": [
                                    {"$ifNull": ["$startTime", False]},
                                    {"$ifNull": ["$endTime", False]},
                                    {"$lt": ["$startTime", "$endTime"]},
                                ]
                            },
                            "then": {
                                "$divide": [
                                    {"$subtract": ["$endTime", "$startTime"]},
                                    1000.0,
                                ]
                            },
                            "else": {"$ifNull": ["$duration", 0]},
                        }
                    }
                }
            },
            {
                "$project": {
                    "transactionId": 1,
                    "startTime": 1,
                    "endTime": 1,
                    "duration": "$duration_seconds",
                    "distance": 1,
                    "startLocation": 1,
                    "destination": 1,
                    "maxSpeed": 1,
                    "totalIdleDuration": 1,
                    "fuelConsumed": 1,
                    "timeZone": 1,
                }
            },
            {"$sort": {"startTime": -1}},
            {"$limit": 100},
        ]

        trips = await aggregate_with_retry(trips_collection, pipeline)

        return JSONResponse(content=serialize_for_json(trips))

    except Exception as e:
        logger.exception("Error fetching time period trips: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/driver-behavior")
async def driver_behavior_analytics(request: Request):
    """Aggregate driving behavior statistics within optional date range filters.

    Accepts the same `start_date` and `end_date` query parameters used by other API endpoints.
    If no filters are provided, all trips are considered (back-compat).
    """
    # Build the Mongo query using the shared helper so filters stay consistent app-wide
    try:
        query = await build_query_from_request(request)
    except Exception as e:
        logger.exception("Failed to build query for driver behavior analytics: %s", e)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    try:
        tz_expr = {
            "$switch": {
                "branches": [
                    {"case": {"$in": ["$timeZone", ["", "0000"]]}, "then": "UTC"}
                ],
                "default": {"$ifNull": ["$timeZone", "UTC"]},
            }
        }

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

        results = await aggregate_with_retry(trips_collection, pipeline)
        if not results:
            payload = {
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
            return JSONResponse(content=payload)

        combined = results[0]
        return JSONResponse(content=serialize_for_json(combined))
    except Exception as e:
        logger.exception("Error aggregating driver behavior analytics: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


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

        return JSONResponse(content=serialize_for_json(combined))
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

            base_date = datetime.now(UTC).replace(
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
        logger.exception("Error in get_metrics: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
