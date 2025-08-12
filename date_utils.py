"""
Centralized date and time utilities for the application.

This module provides a comprehensive set of functions for handling dates, times,
and timestamps in a consistent and timezone-aware manner. It encapsulates all
date-related logic, including parsing, formatting, timezone conversion, and
date range calculations.

Key Features:
-   **Timezone-Aware Parsing**: All timestamps are handled as timezone-aware
    datetime objects, defaulting to UTC to prevent common timezone-related bugs.
-   **Consistent Formatting**: Provides standardized functions for converting
    datetime objects to strings for display or API responses.
-   **Date Range Operations**: Simplifies the creation and manipulation of date
    ranges, which are common in filtering and data processing.
-   **Dependency Abstraction**: Wraps date-related libraries like `dateutil` to
    provide a stable, internal API for the rest of the application.

This module is intended to be the single source of truth for all date and time
operations, eliminating redundant or inconsistent implementations across the
codebase.
"""

import logging
from datetime import datetime, timedelta, timezone

from dateutil import parser

logger = logging.getLogger(__name__)


def get_current_utc_time() -> datetime:
    """Return the current time as a timezone-aware datetime object in UTC."""
    return datetime.now(timezone.utc)


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
            return ts.replace(tzinfo=timezone.utc)
        return ts

    try:
        # Use dateutil.parser for robust parsing of various ISO 8601 formats.
        parsed_time = parser.isoparse(ts)
        # If the parsed time is naive, assume it's in UTC.
        if parsed_time.tzinfo is None:
            return parsed_time.replace(tzinfo=timezone.utc)
        return parsed_time
    except (ValueError, TypeError) as e:
        logger.warning("Failed to parse timestamp '%s': %s", ts, e)
        return None


def format_to_iso(dt: datetime) -> str | None:
    """
    Format a datetime object into a standardized ISO 8601 string with UTC
    timezone ('Z').
    """
    if not isinstance(dt, datetime):
        logger.warning("Invalid type for formatting: %s", type(dt))
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def get_date_range(
    start_date_str: str | None,
    end_date_str: str | None,
    default_days: int = 7,
) -> tuple[datetime, datetime]:
    """
    Calculate a date range, providing defaults if the start or end dates
    are not specified.

    The end date is set to the end of the specified day (23:59:59.999999)
    to ensure that queries for the date range are inclusive.

    Args:
        start_date_str: The start date in 'YYYY-MM-DD' format.
        end_date_str: The end date in 'YYYY-MM-DD' format.
        default_days: The number of days to use for the default range if
                      start or end dates are missing.

    Returns:
        A tuple containing the start and end datetime objects for the range.
    """
    end_date = (
        datetime.strptime(end_date_str, "%Y-%m-%d")
        if end_date_str
        else get_current_utc_time()
    )
    # Set time to the end of the day to ensure the range is inclusive.
    end_date = end_date.replace(hour=23, minute=59, second=59, microsecond=999999)

    start_date = (
        datetime.strptime(start_date_str, "%Y-%m-%d")
        if start_date_str
        else end_date - timedelta(days=default_days)
    )
    start_date = start_date.replace(hour=0, minute=0, second=0, microsecond=0)

    return start_date, end_date
