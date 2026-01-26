"""
Query building utilities for MongoDB.

Provides functions for constructing complex MongoDB queries,
particularly for date filtering and request parameter handling.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from core.date_utils import normalize_calendar_date, normalize_to_utc_datetime

if TYPE_CHECKING:
    from datetime import datetime

    from fastapi import Request

logger = logging.getLogger(__name__)


def parse_query_date(
    date_str: str | None,
    end_of_day: bool = False,
) -> datetime | None:
    """
    Parse a date string for query filtering.

    Handles both date-only strings (YYYY-MM-DD) and full ISO datetime strings.
    For date-only strings, can optionally set to end of day.

    Args:
        date_str: Date string to parse (YYYY-MM-DD or ISO format).
        end_of_day: If True and date_str is date-only, set time to 23:59:59.999999.

    Returns:
        Parsed datetime in UTC, or None if parsing fails.
    """
    if not date_str:
        return None

    dt = normalize_to_utc_datetime(date_str)
    if dt is None:
        logger.warning("Unable to parse date string '%s'; returning None.", date_str)
        return None

    # Check if this is a date-only string (no time component)
    is_date_only = (
        isinstance(date_str, str) and "T" not in date_str and "t" not in date_str
    )

    if is_date_only:
        if end_of_day:
            return dt.replace(hour=23, minute=59, second=59, microsecond=999999)
        return dt.replace(hour=0, minute=0, second=0, microsecond=0)

    return dt


def build_calendar_date_expr(
    start_date: str | datetime | None,
    end_date: str | datetime | None,
    *,
    date_field: str = "startTime",
) -> dict[str, Any] | None:
    """
    Build a MongoDB $expr for calendar date filtering with timezone support.

    Creates an aggregation expression that converts dates to the document's
    timezone before comparing, enabling accurate local date filtering.

    Args:
        start_date: Start date (inclusive) as string or datetime.
        end_date: End date (inclusive) as string or datetime.
        date_field: Document field containing the date to filter on.

    Returns:
        MongoDB $expr clause, or None if no valid dates provided.

    Example:
        >>> expr = build_calendar_date_expr("2024-01-01", "2024-01-31")
        >>> query = {"$expr": expr} if expr else {}
    """
    start_str = normalize_calendar_date(start_date)
    end_str = normalize_calendar_date(end_date)

    if start_date and not start_str:
        logger.warning("Invalid start date provided for filtering: %s", start_date)
    if end_date and not end_str:
        logger.warning("Invalid end date provided for filtering: %s", end_date)

    if not start_str and not end_str:
        return None

    # Build timezone expression that handles edge cases and validates timezone format
    # Attempts to match IANA-like timezone strings (Area/Location) or UTC/GMT
    # If invalid, falls back to UTC to prevent $dateToString from crashing
    tz_expr: dict[str, Any] = {
        "$switch": {
            "branches": [
                {
                    "case": {"$in": ["$timeZone", ["", "0000", None]]},
                    "then": "UTC",
                },
                {
                    "case": {
                        "$regexMatch": {
                            "input": "$timeZone",
                            "regex": r"^[a-zA-Z_]+/[a-zA-Z0-9_+\-]+$|^UTC$|^GMT$",
                        },
                    },
                    "then": "$timeZone",
                },
            ],
            "default": "UTC",
        },
    }

    # Convert date field to string in document's timezone
    date_expr: dict[str, Any] = {
        "$dateToString": {
            "format": "%Y-%m-%d",
            "date": f"${date_field}",
            "timezone": tz_expr,
        },
    }

    # Build comparison clauses
    clauses: list[dict[str, Any]] = []
    if start_str:
        clauses.append({"$gte": [date_expr, start_str]})
    if end_str:
        clauses.append({"$lte": [date_expr, end_str]})

    if not clauses:
        return None

    return {"$and": clauses} if len(clauses) > 1 else clauses[0]


async def build_query_from_request(
    request: Request,
    date_field: str = "startTime",
    include_imei: bool = True,
    additional_filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Build a MongoDB query from FastAPI request parameters.

    Extracts common query parameters (start_date, end_date, imei) and
    builds a query with proper date filtering.

    Args:
        request: FastAPI Request object.
        date_field: Document field for date filtering.
        include_imei: Whether to include IMEI filter if present.
        additional_filters: Extra filter conditions to merge.

    Returns:
        MongoDB query dictionary.

    Supported Query Parameters:
        - start_date: Filter documents on or after this date
        - end_date: Filter documents on or before this date
        - imei: Filter by device IMEI
    """
    query: dict[str, Any] = {}

    start_date_str = request.query_params.get("start_date")
    end_date_str = request.query_params.get("end_date")

    date_expr = build_calendar_date_expr(
        start_date_str,
        end_date_str,
        date_field=date_field,
    )

    if date_expr:
        query["$expr"] = date_expr

    imei_param = request.query_params.get("imei")
    if include_imei and imei_param:
        query["imei"] = imei_param

    if additional_filters:
        query.update(additional_filters)

    return query
