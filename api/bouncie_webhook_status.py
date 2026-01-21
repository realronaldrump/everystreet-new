"""
Bouncie webhook status tracking.

Stores the latest webhook receipt for UI status displays.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from db import BouncieCredentials

logger = logging.getLogger(__name__)

_STATUS_UPDATE_INTERVAL_SECONDS = 10

_last_seen_at: datetime | None = None
_last_seen_event_type: str | None = None
_last_saved_at: datetime | None = None


async def record_webhook_event(event_type: str | None) -> None:
    """Record the latest webhook receipt for status reporting."""
    global _last_seen_at, _last_seen_event_type, _last_saved_at

    now = datetime.now(UTC)
    _last_seen_at = now
    _last_seen_event_type = event_type or None

    if _last_saved_at:
        delta = (now - _last_saved_at).total_seconds()
        if delta < _STATUS_UPDATE_INTERVAL_SECONDS:
            return

    try:
        creds = await BouncieCredentials.find_one(
            BouncieCredentials.id == "bouncie_credentials",
        )
        if not creds:
            creds = BouncieCredentials(id="bouncie_credentials")
            creds.last_webhook_at = now
            creds.last_webhook_event_type = _last_seen_event_type
            await creds.insert()
        else:
            creds.last_webhook_at = now
            creds.last_webhook_event_type = _last_seen_event_type
            await creds.save()
        _last_saved_at = now
    except Exception as exc:
        logger.debug("Failed to record Bouncie webhook status: %s", exc)


async def get_webhook_status() -> dict[str, Any]:
    """Return the latest webhook status snapshot."""
    last_seen_at = None
    event_type = None

    try:
        creds = await BouncieCredentials.find_one(
            BouncieCredentials.id == "bouncie_credentials",
        )
        if creds:
            last_seen_at = creds.last_webhook_at
            event_type = creds.last_webhook_event_type
    except Exception as exc:
        logger.debug("Failed to load Bouncie webhook status: %s", exc)

    if _last_seen_at and (not last_seen_at or _last_seen_at > last_seen_at):
        last_seen_at = _last_seen_at
        event_type = _last_seen_event_type

    return {
        "last_received": last_seen_at.isoformat() if last_seen_at else None,
        "event_type": event_type,
    }
