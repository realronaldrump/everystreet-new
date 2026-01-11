"""Utility functions for safe type conversions.

Beanie and Pydantic handle all serialization automatically, so manual serialization
utilities are no longer needed. Only type coercion utilities remain.
"""

from __future__ import annotations

from typing import Any


def safe_float(value: Any, default: float = 0.0) -> float:
    """Safely convert a value to float with fallback.

    Args:
        value: Value to convert to float
        default: Default value if conversion fails (default: 0.0)

    Returns:
        Float value or default if conversion fails

    Examples:
        >>> safe_float("3.14")
        3.14
        >>> safe_float("invalid", default=0.0)
        0.0
    """
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def safe_int(value: Any, default: int = 0) -> int:
    """Safely convert a value to int with fallback.

    Args:
        value: Value to convert to int
        default: Default value if conversion fails (default: 0)

    Returns:
        Integer value or default if conversion fails

    Examples:
        >>> safe_int("42")
        42
        >>> safe_int("invalid", default=0)
        0
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
