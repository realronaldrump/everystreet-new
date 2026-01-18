from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Path to version file generated at build time
VERSION_FILE = Path(__file__).parent.parent / "version.json"


@dataclass(frozen=True)
class RepoVersionInfo:
    commit_count: str
    commit_hash: str
    last_updated: str


def _read_version_file() -> Optional[RepoVersionInfo]:
    """Try to read version info from a pre-generated JSON file."""
    try:
        if VERSION_FILE.exists():
            data = json.loads(VERSION_FILE.read_text())
            return RepoVersionInfo(
                commit_count=data.get("commit_count", "Unknown"),
                commit_hash=data.get("commit_hash", "Unknown"),
                last_updated=data.get("last_updated", "Unknown"),
            )
    except (json.JSONDecodeError, OSError):
        pass
    return None


def _run_git_command(args: list[str]) -> Optional[str]:
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


def _format_commit_datetime(commit_iso: Optional[str]) -> str:
    if not commit_iso:
        return "Unknown"
    try:
        parsed = datetime.fromisoformat(commit_iso)
    except ValueError:
        return "Unknown"
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def get_repo_version_info() -> RepoVersionInfo:
    # First try to read from version file (for Docker deployments)
    version_info = _read_version_file()
    if version_info:
        return version_info

    # Fall back to git commands (for local development)
    commit_count = _run_git_command(["rev-list", "--count", "HEAD"]) or "Unknown"
    commit_hash = _run_git_command(["rev-parse", "--short", "HEAD"]) or "Unknown"
    commit_iso = _run_git_command(["log", "-1", "--format=%cI"])
    last_updated = _format_commit_datetime(commit_iso)
    return RepoVersionInfo(
        commit_count=commit_count,
        commit_hash=commit_hash,
        last_updated=last_updated,
    )
