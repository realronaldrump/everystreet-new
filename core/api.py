"""API utilities for FastAPI route handling."""

import functools
import logging
from collections.abc import Callable

from fastapi import HTTPException, status

from core.exceptions import (
    AuthenticationException,
    AuthorizationException,
    DuplicateResourceException,
    EveryStreetException,
    ExternalServiceException,
    RateLimitException,
    ResourceNotFoundException,
    ValidationException,
)


def api_route(logger: logging.Logger):
    """
    Decorator for FastAPI endpoints that provides standardized error handling.

    Wraps async endpoint functions with try/except to:
    - Re-raise HTTPException instances as-is
    - Map custom exceptions to appropriate HTTP status codes
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
            except HTTPException:
                # Re-raise HTTPException as-is without logging or wrapping
                raise
            except ValidationException as e:
                logger.warning("Validation error in %s: %s", func.__name__, e.message)
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=e.message,
                ) from e
            except ResourceNotFoundException as e:
                logger.info("Resource not found in %s: %s", func.__name__, e.message)
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=e.message,
                ) from e
            except DuplicateResourceException as e:
                logger.warning("Duplicate resource in %s: %s", func.__name__, e.message)
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=e.message,
                ) from e
            except AuthenticationException as e:
                logger.warning(
                    "Authentication failed in %s: %s",
                    func.__name__,
                    e.message,
                )
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail=e.message,
                ) from e
            except AuthorizationException as e:
                logger.warning(
                    "Authorization failed in %s: %s",
                    func.__name__,
                    e.message,
                )
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=e.message,
                ) from e
            except RateLimitException as e:
                logger.warning(
                    "Rate limit exceeded in %s: %s",
                    func.__name__,
                    e.message,
                )
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=e.message,
                ) from e
            except ExternalServiceException as e:
                logger.exception(
                    "External service error in %s: %s",
                    func.__name__,
                    e.message,
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"External service error: {e.message}",
                ) from e
            except EveryStreetException as e:
                # Catch-all for other custom exceptions
                logger.exception(
                    "Application error in %s: %s",
                    func.__name__,
                    e.message,
                )
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=e.message,
                ) from e
            except Exception as e:
                # Generic catch-all for unexpected errors
                logger.exception("Unexpected error in %s", func.__name__)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=str(e),
                ) from e

        return wrapper

    return decorator
