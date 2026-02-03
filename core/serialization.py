from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from datetime import datetime


def serialize_datetime(dt: datetime | str | None) -> str | None:
    """Serialize a datetime or string to ISO format for JSON responses."""
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)
