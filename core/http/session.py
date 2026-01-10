"""HTTP session management for aiohttp.

This module provides shared aiohttp ClientSession management with proper
handling of process forks and event loop changes.
"""

from __future__ import annotations

import asyncio
import logging
import os

import aiohttp

from core.constants import (
    HTTP_CONNECTION_LIMIT,
    HTTP_TIMEOUT_CONNECT,
    HTTP_TIMEOUT_SOCK_READ,
    HTTP_TIMEOUT_TOTAL,
)

logger = logging.getLogger(__name__)


class SessionState:
    """State container for aiohttp session to avoid global variables."""

    session: aiohttp.ClientSession | None = None
    session_owner_pid: int | None = None


async def get_session() -> aiohttp.ClientSession:
    """Get or create a shared aiohttp ClientSession.

    This function creates a per-process session and handles fork scenarios
    cleanly. Sessions are not shared across processes to avoid concurrency
    issues.

    Returns:
        Shared aiohttp ClientSession for the current process.
    """
    current_pid = os.getpid()

    # Handle fork scenario: close inherited session from parent process
    if (
        SessionState.session is not None
        and current_pid != SessionState.session_owner_pid
    ):
        try:
            logger.debug(
                "Discarding inherited session from parent process %s in child process %s",
                SessionState.session_owner_pid,
                current_pid,
            )
        except Exception as e:
            logger.warning(
                "Failed to discard inherited session: %s",
                e,
                exc_info=False,
            )
        finally:
            SessionState.session = None
            SessionState.session_owner_pid = None

    # Check for loop mismatch or closed loop
    if SessionState.session is not None:
        try:
            current_loop = asyncio.get_running_loop()
            if (
                SessionState.session.loop != current_loop
                or SessionState.session.loop.is_closed()
            ):
                logger.info(
                    "Detected event loop change. Creating new session.",
                )
                try:
                    if (
                        not SessionState.session.closed
                        and not SessionState.session.loop.is_closed()
                    ):
                        await SessionState.session.close()
                except Exception as e:
                    logger.warning("Error closing stale session: %s", e)
                SessionState.session = None
        except RuntimeError:
            # No running loop? Should not happen in get_session normally.
            pass

    # Create new session if needed
    if SessionState.session is None or SessionState.session.closed:
        timeout = aiohttp.ClientTimeout(
            total=HTTP_TIMEOUT_TOTAL,
            connect=HTTP_TIMEOUT_CONNECT,
            sock_read=HTTP_TIMEOUT_SOCK_READ,
        )
        headers = {
            "User-Agent": "EveryStreet/1.0",
            "Accept": "application/json",
        }
        connector = aiohttp.TCPConnector(
            limit=HTTP_CONNECTION_LIMIT,
            force_close=False,
            enable_cleanup_closed=True,
        )
        SessionState.session = aiohttp.ClientSession(
            timeout=timeout,
            headers=headers,
            connector=connector,
        )
        SessionState.session_owner_pid = current_pid
        logger.debug("Created new aiohttp session for process %s", current_pid)

    return SessionState.session


async def cleanup_session():
    """Close the shared session for the current process."""
    if SessionState.session and not SessionState.session.closed:
        try:
            await SessionState.session.close()
            logger.info("Closed aiohttp session for process %s", os.getpid())
        except Exception as e:
            logger.warning("Error closing session: %s", e)

    SessionState.session = None
    SessionState.session_owner_pid = None
