from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

# Path to version file generated at build time
VERSION_FILE = Path(__file__).parent.parent / "version.json"


@dataclass(frozen=True)
class RepoVersionInfo:
    commit_count: str
    commit_hash: str
    last_updated: str


def _format_display_date(iso_date: str) -> str:
    """Format ISO date string to human readable display format in Central time."""
    try:
        dt = datetime.fromisoformat(iso_date)
        # Use Central timezone explicitly
        central = ZoneInfo("America/Chicago")
        return dt.astimezone(central).strftime("%B %d, %Y %I:%M %p")
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


def _run_git_command(args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _format_commit_datetime(commit_iso: str | None) -> str:
    if not commit_iso:
        return "Unknown"
    try:
        parsed = datetime.fromisoformat(commit_iso)
    except ValueError:
        return "Unknown"
    return parsed.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def get_repo_version_info() -> RepoVersionInfo:
    # First try to read from version file (for Docker deployments)
    version_info = _read_version_file()
    if version_info:
        return version_info

    # Fall back to git commands (for local development)
    commit_count = _run_git_command(["rev-list", "--count", "HEAD"]) or "Unknown"
    commit_hash = _run_git_command(["rev-parse", "--short", "HEAD"]) or "Unknown"
    commit_iso = _run_git_command(["log", "-1", "--format=%cI"])

    last_updated = _format_display_date(commit_iso) if commit_iso else "Unknown"
    return RepoVersionInfo(
        commit_count=commit_count,
        commit_hash=commit_hash,
        last_updated=last_updated,
    )
