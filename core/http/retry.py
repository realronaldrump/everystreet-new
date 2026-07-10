"""
Retry utilities for async HTTP operations.

This module provides retry decorators using tenacity for resilient HTTP
calls.
"""

from __future__ import annotations

import asyncio
import logging

from aiohttp import ClientConnectorError, ClientError, ServerDisconnectedError
from tenacity import (
    before_sleep_log,
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from core.exceptions import ExternalServiceException

logger = logging.getLogger(__name__)


def retry_async(
    max_retries: int = 3,
    retry_delay: float = 1.0,
    backoff_factor: float = 2.0,
    retry_exceptions: tuple = (
        ClientConnectorError,
        ServerDisconnectedError,
        ClientError,
        asyncio.TimeoutError,
    ),
):
    """
    Factory that returns a tenacity retry decorator configured with provided parameters.

    Args:
        max_retries: Maximum number of retry attempts (in addition to the first attempt).
        retry_delay: Initial delay between retries in seconds (used as multiplier).
        backoff_factor: Exponential backoff base for increasing delay between retries.
        retry_exceptions: Tuple of exception types that should trigger a retry.

    Returns:
        A tenacity retry decorator configured with the specified parameters.

    Example:
        @retry_async(max_retries=5, retry_delay=2.0)
        async def fetch_data():
            async with session.get(url) as response:
                return await response.json()
    """
    def should_retry(exc: BaseException) -> bool:
        if isinstance(exc, retry_exceptions):
            return True
        if not isinstance(exc, ExternalServiceException):
            return False
        status = exc.details.get("status")
        if status is None:
            return True
        try:
            return int(status) == 429 or int(status) >= 500
        except (TypeError, ValueError):
            return False

    exponential_wait = wait_exponential(
        multiplier=retry_delay,
        exp_base=backoff_factor,
    )

    def wait_with_retry_after(retry_state) -> float:
        delay = float(exponential_wait(retry_state))
        outcome = retry_state.outcome
        exc = outcome.exception() if outcome and outcome.failed else None
        if isinstance(exc, ExternalServiceException):
            try:
                retry_after = float(exc.details.get("retry_after") or 0)
            except (TypeError, ValueError):
                retry_after = 0
            delay = max(delay, retry_after)
        return delay

    return retry(
        # stop_after_attempt includes the first attempt, so add 1 to match original logic
        stop=stop_after_attempt(max_retries + 1),
        # Configure exponential backoff: wait = multiplier * (exp_base ** attempt)
        wait=wait_with_retry_after,
        # Filter specific exceptions that should trigger retry
        retry=retry_if_exception(should_retry),
        # Log before each sleep using the module logger
        before_sleep=before_sleep_log(logger, logging.WARNING),
        # Ensure the last exception is re-raised if all retries fail
        reraise=True,
    )
