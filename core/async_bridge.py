"""
Async-to-sync bridge for Celery tasks and other synchronous contexts.

This module provides utilities to run async coroutines from synchronous code with proper
event loop management, reusing a per-worker loop when available.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import threading
from typing import TYPE_CHECKING, Any, TypeVar

from core.http.session import cleanup_session
from db import db_manager

if TYPE_CHECKING:
    from collections.abc import Coroutine

logger = logging.getLogger(__name__)

T = TypeVar("T")

_worker_loop: asyncio.AbstractEventLoop | None = None
_worker_loop_pid: int | None = None
_worker_loop_thread_id: int | None = None


def set_worker_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    """Register the per-worker event loop for sync-to-async bridging."""
    global _worker_loop, _worker_loop_pid, _worker_loop_thread_id
    _worker_loop = loop
    if loop is None:
        _worker_loop_pid = None
        _worker_loop_thread_id = None
        return
    _worker_loop_pid = os.getpid()
    _worker_loop_thread_id = threading.get_ident()


def clear_worker_loop() -> None:
    """Clear the registered worker loop."""
    set_worker_loop(None)


def get_worker_loop() -> asyncio.AbstractEventLoop | None:
    """Return the registered worker loop if it's valid for this process."""
    global _worker_loop, _worker_loop_pid, _worker_loop_thread_id
    if _worker_loop is None:
        return None
    if _worker_loop_pid != os.getpid():
        _worker_loop = None
        _worker_loop_pid = None
        _worker_loop_thread_id = None
        return None
    if _worker_loop.is_closed():
        _worker_loop = None
        _worker_loop_pid = None
        _worker_loop_thread_id = None
        return None
    return _worker_loop


def _get_worker_loop_for_thread() -> asyncio.AbstractEventLoop | None:
    loop = get_worker_loop()
    if loop is None:
        return None
    if _worker_loop_thread_id != threading.get_ident():
        return None
    return loop


def shutdown_worker_loop() -> None:
    """Gracefully close per-worker async resources and loop."""
    loop = get_worker_loop()
    if loop is None:
        clear_worker_loop()
        return

    try:
        if not loop.is_closed():
            with contextlib.suppress(Exception):
                asyncio.set_event_loop(loop)

            try:
                pending = asyncio.all_tasks(loop)
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(
                        asyncio.gather(*pending, return_exceptions=True),
                    )
            except Exception as e:
                logger.warning("Error cancelling pending tasks: %s", e)

            try:
                loop.run_until_complete(cleanup_session())
            except Exception as e:
                logger.warning("Error cleaning up HTTP session: %s", e)

            try:
                loop.run_until_complete(db_manager.cleanup_connections())
            except Exception as e:
                logger.warning("Error cleaning up DB connections: %s", e)

            loop.close()
    finally:
        clear_worker_loop()
        with contextlib.suppress(Exception):
            asyncio.set_event_loop(None)


def _ensure_no_running_loop() -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    msg = "run_async_from_sync called while an event loop is running"
    raise RuntimeError(msg)


async def _run_with_db(coro: Coroutine[Any, Any, T]) -> T:
    await db_manager.init_beanie()
    return await coro


def _run_in_new_loop(coro: Coroutine[Any, Any, T]) -> T:
    _ensure_no_running_loop()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_run_with_db(coro))
    except Exception:
        logger.error(
            "Exception occurred during run_until_complete",
            exc_info=True,
        )
        raise
    finally:
        try:
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(
                    asyncio.gather(*pending, return_exceptions=True),
                )
            loop.run_until_complete(cleanup_session())
            loop.close()
        except Exception as e:
            logger.warning("Error during event loop cleanup: %s", e)
        finally:
            asyncio.set_event_loop(None)


def run_async_from_sync(
    coro: Coroutine[Any, Any, T],
) -> T:
    """
    Run an async coroutine from a synchronous context, managing the event loop.

    This is crucial for calling async functions (like motor operations)
    from synchronous Celery tasks without encountering 'Event loop is closed' errors
    or 'Future attached to a different loop' errors.

    To avoid event loop conflicts with Motor (MongoDB async driver), this function:
    1. Reuses a per-worker event loop when available (see set_worker_loop)
    2. Falls back to a fresh event loop when no worker loop is registered
    3. Ensures the DB/ODM is initialized for the active loop

    Args:
        coro: The awaitable coroutine to execute.

    Returns:
        The result of the coroutine.

    Example:
        # From a synchronous Celery task
        result = run_async_from_sync(fetch_data_async())
    """
    loop = _get_worker_loop_for_thread()
    if loop is None:
        return _run_in_new_loop(coro)

    _ensure_no_running_loop()
    with contextlib.suppress(Exception):
        asyncio.set_event_loop(loop)

    if loop.is_running():
        msg = "Worker event loop is already running; cannot run sync bridge"
        raise RuntimeError(msg)

    try:
        return loop.run_until_complete(_run_with_db(coro))
    except Exception:
        logger.error(
            "Exception occurred during run_until_complete",
            exc_info=True,
        )
        raise
