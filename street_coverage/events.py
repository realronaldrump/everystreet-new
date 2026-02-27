"""
In-process event bus for job progress streaming.

The ingestion pipeline publishes granular events here,
and the SSE endpoint consumes them for real-time delivery.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# job_id -> set of asyncio.Queue (one per SSE subscriber)
_subscribers: dict[str, set[asyncio.Queue]] = {}


def subscribe(job_id: str) -> asyncio.Queue:
    """Subscribe to events for a job. Returns a Queue to await on."""
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    _subscribers.setdefault(job_id, set()).add(q)
    return q


def unsubscribe(job_id: str, q: asyncio.Queue) -> None:
    """Remove a subscriber queue."""
    subs = _subscribers.get(job_id)
    if subs:
        subs.discard(q)
        if not subs:
            _subscribers.pop(job_id, None)


def publish(job_id: str, event: dict[str, Any]) -> None:
    """Publish an event to all subscribers of a job (non-blocking)."""
    subs = _subscribers.get(job_id)
    if not subs:
        return
    # Add timestamp
    event.setdefault("ts", time.time())
    for q in list(subs):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # Drop oldest to keep up
            try:
                q.get_nowait()
                q.put_nowait(event)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass


def has_subscribers(job_id: str) -> bool:
    """Check if any SSE clients are watching this job."""
    return bool(_subscribers.get(job_id))
