"""API utility functions for reducing boilerplate across FastAPI endpoints."""

import functools
import logging
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException, status


def api_route(logger: logging.Logger):
    """Decorator for FastAPI endpoints that provides standardized error handling.

    Wraps async endpoint functions with try/except to:
    - Re-raise HTTPException instances as-is
    - Log and convert other exceptions to 500 HTTPException

    Usage:
        @router.get("/api/example")
        @api_route(logger)
        async def my_endpoint():
            # ... business logic ...
            return result
    """

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            try:
                return await func(*args, **kwargs)
            except Exception as e:
                # Re-raise HTTPException as-is without logging or wrapping
                if isinstance(e, HTTPException):
                    raise
                logger.exception("Error in %s: %s", func.__name__, e)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=str(e),
                ) from e

        return wrapper

    return decorator


def get_mongo_tz_expr() -> dict[str, Any]:
    """Return the standard MongoDB timezone expression for aggregation pipelines.

    This expression handles the timeZone field on trip documents, falling back
    to UTC when the field is missing, empty, or set to "0000".

    Returns:
        MongoDB $switch expression for use in $dateToString, $hour, $dayOfWeek, etc.
    """
    return {
        "$switch": {
            "branches": [{"case": {"$in": ["$timeZone", ["", "0000"]]}, "then": "UTC"}],
            "default": {"$ifNull": ["$timeZone", "UTC"]},
        }
    }
