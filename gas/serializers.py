"""Serialization utilities for gas tracking data."""

from datetime import datetime

from date_utils import normalize_to_utc_datetime


def parse_iso_datetime(value: str) -> datetime:
    """Parse ISO datetime string to UTC datetime object.

    Args:
        value: ISO 8601 datetime string

    Returns:
        UTC datetime object

    Raises:
        ValueError: If datetime string is invalid
    """
    parsed = normalize_to_utc_datetime(value)
    if not parsed:
        raise ValueError(f"Invalid datetime value: {value}")
    return parsed
