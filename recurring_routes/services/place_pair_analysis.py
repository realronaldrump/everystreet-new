"""Place-pair analysis for recurring routes."""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

from beanie import PydanticObjectId

from core.spatial import GeometryService
from db.aggregation_utils import get_mongo_tz_expr
from db.models import Place, RecurringRoute, Trip
from recurring_routes.services.fingerprint import (
    build_preview_svg_path,
    compute_route_key,
    compute_route_signature,
    extract_polyline,
)
from recurring_routes.services.service import (
    build_place_link,
    coerce_place_id,
    extract_location_label,
    extract_point_from_geojson_point,
    find_place_id_for_point,
    resolve_places_by_ids,
    route_display_name,
)

_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
_OFFSET_RE = re.compile(r"^([+-])(\d{2}):?(\d{2})$")


def _to_float(value: Any) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, dict):
        raw = value.get("value")
        if isinstance(raw, int | float):
            return float(raw)
    return None


def _serialize_dt(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    if value is None:
        return None
    try:
        return str(value)
    except Exception:
        return None


def _hour_buckets() -> list[dict[str, Any]]:
    return [{"hour": h, "count": 0, "avgDistance": None, "avgDuration": None} for h in range(24)]


def _day_buckets() -> list[dict[str, Any]]:
    return [
        {
            "day": d,
            "dayName": _DAY_NAMES[d - 1],
            "count": 0,
            "avgDistance": None,
            "avgDuration": None,
        }
        for d in range(1, 8)
    ]


def _normalize_tzinfo(value: Any) -> timezone | ZoneInfo:
    raw = str(value or "").strip()
    if not raw or raw in {"0000", "UTC", "GMT"}:
        return timezone.utc

    offset_match = _OFFSET_RE.match(raw)
    if offset_match:
        sign, hh, mm = offset_match.groups()
        mins = (int(hh) * 60) + int(mm)
        if sign == "-":
            mins *= -1
        return timezone(timedelta(minutes=mins))

    try:
        return ZoneInfo(raw)
    except Exception:
        return timezone.utc


def _to_local_start_dt(trip: dict[str, Any]) -> datetime | None:
    dt = trip.get("startTime")
    if not isinstance(dt, datetime):
        return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    tz = _normalize_tzinfo(trip.get("startTimeZone") or trip.get("timeZone"))
    try:
        return dt.astimezone(tz)
    except Exception:
        return dt.astimezone(timezone.utc)


def _extract_trip_endpoint_point(
    trip: dict[str, Any],
    *,
    point_field: str,
    endpoint: str,
) -> list[float] | None:
    point = extract_point_from_geojson_point(trip.get(point_field))
    if point:
        return point

    polyline = extract_polyline(trip)
    if len(polyline) < 2:
        return None

    candidate = polyline[0] if endpoint == "start" else polyline[-1]
    valid, pair = GeometryService.validate_coordinate_pair(candidate)
    if valid and pair:
        return pair
    return None


def _match_endpoint(
    trip: dict[str, Any],
    *,
    place: Place,
    point_field: str,
    endpoint: str,
    id_fields: tuple[str, ...],
) -> tuple[bool, str | None]:
    if not place.id:
        return False, None

    place_id = str(place.id)

    for field in id_fields:
        trip_place_id = coerce_place_id(trip.get(field))
        if trip_place_id and trip_place_id == place_id:
            return True, place_id

    point = _extract_trip_endpoint_point(
        trip,
        point_field=point_field,
        endpoint=endpoint,
    )
    if point:
        matched = find_place_id_for_point(point, [place])
        if matched and matched == place_id:
            return True, place_id

    return False, None


def _resolve_endpoint_place_id(
    trip: dict[str, Any],
    *,
    point_field: str,
    endpoint: str,
    id_fields: tuple[str, ...],
    candidate_places: list[Place],
) -> str | None:
    candidate_ids = {str(place.id) for place in candidate_places if place.id}
    for field in id_fields:
        place_id = coerce_place_id(trip.get(field))
        if place_id and place_id in candidate_ids:
            return place_id

    point = _extract_trip_endpoint_point(
        trip,
        point_field=point_field,
        endpoint=endpoint,
    )
    if point:
        return find_place_id_for_point(point, candidate_places)

    return None


def _match_place_pair(
    trip: dict[str, Any],
    *,
    start_place: Place,
    end_place: Place,
    include_reverse: bool,
) -> tuple[bool, str | None, str | None, str | None]:
    start_ok, _ = _match_endpoint(
        trip,
        place=start_place,
        point_field="startGeoPoint",
        endpoint="start",
        id_fields=("startPlaceId", "start_place_id"),
    )
    end_ok, _ = _match_endpoint(
        trip,
        place=end_place,
        point_field="destinationGeoPoint",
        endpoint="end",
        id_fields=("destinationPlaceId", "endPlaceId", "destination_place_id", "end_place_id"),
    )
    if start_ok and end_ok:
        start_id = _resolve_endpoint_place_id(
            trip,
            point_field="startGeoPoint",
            endpoint="start",
            id_fields=("startPlaceId", "start_place_id"),
            candidate_places=[start_place, end_place],
        )
        end_id = _resolve_endpoint_place_id(
            trip,
            point_field="destinationGeoPoint",
            endpoint="end",
            id_fields=(
                "destinationPlaceId",
                "endPlaceId",
                "destination_place_id",
                "end_place_id",
            ),
            candidate_places=[start_place, end_place],
        )
        return True, "forward", start_id, end_id

    if not include_reverse:
        return False, None, None, None

    rev_start_ok, _ = _match_endpoint(
        trip,
        place=end_place,
        point_field="startGeoPoint",
        endpoint="start",
        id_fields=("startPlaceId", "start_place_id"),
    )
    rev_end_ok, _ = _match_endpoint(
        trip,
        place=start_place,
        point_field="destinationGeoPoint",
        endpoint="end",
        id_fields=("destinationPlaceId", "endPlaceId", "destination_place_id", "end_place_id"),
    )
    if rev_start_ok and rev_end_ok:
        start_id = _resolve_endpoint_place_id(
            trip,
            point_field="startGeoPoint",
            endpoint="start",
            id_fields=("startPlaceId", "start_place_id"),
            candidate_places=[start_place, end_place],
        )
        end_id = _resolve_endpoint_place_id(
            trip,
            point_field="destinationGeoPoint",
            endpoint="end",
            id_fields=(
                "destinationPlaceId",
                "endPlaceId",
                "destination_place_id",
                "end_place_id",
            ),
            candidate_places=[start_place, end_place],
        )
        return True, "reverse", start_id, end_id

    return False, None, None, None


async def _load_routes_by_id(route_ids: set[str]) -> dict[str, RecurringRoute]:
    oids: list[PydanticObjectId] = []
    for route_id in route_ids:
        try:
            oids.append(PydanticObjectId(route_id))
        except Exception:
            continue

    if not oids:
        return {}

    routes = await RecurringRoute.find({"_id": {"$in": oids}}).to_list()
    return {
        str(route.id): route
        for route in routes
        if route.id is not None
    }


async def _aggregate_facets_for_trip_ids(trip_ids: list[Any]) -> dict[str, Any]:
    if not trip_ids:
        return {}

    tz_expr = get_mongo_tz_expr()
    pipeline = [
        {"$match": {"_id": {"$in": trip_ids}}},
        {
            "$project": {
                "startTime": 1,
                "distance": 1,
                "duration": 1,
                "hour": {"$hour": {"date": "$startTime", "timezone": tz_expr}},
                "dayOfWeek": {
                    "$dayOfWeek": {"date": "$startTime", "timezone": tz_expr},
                },
                "yearMonth": {
                    "$dateToString": {
                        "format": "%Y-%m",
                        "date": "$startTime",
                        "timezone": tz_expr,
                    },
                },
            },
        },
        {
            "$facet": {
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
                "byMonth": [
                    {
                        "$group": {
                            "_id": "$yearMonth",
                            "count": {"$sum": 1},
                            "totalDistance": {"$sum": "$distance"},
                            "avgDistance": {"$avg": "$distance"},
                            "avgDuration": {"$avg": "$duration"},
                        },
                    },
                    {"$sort": {"_id": 1}},
                ],
                "stats": [
                    {
                        "$group": {
                            "_id": None,
                            "totalTrips": {"$sum": 1},
                            "totalDistance": {"$sum": "$distance"},
                            "totalDuration": {"$sum": "$duration"},
                            "avgDistance": {"$avg": "$distance"},
                            "avgDuration": {"$avg": "$duration"},
                            "firstTrip": {"$min": "$startTime"},
                            "lastTrip": {"$max": "$startTime"},
                        },
                    },
                ],
            },
        },
    ]

    try:
        result = await Trip.get_pymongo_collection().aggregate(pipeline).to_list(1)
    except Exception:
        return {}

    return result[0] if result else {}


def _fallback_facets(trips: list[dict[str, Any]]) -> dict[str, Any]:
    by_hour: defaultdict[int, dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "dist": 0.0, "dur": 0.0, "distN": 0, "durN": 0},
    )
    by_dow: defaultdict[int, dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "dist": 0.0, "dur": 0.0, "distN": 0, "durN": 0},
    )
    by_month: defaultdict[str, dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "totalDistance": 0.0, "distN": 0, "dur": 0.0, "durN": 0},
    )

    total_distance = 0.0
    total_duration = 0.0
    distance_n = 0
    duration_n = 0
    first_trip: datetime | None = None
    last_trip: datetime | None = None

    for trip in trips:
        local_dt = _to_local_start_dt(trip)
        if local_dt is None:
            continue

        hour = int(local_dt.hour)
        dow = ((local_dt.weekday() + 1) % 7) + 1  # Sunday=1 ... Saturday=7
        month_key = local_dt.strftime("%Y-%m")

        dist = _to_float(trip.get("distance"))
        dur = _to_float(trip.get("duration"))

        by_hour[hour]["count"] += 1
        by_dow[dow]["count"] += 1
        by_month[month_key]["count"] += 1

        if dist is not None:
            by_hour[hour]["dist"] += dist
            by_hour[hour]["distN"] += 1
            by_dow[dow]["dist"] += dist
            by_dow[dow]["distN"] += 1
            by_month[month_key]["totalDistance"] += dist
            by_month[month_key]["distN"] += 1
            total_distance += dist
            distance_n += 1

        if dur is not None:
            by_hour[hour]["dur"] += dur
            by_hour[hour]["durN"] += 1
            by_dow[dow]["dur"] += dur
            by_dow[dow]["durN"] += 1
            by_month[month_key]["dur"] += dur
            by_month[month_key]["durN"] += 1
            total_duration += dur
            duration_n += 1

        raw_start = trip.get("startTime")
        if isinstance(raw_start, datetime):
            first_trip = raw_start if first_trip is None or raw_start < first_trip else first_trip
            last_trip = raw_start if last_trip is None or raw_start > last_trip else last_trip

    by_hour_out = []
    for h in range(24):
        entry = by_hour[h]
        by_hour_out.append(
            {
                "_id": h,
                "count": entry["count"],
                "avgDistance": (entry["dist"] / entry["distN"]) if entry["distN"] else None,
                "avgDuration": (entry["dur"] / entry["durN"]) if entry["durN"] else None,
            },
        )

    by_dow_out = []
    for d in range(1, 8):
        entry = by_dow[d]
        by_dow_out.append(
            {
                "_id": d,
                "count": entry["count"],
                "avgDistance": (entry["dist"] / entry["distN"]) if entry["distN"] else None,
                "avgDuration": (entry["dur"] / entry["durN"]) if entry["durN"] else None,
            },
        )

    by_month_out = []
    for key in sorted(by_month.keys()):
        entry = by_month[key]
        by_month_out.append(
            {
                "_id": key,
                "count": entry["count"],
                "totalDistance": entry["totalDistance"],
                "avgDistance": (entry["totalDistance"] / entry["distN"]) if entry["distN"] else None,
                "avgDuration": (entry["dur"] / entry["durN"]) if entry["durN"] else None,
            },
        )

    return {
        "byHour": by_hour_out,
        "byDayOfWeek": by_dow_out,
        "byMonth": by_month_out,
        "stats": [
            {
                "totalTrips": len(trips),
                "totalDistance": total_distance,
                "totalDuration": total_duration,
                "avgDistance": (total_distance / distance_n) if distance_n else None,
                "avgDuration": (total_duration / duration_n) if duration_n else None,
                "firstTrip": first_trip,
                "lastTrip": last_trip,
            },
        ],
    }


