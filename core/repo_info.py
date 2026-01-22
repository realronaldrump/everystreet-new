from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

# Path to version file generated at build time
VERSION_FILE = Path(__file__).parent.parent / "version.json"
GITHUB_REPO = os.getenv("GITHUB_REPO", "realronaldrump/everystreet-new")
GITHUB_BRANCH = os.getenv("GITHUB_BRANCH", "main")
GITHUB_API_TIMEOUT_SECONDS = 3


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


@lru_cache(maxsize=1)
def _get_github_commit_count() -> str | None:
    if not GITHUB_REPO:
        return None
    url = (
        f"https://api.github.com/repos/{GITHUB_REPO}/commits"
        f"?sha={GITHUB_BRANCH}&per_page=1"
    )
    request = Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "everystreet-repo-info",
        },
    )
    try:
        with urlopen(request, timeout=GITHUB_API_TIMEOUT_SECONDS) as response:
            link_header = response.headers.get("Link", "")
            body = response.read()
    except (HTTPError, URLError, TimeoutError, ValueError):
        return None

    if link_header:
        for part in link_header.split(","):
            if 'rel="last"' in part:
                match = re.search(r"[?&]page=(\d+)", part)
                if match:
                    return match.group(1)

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None
    if isinstance(data, list):
        return str(len(data))
    return None


def _format_commit_datetime(commit_iso: str | None) -> str:
    if not commit_iso:
        return "Unknown"
    try:
        parsed = datetime.fromisoformat(commit_iso)
    except ValueError:
        return "Unknown"
    return parsed.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def get_repo_version_info() -> RepoVersionInfo:
    github_commit_count = _get_github_commit_count()
    # First try to read from version file (for Docker deployments)
    version_info = _read_version_file()
    if version_info:
        if github_commit_count:
            return RepoVersionInfo(
                commit_count=github_commit_count,
                commit_hash=version_info.commit_hash,
                last_updated=version_info.last_updated,
            )
        return version_info

    # Fall back to git commands (for local development)
    commit_count = (
        github_commit_count
        or _run_git_command(["rev-list", "--count", "HEAD"])
        or "Unknown"
    )
    commit_hash = _run_git_command(["rev-parse", "--short", "HEAD"]) or "Unknown"
    commit_iso = _run_git_command(["log", "-1", "--format=%cI"])

    last_updated = _format_display_date(commit_iso) if commit_iso else "Unknown"
    return RepoVersionInfo(
        commit_count=commit_count,
        commit_hash=commit_hash,
        last_updated=last_updated,
    )
