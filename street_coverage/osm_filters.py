"""Legacy OSM filtering compatibility helpers.

Public-road filtering now lives in ``street_coverage.public_road_filter``.
This module remains as a backwards-compatible adapter.
"""

from __future__ import annotations

from typing import Any

from street_coverage.public_road_filter import (
    LEGACY_DRIVEABLE_HIGHWAY_TYPES as DRIVEABLE_HIGHWAY_TYPES,
)


def normalize_tag_values(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list | tuple | set):
        return [str(item).strip().lower() for item in value if item is not None]
    raw = str(value)
    if ";" not in raw:
        token = raw.strip().lower()
        return [token] if token else []
    values: list[str] = []
    for part in raw.split(";"):
        token = part.strip().lower()
        if token:
            values.append(token)
    return values


def get_driveable_highway(value: Any) -> str | None:
    for item in normalize_tag_values(value):
        if item in DRIVEABLE_HIGHWAY_TYPES:
            return item
    return None