def _build_variants(
    trips: list[dict[str, Any]],
    routes_by_id: dict[str, RecurringRoute],
) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}

    for trip in trips:
        route_id = coerce_place_id(trip.get("recurringRouteId"))
        route = routes_by_id.get(route_id or "")
        route_signature = None
        route_key = None

        if route_id:
            group_key = f"route:{route_id}"
        else:
            route_signature = compute_route_signature(trip, {})
            route_key = compute_route_key(route_signature) if route_signature else None
            group_key = f"fingerprint:{route_key}" if route_key else "fingerprint:unclassified"

        group = groups.get(group_key)
        if group is None:
            group = {
                "variant_key": group_key,
                "route_id": route_id,
                "route_key": route_key,
                "route_signature": route_signature,
                "label": route_display_name(route) if route else None,
                "trip_count": 0,
                "distances": [],
                "durations": [],
                "first_start_time": None,
                "last_start_time": None,
                "representative_geometry": None,
                "preview_path": None,
                "sample_trip_id": None,
            }
            groups[group_key] = group

        group["trip_count"] += 1
        dist = _to_float(trip.get("distance"))
        if dist is not None:
            group["distances"].append(dist)

        duration = _to_float(trip.get("duration"))
        if duration is not None:
            group["durations"].append(duration)

        start_time = trip.get("startTime")
        if isinstance(start_time, datetime):
            first = group.get("first_start_time")
            last = group.get("last_start_time")
            if first is None or start_time < first:
                group["first_start_time"] = start_time
            if last is None or start_time > last:
                group["last_start_time"] = start_time

        if group.get("sample_trip_id") is None:
            tx = trip.get("transactionId")
            if tx is not None:
                group["sample_trip_id"] = str(tx)

        if group.get("representative_geometry") is None:
            rep_geom = trip.get("matchedGps") or trip.get("gps")
            if isinstance(rep_geom, dict):
                group["representative_geometry"] = rep_geom
                group["preview_path"] = build_preview_svg_path(rep_geom)

    variants: list[dict[str, Any]] = []
    total_trip_count = sum(int(group.get("trip_count") or 0) for group in groups.values())

    for group in groups.values():
        route = routes_by_id.get(group.get("route_id") or "")
        route_geometry = route.geometry if route else None
        representative_geometry = route_geometry or group.get("representative_geometry")
        preview_path = (
            route.preview_svg_path
            if route and route.preview_svg_path
            else group.get("preview_path") or build_preview_svg_path(representative_geometry)
        )
        distances = [float(v) for v in group.get("distances", []) if isinstance(v, int | float)]
        durations = [float(v) for v in group.get("durations", []) if isinstance(v, int | float)]
        trip_count = int(group.get("trip_count") or 0)
        variants.append(
            {
                "variant_key": group["variant_key"],
                "route_id": group.get("route_id"),
                "route_key": (
                    route.route_key
                    if route is not None
                    else group.get("route_key")
                ),
                "route_signature": group.get("route_signature"),
                "display_name": route_display_name(route) if route else group.get("label"),
                "label": route_display_name(route) if route else group.get("label"),
                "trip_count": trip_count,
                "share": (trip_count / total_trip_count) if total_trip_count > 0 else 0.0,
                "median_distance": median(distances) if distances else None,
                "median_duration": median(durations) if durations else None,
                "avgDistance": (sum(distances) / len(distances)) if distances else None,
                "avgDuration": (sum(durations) / len(durations)) if durations else None,
                "first_trip": _serialize_dt(group.get("first_start_time")),
                "last_trip": _serialize_dt(group.get("last_start_time")),
                "firstStartTime": _serialize_dt(group.get("first_start_time")),
                "lastStartTime": _serialize_dt(group.get("last_start_time")),
                "sample_trip_id": group.get("sample_trip_id"),
                "representative_geometry": representative_geometry,
                "preview_path": preview_path,
            },
        )

    variants.sort(
        key=lambda item: (
            int(item.get("trip_count") or 0),
            str(item.get("lastStartTime") or ""),
        ),
        reverse=True,
    )
    return variants


