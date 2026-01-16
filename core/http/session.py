"""
HTTP session management for aiohttp.

This module provides a process-local shared aiohttp ClientSession.
"""

from __future__ import annotations

import asyncio
import logging

import aiohttp

from core.constants import (
    HTTP_CONNECTION_LIMIT,
    HTTP_TIMEOUT_CONNECT,
    HTTP_TIMEOUT_SOCK_READ,
    HTTP_TIMEOUT_TOTAL,
)

logger = logging.getLogger(__name__)

_session: aiohttp.ClientSession | None = None
_session_lock = asyncio.Lock()


async def get_session() -> aiohttp.ClientSession:
    """Get or create the shared aiohttp ClientSession."""
    global _session
    if _session is not None and not _session.closed:
        return _session

    async with _session_lock:
        if _session is not None and not _session.closed:
            return _session

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
        _session = aiohttp.ClientSession(
            timeout=timeout,
            headers=headers,
            connector=connector,
        )
        logger.debug("Created new aiohttp session")

    return _session


async def cleanup_session() -> None:
    """Close the shared session for the current process."""
    global _session
    if _session and not _session.closed:
        try:
            await _session.close()
            logger.info("Closed aiohttp session")
        except Exception as e:
            logger.warning("Error closing session: %s", e)
    _session = None
