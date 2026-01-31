"""
Shared OSM filtering helpers for coverage and routing.

Keeps driveable highway classification consistent across the pipeline.
"""

from __future__ import annotations

from typing import Any

DRIVEABLE_HIGHWAY_TYPES = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
    "living_street",
    "service",
}


def normalize_tag_values(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value if item is not None]
    return [str(value)]


def get_driveable_highway(value: Any) -> str | None:
    for item in normalize_tag_values(value):
        if item in DRIVEABLE_HIGHWAY_TYPES:
            return item
    return None