def _to_sample_trip(
    trip: dict[str, Any],
    *,
    places_by_id: dict[str, Place],
) -> dict[str, Any]:
    route_id = coerce_place_id(trip.get("recurringRouteId"))

    start_place_id = (
        coerce_place_id(trip.get("startPlaceId"))
        or coerce_place_id(trip.get("_resolvedStartPlaceId"))
    )
    destination_place_id = (
        coerce_place_id(trip.get("destinationPlaceId"))
        or coerce_place_id(trip.get("_resolvedEndPlaceId"))
    )

    start_label = extract_location_label(trip.get("startLocation"))
    end_label = (
        str(trip.get("destinationPlaceName") or "").strip()
        or extract_location_label(trip.get("destination"))
    )

    start_link = build_place_link(
        start_place_id,
        places_by_id=places_by_id,
        fallback_label=start_label,
    )
    end_link = build_place_link(
        destination_place_id,
        places_by_id=places_by_id,
        fallback_label=end_label,
    )

    return {
        "transactionId": trip.get("transactionId"),
        "startTime": _serialize_dt(trip.get("startTime")),
        "endTime": _serialize_dt(trip.get("endTime")),
        "distance": trip.get("distance"),
        "duration": trip.get("duration"),
        "route_id": route_id,
        "direction": trip.get("_matchedDirection"),
        "startPlaceId": start_place_id,
        "destinationPlaceId": destination_place_id,
        "startPlaceLabel": start_link.get("label") if start_link else start_label,
        "destinationPlaceLabel": end_link.get("label") if end_link else end_label,
        "place_links": {
            "start": start_link,
            "end": end_link,
        },
    }


