"""Static file serving with cache headers that suit per-deploy asset URLs."""

from __future__ import annotations

from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

REVALIDATE = "no-cache"
IMMUTABLE = "public, max-age=31536000, immutable"
_REVALIDATED_SUFFIXES = (".js", ".css", ".map")


class CacheControlStaticFiles(StaticFiles):
    """StaticFiles that makes unversioned scripts and styles revalidate.

    Pages load JS as ES modules that import each other by relative path, so a
    module fetched from /static must be checked on every load to avoid mixing
    files from two deploys.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code in {200, 304} and (path or "").lower().endswith(
            _REVALIDATED_SUFFIXES
        ):
            response.headers["Cache-Control"] = REVALIDATE
        return response


def versioned_cache_control(requested_version: str, current_version: str) -> str:
    """Cache policy for a file under /static-v/<version>/.

    Files under the running build's own version prefix never change: relative
    module imports stay inside that prefix, and the next deploy uses a new
    one. Browsers may keep those for a year without revalidating. A request
    for any other version (a page left open across a deploy, or a build with
    no version) is served from the current files, so it must revalidate.
    """
    if (
        current_version
        and current_version != "Unknown"
        and (requested_version == current_version)
    ):
        return IMMUTABLE
    return REVALIDATE
