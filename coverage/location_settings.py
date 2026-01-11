"""Helpers for coverage location settings and unit normalization."""

from __future__ import annotations

from typing import Any

FEET_TO_METERS = 0.3048

DEFAULT_SEGMENT_LENGTH_FEET = 150.0
DEFAULT_MATCH_BUFFER_FEET = 25.0
DEFAULT_MIN_MATCH_LENGTH_FEET = 15.0


def _coerce_positive_float(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if result <= 0:
        return None
    return result


def _normalize_setting(
    location: dict[str, Any],
    base_key: str,
    default_feet: float,
) -> None:
    feet_key = f"{base_key}_feet"
    meters_key = f"{base_key}_meters"

    feet_val = _coerce_positive_float(location.get(feet_key))
    meters_val = _coerce_positive_float(location.get(meters_key))

    if feet_val is None and meters_val is not None:
        feet_val = meters_val / FEET_TO_METERS
    if meters_val is None and feet_val is not None:
        meters_val = feet_val * FEET_TO_METERS

    if feet_val is None and meters_val is None:
        feet_val = default_feet
        meters_val = feet_val * FEET_TO_METERS

    location[feet_key] = feet_val
    location[meters_key] = meters_val


def normalize_location_settings(location: dict[str, Any]) -> dict[str, Any]:
    """Ensure location settings are present in both feet and meters."""
    if not isinstance(location, dict):
        return {}

    normalized = dict(location)

    _normalize_setting(
        normalized,
        "segment_length",
        DEFAULT_SEGMENT_LENGTH_FEET,
    )
    _normalize_setting(
        normalized,
        "match_buffer",
        DEFAULT_MATCH_BUFFER_FEET,
    )
    _normalize_setting(
        normalized,
        "min_match_length",
        DEFAULT_MIN_MATCH_LENGTH_FEET,
    )

    return normalized
