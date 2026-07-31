"""
Process-local snapshot of user-managed settings.

Synchronous code cannot await a database read, so async callers publish
the current AppSettings values here and sync accessors read them back.

This deliberately does not touch ``os.environ``. Real environment
variables are operator configuration and always win; anything the user
edits in Settings lives here instead, where it can be refreshed rather
than being seeded once and then stuck for the lifetime of the process.

Kept free of imports so both ``config`` and ``core.service_config`` can
depend on it without a cycle.
"""

from __future__ import annotations

from typing import Any

# Settings that synchronous code needs to read.
PUBLISHED_SETTING_NAMES: tuple[str, ...] = (
    "nominatim_user_agent",
    "geofabrik_mirror",
    "osm_extracts_path",
    "coverageIncludeServiceRoads",
    "streetCoverageTripMode",
)

_snapshot: dict[str, Any] = {}


def publish_user_settings(values: dict[str, Any]) -> None:
    """Replace the snapshot with the currently stored settings."""
    _snapshot.clear()
    for name in PUBLISHED_SETTING_NAMES:
        if name in values:
            _snapshot[name] = values[name]


def user_setting(name: str, default: Any = None) -> Any:
    """Read a published setting, falling back to ``default``."""
    value = _snapshot.get(name)
    return default if value is None else value


def clear_user_settings() -> None:
    """Drop the snapshot so the next read falls back to defaults."""
    _snapshot.clear()
