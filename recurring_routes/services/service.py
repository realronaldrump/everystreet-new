"""Recurring routes query helpers used by the API layer."""

from __future__ import annotations

import re
from typing import Any

from core.serialization import serialize_datetime
from db.models import RecurringRoute

_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


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


def serialize_route_summary(route: RecurringRoute) -> dict[str, Any]:
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
        "last_start_time": serialize_datetime(route.last_start_time),
        "updated_at": serialize_datetime(route.updated_at),
        "distance_miles_median": route.distance_miles_median,
        "duration_sec_median": route.duration_sec_median,
    }


def serialize_route_detail(route: RecurringRoute) -> dict[str, Any]:
    data = route.model_dump()
    data["id"] = str(route.id) if route.id else None
    data["display_name"] = route_display_name(route)
    data["first_start_time"] = serialize_datetime(route.first_start_time)
    data["last_start_time"] = serialize_datetime(route.last_start_time)
    data["updated_at"] = serialize_datetime(route.updated_at)
    return data
