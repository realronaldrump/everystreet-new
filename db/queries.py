"""
Aggregation query helpers.

This module centralizes complex aggregation pipeline helpers so services
can share a consistent, tested set of query builders.
"""

from __future__ import annotations

from typing import Any

from db.aggregation import aggregate_to_list
from db.aggregation_utils import (
    build_date_grouping_stage,
    build_match_stage,
    get_mongo_tz_expr,
    organize_by_dimension,
    organize_by_multiple_dimensions,
)


async def aggregate_by_date(
    model: Any,
    *,
    match: dict[str, Any] | None = None,
    date_field: str = "$startTime",
    group_by: list[str] | None = None,
    sum_fields: dict[str, str] | None = None,
    sort: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    """
    Aggregate documents by date/time dimensions with optional match and sort.

    Args:
        model: Beanie document model to aggregate.
        match: Optional $match filters to apply before grouping.
        date_field: Field path (with $) for grouping, defaults to startTime.
        group_by: Grouping dimensions (e.g., ["date", "hour"]).
        sum_fields: Sum aggregations mapping output field to source field.
        sort: Optional $sort stage.

    Returns:
        Aggregation results as list of dictionaries.
    """
    pipeline: list[dict[str, Any]] = []
    if match:
        pipeline.append(build_match_stage(match))
    pipeline.append(
        build_date_grouping_stage(
            date_field=date_field,
            group_by=group_by,
            sum_fields=sum_fields,
        ),
    )
    if sort:
        pipeline.append({"$sort": sort})
    return await aggregate_to_list(model, pipeline)


__all__ = [
    "aggregate_by_date",
    "aggregate_to_list",
    "build_date_grouping_stage",
    "build_match_stage",
    "get_mongo_tz_expr",
    "organize_by_dimension",
    "organize_by_multiple_dimensions",
]
