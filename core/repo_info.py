from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import subprocess
from typing import Optional


@dataclass(frozen=True)
class RepoVersionInfo:
    commit_count: str
    commit_hash: str
    last_updated: str


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
    commit_count = _run_git_command(["rev-list", "--count", "HEAD"]) or "Unknown"
    commit_hash = _run_git_command(["rev-parse", "--short", "HEAD"]) or "Unknown"
    commit_iso = _run_git_command(["log", "-1", "--format=%cI"])
    last_updated = _format_commit_datetime(commit_iso)
    return RepoVersionInfo(
        commit_count=commit_count,
        commit_hash=commit_hash,
        last_updated=last_updated,
    )
