"""
Centralized date and time utilities for the application.

This module provides a focused set of functions for handling dates, times,
and timestamps in a consistent and timezone-aware manner. It encapsulates all
date-related logic, including parsing, formatting, and timezone conversion.

Key Features:
-   **Timezone-Aware Parsing**: All timestamps are handled as timezone-aware
    datetime objects, defaulting to UTC to prevent common timezone-related bugs.
-   **Consistent Formatting**: Provides standardized functions for converting
    datetime objects to strings for display or API responses.
-   **Dependency Abstraction**: Wraps date-related libraries like `dateutil` to
    provide a stable, internal API for the rest of the application.

This module is intended to be the single source of truth for all date and time
operations used throughout the codebase.
"""

import logging
from datetime import UTC, date, datetime

from dateutil import parser

logger = logging.getLogger(__name__)


def get_current_utc_time() -> datetime:
    """Return the current time as a timezone-aware datetime object in UTC."""
    return datetime.now(UTC)


def parse_timestamp(ts: str | datetime) -> datetime | None:
    """
    Parse a timestamp string (or datetime object) and ensure it is
    timezone-aware, defaulting to UTC.

    This function is the primary entry point for converting external timestamps
    into a consistent, internal format. It is designed to be robust and handle
    various timestamp formats gracefully.

    Args:
        ts: The timestamp to parse, either as an ISO 8601 string or a
            datetime object.

    Returns:
        A timezone-aware datetime object, or None if parsing fails.
    """
    if not ts:
        logger.debug("Received empty timestamp; returning None.")
        return None

    if isinstance(ts, datetime):
        # If the datetime object is naive, assume UTC.
        if ts.tzinfo is None:
            return ts.replace(tzinfo=UTC)
        return ts

    try:
        # Use dateutil.parser for robust parsing of various ISO 8601 formats.
        parsed_time = parser.isoparse(ts)
        # If the parsed time is naive, assume it's in UTC.
        if parsed_time.tzinfo is None:
            return parsed_time.replace(tzinfo=UTC)
        return parsed_time
    except (ValueError, TypeError) as e:
        logger.warning("Failed to parse timestamp '%s': %s", ts, e)
        return None


def ensure_utc(dt: datetime | None) -> datetime | None:
    """Return the datetime as an explicit UTC-aware value."""

    if dt is None:
        return None

    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)

    return dt.astimezone(UTC)


def normalize_to_utc_datetime(value: str | datetime | date | None) -> datetime | None:
    """Normalize arbitrary date/datetime inputs to a UTC-aware datetime."""

    if value is None:
        return None

    if isinstance(value, datetime):
        return ensure_utc(value)

    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time(), tzinfo=UTC)

    if isinstance(value, str):
        parsed = parse_timestamp(value)
        if parsed:
            return ensure_utc(parsed)

        try:
            parsed_date = datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            logger.warning(
                "Unable to interpret value '%s' as datetime; returning None.", value
            )
            return None

        return datetime.combine(parsed_date, datetime.min.time(), tzinfo=UTC)

    logger.warning("Unsupported datetime input type '%s'", type(value))
    return None


def normalize_calendar_date(value: str | datetime | date | None) -> str | None:
    """Normalize a date-like input to a YYYY-MM-DD string."""

    normalized_dt = normalize_to_utc_datetime(value)
    if normalized_dt:
        return normalized_dt.date().isoformat()

    if isinstance(value, date):
        return value.isoformat()

    return None
