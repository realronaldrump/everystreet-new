"""Serialization utilities for trip data."""


def _safe_float(value, default=0.0):
    """Safely cast values to float, returning a fallback on failure."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_int(value, default=0):
    """Safely cast values to int, returning a fallback on failure."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