async def analyze_place_pair(
    *,
    start_place_id: str,
    end_place_id: str,
    include_reverse: bool,
    timeframe: str,
    limit: int,
) -> dict[str, Any]:
    try:
        start_oid = PydanticObjectId(start_place_id)
        end_oid = PydanticObjectId(end_place_id)
    except Exception as exc:
        raise ValueError("Invalid place id") from exc

    start_place = await Place.get(start_oid)
    end_place = await Place.get(end_oid)
    if not start_place or not end_place:
        raise LookupError("Place not found")

    requested_timeframe = str(timeframe or "all").strip().lower()
    effective_timeframe = "all"
    sample_limit = min(max(int(limit), 1), 500)

    query: dict[str, Any] = {"invalid": {"$ne": True}}

    trips_coll = Trip.get_pymongo_collection()
    cursor = trips_coll.find(
        query,
        {
            "_id": 1,
            "transactionId": 1,
            "startTime": 1,
            "endTime": 1,
            "startTimeZone": 1,
            "timeZone": 1,
            "distance": 1,
            "duration": 1,
            "startLocation": 1,
            "destination": 1,
            "destinationPlaceName": 1,
            "startPlaceId": 1,
            "destinationPlaceId": 1,
            "startGeoPoint": 1,
            "destinationGeoPoint": 1,
            "recurringRouteId": 1,
            "matchedGps": 1,
            "gps": 1,
        },
    ).sort("startTime", -1)

    matched_trips: list[dict[str, Any]] = []
    scanned = 0
    async for trip_doc in cursor:
        scanned += 1

        matched, direction, resolved_start_id, resolved_end_id = _match_place_pair(
            trip_doc,
            start_place=start_place,
            end_place=end_place,
            include_reverse=include_reverse,
        )
        if matched:
            trip_doc["_matchedDirection"] = direction
            trip_doc["_resolvedStartPlaceId"] = resolved_start_id
            trip_doc["_resolvedEndPlaceId"] = resolved_end_id
            matched_trips.append(trip_doc)

    places_by_id = {
        str(start_place.id): start_place,
        str(end_place.id): end_place,
    }
    start_link = build_place_link(
        str(start_place.id),
        places_by_id=places_by_id,
        fallback_label=start_place.name,
    )
    end_link = build_place_link(
        str(end_place.id),
        places_by_id=places_by_id,
        fallback_label=end_place.name,
    )

    if not matched_trips:
        summary = {
            "trip_count": 0,
            "variant_count": 0,
            "median_distance": None,
            "median_duration": None,
            "trips_per_week": None,
            "first_trip": None,
            "last_trip": None,
            # Backward-compatible aliases
            "totalTrips": 0,
            "totalDistance": 0,
            "totalDuration": 0,
            "avgDistance": None,
            "avgDuration": None,
            "firstTrip": None,
            "lastTrip": None,
        }
        return {
            "status": "success",
            "start_place": start_link,
            "end_place": end_link,
            "include_reverse": include_reverse,
            "timeframe": effective_timeframe,
            "query": {
                "start_place_id": start_place_id,
                "end_place_id": end_place_id,
                "include_reverse": include_reverse,
                "requested_timeframe": requested_timeframe,
                "timeframe": effective_timeframe,
                "sample_limit": sample_limit,
                "scanned": scanned,
                "matched": 0,
            },
            "places": {
                "start": start_link,
                "end": end_link,
            },
            "summary": summary,
            "tripsPerWeek": None,
            "byHour": _hour_buckets(),
            "byDayOfWeek": _day_buckets(),
            "byMonth": [],
            "variants": [],
            "sampleTrips": [],
        }

    route_ids = {
        route_id
        for route_id in (coerce_place_id(doc.get("recurringRouteId")) for doc in matched_trips)
        if route_id
    }
    routes_by_id = await _load_routes_by_id(route_ids)

    trip_ids = [doc.get("_id") for doc in matched_trips if doc.get("_id") is not None]
    facets = (
        await _aggregate_facets_for_trip_ids(trip_ids)
        if 0 < len(trip_ids) <= 4000
        else {}
    )
    if not facets:
        facets = _fallback_facets(matched_trips)

    hour_map = {item.get("_id"): item for item in facets.get("byHour", [])}
    by_hour: list[dict[str, Any]] = []
    for h in range(24):
        item = hour_map.get(h, {})
        by_hour.append(
            {
                "hour": h,
                "count": item.get("count", 0),
                "avgDistance": item.get("avgDistance"),
                "avgDuration": item.get("avgDuration"),
            },
        )

    dow_map = {item.get("_id"): item for item in facets.get("byDayOfWeek", [])}
    by_day: list[dict[str, Any]] = []
    for d in range(1, 8):
        item = dow_map.get(d, {})
        by_day.append(
            {
                "day": d,
                "dayName": _DAY_NAMES[d - 1],
                "count": item.get("count", 0),
                "avgDistance": item.get("avgDistance"),
                "avgDuration": item.get("avgDuration"),
            },
        )

    stats = facets.get("stats", [{}])[0] if facets.get("stats") else {}
    stats.pop("_id", None)
    first_trip = stats.get("firstTrip")
    last_trip = stats.get("lastTrip")
    if first_trip:
        stats["firstTrip"] = _serialize_dt(first_trip)
    if last_trip:
        stats["lastTrip"] = _serialize_dt(last_trip)

    trips_per_week = None
    if isinstance(first_trip, datetime) and isinstance(last_trip, datetime):
        span_days = (last_trip - first_trip).total_seconds() / 86400
        total_trips = int(stats.get("totalTrips") or 0)
        if span_days > 0 and total_trips > 1:
            trips_per_week = round((total_trips / span_days) * 7, 2)

    variants = _build_variants(matched_trips, routes_by_id)
    variant_count = len(variants)

    distance_values = [
        value for value in (_to_float(trip.get("distance")) for trip in matched_trips) if value is not None
    ]
    duration_values = [
        value for value in (_to_float(trip.get("duration")) for trip in matched_trips) if value is not None
    ]

    month_items = []
    for item in facets.get("byMonth", []):
        month_id = item.get("_id")
        month_items.append(
            {
                "_id": month_id,
                "month": month_id,
                "count": item.get("count", 0),
                "totalDistance": item.get("totalDistance"),
                "avgDistance": item.get("avgDistance"),
                "avgDuration": item.get("avgDuration"),
            },
        )

    sample_size = min(len(matched_trips), sample_limit)
    sample_trips = [
        _to_sample_trip(doc, places_by_id=places_by_id)
        for doc in matched_trips[:sample_size]
    ]

    summary = {
        "trip_count": int(stats.get("totalTrips") or len(matched_trips)),
        "variant_count": variant_count,
        "median_distance": median(distance_values) if distance_values else None,
        "median_duration": median(duration_values) if duration_values else None,
        "trips_per_week": trips_per_week,
        "first_trip": _serialize_dt(first_trip),
        "last_trip": _serialize_dt(last_trip),
        # Backward-compatible aliases
        "totalTrips": int(stats.get("totalTrips") or len(matched_trips)),
        "totalDistance": stats.get("totalDistance"),
        "totalDuration": stats.get("totalDuration"),
        "avgDistance": stats.get("avgDistance"),
        "avgDuration": stats.get("avgDuration"),
        "firstTrip": _serialize_dt(first_trip),
        "lastTrip": _serialize_dt(last_trip),
    }

    return {
        "status": "success",
        "start_place": start_link,
        "end_place": end_link,
        "include_reverse": include_reverse,
        "timeframe": effective_timeframe,
        "query": {
            "start_place_id": start_place_id,
            "end_place_id": end_place_id,
            "include_reverse": include_reverse,
            "requested_timeframe": requested_timeframe,
            "timeframe": effective_timeframe,
            "sample_limit": sample_limit,
            "scanned": scanned,
            "matched": len(matched_trips),
        },
        "places": {
            "start": start_link,
            "end": end_link,
        },
        "summary": summary,
        "tripsPerWeek": trips_per_week,
        "byHour": by_hour,
        "byDayOfWeek": by_day,
        "byMonth": month_items,
        "variants": variants,
        "sampleTrips": sample_trips,
    }
