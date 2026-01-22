from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

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


def _get_github_repo_info() -> tuple[str | None, str | None, str | None]:
    if not GITHUB_REPO:
        return None, None, None
    url = (
        f"https://api.github.com/repos/{GITHUB_REPO}/commits"
        f"?sha={GITHUB_BRANCH}&per_page=1"
    )
    request = Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Cache-Control": "no-cache",
            "User-Agent": "everystreet-repo-info",
        },
    )
    try:
        with urlopen(request, timeout=GITHUB_API_TIMEOUT_SECONDS) as response:
            link_header = response.headers.get("Link", "")
            body = response.read()
    except (HTTPError, URLError, TimeoutError, ValueError):
        return None, None, None

    commit_count = None
    if link_header:
        for part in link_header.split(","):
            if 'rel="last"' in part:
                match = re.search(r"[?&]page=(\d+)", part)
                if match:
                    commit_count = match.group(1)
                    break

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return commit_count, None, None

    latest_iso = None
    latest_sha = None
    if isinstance(data, list) and data:
        latest = data[0]
        latest_sha = latest.get("sha")
        commit = latest.get("commit", {})
        committer = commit.get("committer") or commit.get("author") or {}
        latest_iso = committer.get("date")
        if commit_count is None:
            commit_count = str(len(data))

    if latest_sha:
        latest_sha = latest_sha[:7]  # Short hash

    return commit_count, latest_iso, latest_sha


def _format_commit_datetime(commit_iso: str | None) -> str:
    if not commit_iso:
        return "Unknown"
    try:
        parsed = datetime.fromisoformat(commit_iso)
    except ValueError:
        return "Unknown"
    return parsed.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def get_repo_version_info() -> RepoVersionInfo:
    """
    Get repository version information exclusively from GitHub API.
    No local caching or local git commands are used.
    """
    github_commit_count, github_commit_iso, github_sha = _get_github_repo_info()

    last_updated = (
        _format_display_date(github_commit_iso) if github_commit_iso else "Unknown"
    )

    return RepoVersionInfo(
        commit_count=github_commit_count or "Unknown",
        commit_hash=github_sha or "Unknown",
        last_updated=last_updated,
    )
