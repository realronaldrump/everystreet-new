from __future__ import annotations

from typing import Any

from core.date_utils import ensure_utc


def serialize_datetime(dt: Any) -> str | None:
    """Serialize a datetime or string to ISO format for JSON responses."""
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)


def serialize_utc_datetime(dt: Any, *, timespec: str | None = None) -> str | None:
    """Serialize a datetime-like value as UTC ISO-8601 with a trailing Z."""
    timestamp = ensure_utc(dt)
    if timestamp is None:
        return None
    if timespec is None:
        value = timestamp.isoformat()
    else:
        value = timestamp.isoformat(timespec=timespec)
    return value.replace("+00:00", "Z")
