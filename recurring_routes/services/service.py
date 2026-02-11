"""Recurring routes query helpers used by the API layer."""

from __future__ import annotations

import re
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Any

from beanie import PydanticObjectId

from core.serialization import serialize_datetime
from core.spatial import GeometryService
from db.models import Place, RecurringRoute, Trip
from recurring_routes.services.fingerprint import extract_display_label

try:
    from shapely.geometry import (
        Point as ShapelyPoint,
        shape as shapely_shape,
    )
except Exception:  # pragma: no cover - shapely may be unavailable in some envs
    ShapelyPoint = None
    shapely_shape = None

_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_PLACE_POINT_TOLERANCE_METERS = 120.0


def _to_utc_datetime(value: Any) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _sunday_week_start(value: datetime) -> datetime:
    day_start = datetime(value.year, value.month, value.day, tzinfo=value.tzinfo)
    days_since_sunday = (day_start.weekday() + 1) % 7
    return day_start - timedelta(days=days_since_sunday)


def compute_trips_per_week(
    *,
    total_trips: Any,
    first_trip: Any,
    last_trip: Any,
) -> float | None:
    try:
        trip_count = float(total_trips)
    except Exception:
        return None
    if trip_count <= 0:
        return None

    first_dt = _to_utc_datetime(first_trip)
    last_dt = _to_utc_datetime(last_trip)
    if first_dt is None and last_dt is None:
        return None
    if first_dt is None:
        first_dt = last_dt
    if last_dt is None:
        last_dt = first_dt
    if first_dt is None or last_dt is None:
        return None

    if last_dt < first_dt:
        first_dt, last_dt = last_dt, first_dt

    first_week_start = _sunday_week_start(first_dt)
    last_week_start = _sunday_week_start(last_dt)
    covered_weeks = ((last_week_start - first_week_start).days // 7) + 1
    return round(trip_count / max(covered_weeks, 1), 2)


def normalize_hex_color(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    if not cleaned.startswith("#"):
        cleaned = f"#{cleaned}"
    return cleaned if _HEX_COLOR_RE.match(cleaned) else None


def route_display_name(route: RecurringRoute) -> str:
    name = (route.name or "").strip()
    if name:
        return name
    auto = (route.auto_name or "").strip()
    return auto or "Route"


def _route_place_id(route: RecurringRoute, *field_names: str) -> str | None:
    for field in field_names:
        place_id = coerce_place_id(getattr(route, field, None))
        if place_id:
            return place_id
    return None


def serialize_route_summary(route: RecurringRoute) -> dict[str, Any]:
    start_place_id = _route_place_id(route, "start_place_id", "startPlaceId")
    end_place_id = _route_place_id(route, "end_place_id", "endPlaceId")
    return {
        "id": str(route.id) if route.id else None,
        "route_key": route.route_key,
        "display_name": route_display_name(route),
        "name": route.name,
        "auto_name": route.auto_name,
        "start_label": route.start_label,
        "end_label": route.end_label,
        "trip_count": route.trip_count,
        "is_recurring": bool(route.is_recurring),
        "is_pinned": bool(route.is_pinned),
        "is_hidden": bool(route.is_hidden),
        "color": route.color,
        "preview_svg_path": route.preview_svg_path,
        "first_start_time": serialize_datetime(route.first_start_time),
        "last_start_time": serialize_datetime(route.last_start_time),
        "updated_at": serialize_datetime(route.updated_at),
        "distance_miles_median": route.distance_miles_median,
        "distance_miles_avg": route.distance_miles_avg,
        "duration_sec_median": route.duration_sec_median,
        "duration_sec_avg": route.duration_sec_avg,
        "fuel_gal_avg": route.fuel_gal_avg,
        "cost_usd_avg": route.cost_usd_avg,
        "start_place_id": start_place_id,
        "end_place_id": end_place_id,
    }


def serialize_route_detail(route: RecurringRoute) -> dict[str, Any]:
    data = route.model_dump()
    data["id"] = str(route.id) if route.id else None
    data["display_name"] = route_display_name(route)
    data["start_place_id"] = _route_place_id(route, "start_place_id", "startPlaceId")
    data["end_place_id"] = _route_place_id(route, "end_place_id", "endPlaceId")
    data["first_start_time"] = serialize_datetime(route.first_start_time)
    data["last_start_time"] = serialize_datetime(route.last_start_time)
    data["updated_at"] = serialize_datetime(route.updated_at)
    # Compute days active span
    if route.first_start_time and route.last_start_time:
        span = (route.last_start_time - route.first_start_time).days
        data["days_active"] = max(span, 1)
    else:
        data["days_active"] = None
    return data


def coerce_place_id(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned if cleaned else None


def extract_point_from_geojson_point(value: Any) -> list[float] | None:
    if not isinstance(value, dict):
        return None
    if value.get("type") != "Point":
        return None
    valid, pair = GeometryService.validate_coordinate_pair(value.get("coordinates") or [])
    return pair if valid and pair else None


def extract_location_label(value: Any) -> str | None:
    return extract_display_label(value)


def _point_matches_place_geometry(place: Place, point: list[float]) -> bool:
    geometry = place.geometry
    if not isinstance(geometry, dict):
        return False

    geom_type = geometry.get("type")
    if geom_type == "Point":
        valid, place_point = GeometryService.validate_coordinate_pair(
            geometry.get("coordinates") or [],
        )
        if not valid or not place_point:
            return False
        dist_m = GeometryService.haversine_distance(
            point[0],
            point[1],
            place_point[0],
            place_point[1],
            unit="meters",
        )
        return dist_m <= _PLACE_POINT_TOLERANCE_METERS

    if not ShapelyPoint or not shapely_shape:
        return False

    try:
        geom = shapely_shape(geometry)
        pt = ShapelyPoint(point[0], point[1])
    except Exception:
        return False

    try:
        return bool(geom.covers(pt))
    except Exception:
        return False


def find_place_id_for_point(point: Any, places: list[Place]) -> str | None:
    valid, pair = GeometryService.validate_coordinate_pair(point if isinstance(point, list | tuple) else [])
    if not valid or not pair:
        return None

    for place in places:
        if not place.id:
            continue
        if _point_matches_place_geometry(place, pair):
            return str(place.id)

    return None


async def resolve_places_by_ids(place_ids: set[str]) -> dict[str, Place]:
    oids: list[PydanticObjectId] = []
    for raw in place_ids:
        place_id = coerce_place_id(raw)
        if not place_id:
            continue
        try:
            oids.append(PydanticObjectId(place_id))
        except Exception:
            continue

    if not oids:
        return {}

    places = await Place.find({"_id": {"$in": oids}}).to_list()
    return {
        str(place.id): place
        for place in places
        if place.id is not None
    }


def build_place_link(
    place_id: str | None,
    *,
    places_by_id: dict[str, Place],
    fallback_label: str | None = None,
) -> dict[str, Any] | None:
    cleaned_id = coerce_place_id(place_id)
    if not cleaned_id:
        return None

    place = places_by_id.get(cleaned_id)
    if not place or not place.id:
        return None

    label = (place.name or "").strip() or (fallback_label or "").strip() or cleaned_id
    return {
        "id": cleaned_id,
        "name": place.name,
        "label": label,
        "href": f"/places/{cleaned_id}",
    }


async def resolve_route_place_links(route: RecurringRoute) -> dict[str, Any]:
    links: dict[str, Any] = {"start": None, "end": None}
    start_place_id = _route_place_id(route, "start_place_id", "startPlaceId")
    end_place_id = _route_place_id(route, "end_place_id", "endPlaceId")

    place_ids: set[str] = set()
    if start_place_id:
        place_ids.add(start_place_id)
    if end_place_id:
        place_ids.add(end_place_id)

    start_counts: Counter[str] = Counter()
    end_counts: Counter[str] = Counter()

    if route.id and (not start_place_id or not end_place_id):
        trips = (
            await Trip.find({"recurringRouteId": route.id, "invalid": {"$ne": True}})
            .sort("-startTime")
            .limit(300)
            .to_list()
        )

        for trip in trips:
            trip_data = trip.model_dump()
            start_id = coerce_place_id(trip_data.get("startPlaceId"))
            end_id = coerce_place_id(trip_data.get("destinationPlaceId"))
            if start_id:
                start_counts[start_id] += 1
                place_ids.add(start_id)
            if end_id:
                end_counts[end_id] += 1
                place_ids.add(end_id)

        if not start_place_id and start_counts:
            start_place_id = start_counts.most_common(1)[0][0]
        if not end_place_id and end_counts:
            end_place_id = end_counts.most_common(1)[0][0]

    if (
        (not start_place_id and isinstance(route.start_centroid, list) and route.start_centroid)
        or (not end_place_id and isinstance(route.end_centroid, list) and route.end_centroid)
    ):
        places = await Place.find_all().to_list()
        if not start_place_id:
            start_place_id = find_place_id_for_point(route.start_centroid, places)
        if not end_place_id:
            end_place_id = find_place_id_for_point(route.end_centroid, places)
        if start_place_id:
            place_ids.add(start_place_id)
        if end_place_id:
            place_ids.add(end_place_id)

    places_by_id = await resolve_places_by_ids(place_ids)
    links["start"] = build_place_link(
        start_place_id,
        places_by_id=places_by_id,
        fallback_label=route.start_label,
    )
    links["end"] = build_place_link(
        end_place_id,
        places_by_id=places_by_id,
        fallback_label=route.end_label,
    )
    return links


async def serialize_route_detail_with_place_links(route: RecurringRoute) -> dict[str, Any]:
    data = serialize_route_detail(route)
    data["place_links"] = await resolve_route_place_links(route)
    return data
