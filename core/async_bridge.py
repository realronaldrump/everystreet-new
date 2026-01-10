"""Async-to-sync bridge for Celery tasks and other synchronous contexts.

This module provides utilities to run async coroutines from synchronous code
with proper event loop management.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any, TypeVar

from core.http.session import cleanup_session

logger = logging.getLogger(__name__)

T = TypeVar("T")


def run_async_from_sync(
    coro: Coroutine[Any, Any, T],
) -> T:
    """Run an async coroutine from a synchronous context, managing the event loop.

    This is crucial for calling async functions (like motor operations)
    from synchronous Celery tasks without encountering 'Event loop is closed' errors
    or 'Future attached to a different loop' errors.

    To avoid event loop conflicts with Motor (MongoDB async driver), this function:
    1. Always creates a fresh event loop for each call
    2. Properly cleans up the loop after execution
    3. Clears the thread-local event loop reference

    Args:
        coro: The awaitable coroutine to execute.

    Returns:
        The result of the coroutine.

    Example:
        # From a synchronous Celery task
        result = run_async_from_sync(fetch_data_async())
    """
    # Always create a fresh loop to ensure isolation from any existing loop
    # This prevents "attached to a different loop" errors with Motor
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    except Exception:
        logger.error(
            "Exception occurred during run_until_complete",
            exc_info=True,
        )
        raise
    finally:
        try:
            # Cancel any pending tasks
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            # Allow cancelled tasks to complete
            if pending:
                loop.run_until_complete(
                    asyncio.gather(*pending, return_exceptions=True)
                )

            # Cleanup the session associated with this loop
            loop.run_until_complete(cleanup_session())

            loop.close()
        except Exception as e:
            logger.warning("Error during event loop cleanup: %s", e)
        finally:
            # Clear thread-local loop reference to avoid stale references
            asyncio.set_event_loop(None)
