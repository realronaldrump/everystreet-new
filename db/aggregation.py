"""Aggregation helpers compatible with Motor or PyMongo async collections."""

from __future__ import annotations

import inspect
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable


async def aggregate_to_list(
    model: Any,
    pipeline: Iterable[dict[str, Any]],
    *,
    length: int | None = None,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    """
    Run an aggregation pipeline and return results as a list.

    Handles Motor (cursor returned directly) and PyMongo async (cursor
    returned via await) collections.
    """
    collection = model.get_pymongo_collection()
    cursor = collection.aggregate(pipeline, **kwargs)
    if inspect.isawaitable(cursor):
        cursor = await cursor
    return await cursor.to_list(length=length)
