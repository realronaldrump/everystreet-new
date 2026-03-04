"""
Query building utilities for MongoDB.

Provides functions for constructing complex MongoDB queries,
particularly for date filtering and request parameter handling.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from core.trip_query_spec import TripQuerySpec

if TYPE_CHECKING:
    from datetime import datetime

    from fastapi import Request

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
    return TripQuerySpec.build_calendar_date_expr(
        start_date,
        end_date,
        date_field=date_field,
    )


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
    spec = TripQuerySpec.from_request(
        request,
        include_imei=include_imei,
        include_invalid=True,
    )
    return spec.to_mongo_query(
        date_field=date_field,
        extra_filters=additional_filters,
        enforce_source=True,
    )
