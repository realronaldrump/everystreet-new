from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

# Path to version file generated at build time
VERSION_FILE = Path(__file__).parent.parent / "version.json"


@dataclass(frozen=True)
class RepoVersionInfo:
    commit_count: str
    commit_hash: str
    last_updated: str


def _format_display_date(iso_date: str, tz_name: str = "America/Chicago") -> str:
    """Format ISO date string to human readable display format in the given timezone."""
    try:
        dt = datetime.fromisoformat(iso_date)
        tz = ZoneInfo(tz_name)
        return dt.astimezone(tz).strftime("%B %d, %Y %I:%M %p")
    except ValueError:
        return _format_commit_datetime(iso_date)


def _read_version_file() -> RepoVersionInfo | None:
    """Try to read version info from a pre-generated JSON file."""
    try:
        if VERSION_FILE.exists():
            data = json.loads(VERSION_FILE.read_text())
            raw_date = data.get("last_updated", "Unknown")
            last_updated = (
                _format_display_date(raw_date) if raw_date != "Unknown" else "Unknown"
            )
            return RepoVersionInfo(
                commit_count=data.get("commit_count", "Unknown"),
                commit_hash=data.get("commit_hash", "Unknown"),
                last_updated=last_updated,
            )
    except (json.JSONDecodeError, OSError):
        pass
    return None


def _format_commit_datetime(commit_iso: str | None) -> str:
    if not commit_iso:
        return "Unknown"
    try:
        parsed = datetime.fromisoformat(commit_iso)
    except ValueError:
        return "Unknown"
    return parsed.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


@lru_cache(maxsize=1)
def get_repo_version_info() -> RepoVersionInfo:
    """Get repository version information from build-generated metadata."""
    version_info = _read_version_file()
    if version_info and version_info.commit_count != "Unknown":
        return version_info

    return version_info or RepoVersionInfo(
        commit_count="Unknown",
        commit_hash="Unknown",
        last_updated="Unknown",
    )
