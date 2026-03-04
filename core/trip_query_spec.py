"""Canonical trip query specification and compiler."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from core.date_utils import normalize_calendar_date
from core.trip_source_policy import enforce_bouncie_source
from db.aggregation_utils import get_mongo_tz_expr

if TYPE_CHECKING:
    from fastapi import Request

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class TripQuerySpec:
    """Normalized query inputs for historical trip reads."""

    start_date: str | datetime | None = None
    end_date: str | datetime | None = None
    interval_days: int = 0
    imei: str | None = None
    include_invalid: bool = False
    matched_only: bool = False
    unmatched_only: bool = False

    @classmethod
    def from_request(
        cls,
        request: Request,
        *,
        include_imei: bool = True,
        include_invalid: bool = False,
    ) -> TripQuerySpec:
        start_date = request.query_params.get("start_date")
        end_date = request.query_params.get("end_date")
        imei = request.query_params.get("imei") if include_imei else None
        return cls(
            start_date=start_date,
            end_date=end_date,
            imei=imei,
            include_invalid=include_invalid,
        )

    @staticmethod
    def build_calendar_date_expr(
        start_date: str | datetime | None,
        end_date: str | datetime | None,
        *,
        date_field: str = "startTime",
    ) -> dict[str, Any] | None:
        """Build a timezone-aware MongoDB calendar date expression."""
        start_str = normalize_calendar_date(start_date)
        end_str = normalize_calendar_date(end_date)

        if start_date and not start_str:
            logger.warning("Invalid start date provided for filtering: %s", start_date)
        if end_date and not end_str:
            logger.warning("Invalid end date provided for filtering: %s", end_date)

        if not start_str and not end_str:
            return None

        tz_expr = get_mongo_tz_expr(date_field)
        date_expr: dict[str, Any] = {
            "$dateToString": {
                "format": "%Y-%m-%d",
                "date": f"${date_field}",
                "timezone": tz_expr,
            },
        }

        clauses: list[dict[str, Any]] = []
        if start_str:
            clauses.append({"$gte": [date_expr, start_str]})
        if end_str:
            clauses.append({"$lte": [date_expr, end_str]})

        if not clauses:
            return None
        return {"$and": clauses} if len(clauses) > 1 else clauses[0]

    def resolve_date_window(
        self,
        *,
        anchor: datetime | None = None,
    ) -> tuple[str | None, str | None]:
        """Resolve date inputs to start/end ISO dates (YYYY-MM-DD)."""
        if self.interval_days and self.interval_days > 0:
            end_dt = anchor or datetime.now(UTC)
            start_dt = end_dt - timedelta(days=self.interval_days)
            return start_dt.date().isoformat(), end_dt.date().isoformat()
        return (
            normalize_calendar_date(self.start_date),
            normalize_calendar_date(self.end_date),
        )

    def to_mongo_query(
        self,
        *,
        date_field: str = "startTime",
        anchor: datetime | None = None,
        extra_filters: dict[str, Any] | None = None,
        require_complete_bounds: bool = False,
        require_valid_range_if_provided: bool = False,
        enforce_source: bool = True,
    ) -> dict[str, Any]:
        """
        Compile this spec to a Mongo query.

        Args:
            require_complete_bounds: require both start and end date bounds.
            require_valid_range_if_provided: fail when date input exists but cannot
                produce a valid date expression.
        """
        query: dict[str, Any] = {}

        if not self.include_invalid:
            query["invalid"] = {"$ne": True}

        if self.imei:
            query["imei"] = self.imei

        if self.unmatched_only:
            query["matchedGps"] = None
        elif self.matched_only:
            query["matchedGps"] = {"$ne": None}

        start_iso, end_iso = self.resolve_date_window(anchor=anchor)
        has_date_input = bool(
            self.start_date or self.end_date or self.interval_days > 0
        )

        if require_complete_bounds and (not start_iso or not end_iso):
            raise ValueError("Invalid date range")

        date_expr = self.build_calendar_date_expr(
            start_iso,
            end_iso,
            date_field=date_field,
        )
        if date_expr:
            query["$expr"] = date_expr
        elif has_date_input and require_valid_range_if_provided:
            raise ValueError("Invalid date range")

        if extra_filters:
            query.update(extra_filters)

        if enforce_source:
            return enforce_bouncie_source(query)
        return query


__all__ = ["TripQuerySpec"]
