"""Page asset planning: stylesheet bundles and preload hints.

Stylesheet manifests are concatenated into one response per bundle so a
page downloads a handful of stylesheets instead of dozens. Script preload
hints list every module a route statically imports, so the browser fetches
the whole module graph in parallel instead of discovering it one import
level at a time.
"""

from __future__ import annotations

import hashlib
import posixpath
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from starlette.requests import Request
from starlette.responses import Response

STATIC_ROOT = Path(__file__).resolve().parent.parent / "static"
CSS_BUNDLE_DIR = "css-bundles"

# Order is cascade order.
STYLESHEET_BUNDLES: dict[str, tuple[str, ...]] = {
    "global": (
        "core/variables.css",
        "core/reset.css",
        "core/typography.css",
        "core/utilities.css",
        "layout/header.css",
        "layout/layout.css",
        "layout/mobile.css",
        "layout/footer.css",
        "components/buttons.css",
        "components/cards.css",
        "components/manual.css",
        "components/masthead.css",
        "components/forms.css",
        "components/navigation-controls.css",
        "components/stepper.css",
        "components/status.css",
        "components/app-select.css",
        "components/tables.css",
        "components/notifications.css",
        "components/modals.css",
        "components/pagination.css",
        "components/mapbox-overrides.css",
        "components/immersive.css",
        "components/icons.css",
        "components/setup-required.css",
        "components/date-picker.css",
        "core/animations.css",
        "layout/navigation-experience.css",
        "components/loading.css",
        "components/route-tracer.css",
    ),
    "map-features": (
        "features/map/base.css",
        "features/map/atlas-rail.css",
        "features/map/map-plate.css",
        "features/map/layers.css",
        "features/map/popups.css",
        "features/map/live-tracking.css",
        "features/simulator.css",
        "features/map/particle-flow.css",
        "features/map/destination-bloom.css",
        "features/map/trip-replay.css",
    ),
    "live-navigation": (
        "features/navigation/steps.css",
        "features/navigation/mobile.css",
        "features/navigation/experience.css",
    ),
}

# Comments and strings are matched whole so a url() inside them (such as the
# filter reference inside an inline SVG data URI) is never rewritten.
_CSS_URL_OR_SKIPPED = re.compile(
    r"""/\*.*?\*/"""
    r"""|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^"'()\s]+))\s*\)"""
    r"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'""",
    re.DOTALL,
)


@dataclass(frozen=True)
class CssBundle:
    body: bytes
    etag: str


def _rebase_css_urls(css: str, source_path: str) -> str:
    """Point relative url() references at the bundle's own directory."""
    source_dir = posixpath.join("css", posixpath.dirname(source_path))

    def replace(match: re.Match[str]) -> str:
        double, single, bare = match.groups()
        ref = next((part for part in (double, single, bare) if part is not None), None)
        if not ref or ref.startswith(("#", "/", "data:")) or "://" in ref:
            return match.group(0)
        quote = '"' if double is not None else "'" if single is not None else ""
        target = posixpath.normpath(posixpath.join(source_dir, ref))
        rebased = posixpath.relpath(target, CSS_BUNDLE_DIR)
        return f"url({quote}{rebased}{quote})"

    return _CSS_URL_OR_SKIPPED.sub(replace, css)


@lru_cache(maxsize=16)
def _build_css_bundle(name: str, stamps: tuple[int, ...]) -> CssBundle:
    del stamps  # Part of the cache key only.
    parts = []
    for path in STYLESHEET_BUNDLES[name]:
        css = (STATIC_ROOT / "css" / path).read_text(encoding="utf-8")
        parts.append(f"/* {path} */\n{_rebase_css_urls(css, path)}\n")
    body = "".join(parts).encode("utf-8")
    return CssBundle(body=body, etag=f'"{hashlib.sha1(body).hexdigest()}"')  # nosec B324


def get_css_bundle(name: str) -> CssBundle | None:
    """Return the concatenated stylesheet bundle, or None for unknown names."""
    paths = STYLESHEET_BUNDLES.get(name)
    if paths is None:
        return None
    stamps = tuple((STATIC_ROOT / "css" / path).stat().st_mtime_ns for path in paths)
    return _build_css_bundle(name, stamps)


def css_bundle_response(path: str, request: Request) -> Response | None:
    """Serve ``css-bundles/<name>.css``; None when the path is not a bundle."""
    prefix = f"{CSS_BUNDLE_DIR}/"
    if not path.startswith(prefix) or not path.endswith(".css"):
        return None
    bundle = get_css_bundle(path[len(prefix) : -len(".css")])
    if bundle is None:
        return None
    if request.headers.get("if-none-match") == bundle.etag:
        return Response(status_code=304, headers={"ETag": bundle.etag})
    return Response(
        content=bundle.body,
        media_type="text/css",
        headers={"ETag": bundle.etag},
    )


# --- Script preloads -------------------------------------------------------

JS_ROOT = STATIC_ROOT / "js"
APP_ENTRY = "app.js"
# navigation.js always imports this with import(), right after app.js runs.
ALWAYS_LOADED_DYNAMIC = ("vendor/swup.js",)
ROUTE_LOADER = "modules/core/route-loader.js"

_STATIC_IMPORT = re.compile(
    r"""(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["'](\.{1,2}/[^"']+)["']""",
    re.MULTILINE,
)
_ROUTE_ENTRY = re.compile(
    r"""\[\s*"([^"]+)",\s*"([^"]+\.js)"(?:,\s*\[([^\]]*)\])?\s*,?\s*\]""",
)
_QUOTED = re.compile(r'"([^"]+)"')


@dataclass(frozen=True)
class RouteEntry:
    pattern: str
    module: str
    libraries: tuple[str, ...]


def _static_imports(module: str) -> list[str]:
    try:
        source = (JS_ROOT / module).read_text(encoding="utf-8")
    except OSError:
        return []
    base = posixpath.dirname(module)
    found = []
    for match in _STATIC_IMPORT.finditer(source):
        target = posixpath.normpath(posixpath.join(base, match.group(1)))
        if (JS_ROOT / target).is_file():
            found.append(target)
    return found


@lru_cache(maxsize=64)
def module_closure(entry: str) -> tuple[str, ...]:
    """Every module ``entry`` statically imports, directly or not."""
    seen: dict[str, None] = {}
    stack = [entry]
    while stack:
        module = stack.pop()
        if module in seen or not (JS_ROOT / module).is_file():
            continue
        seen[module] = None
        stack.extend(reversed(_static_imports(module)))
    return tuple(seen)


@lru_cache(maxsize=1)
def route_entries() -> tuple[RouteEntry, ...]:
    """The page routes declared in route-loader.js, in match order."""
    source = (JS_ROOT / ROUTE_LOADER).read_text(encoding="utf-8")
    base = posixpath.dirname(ROUTE_LOADER)
    return tuple(
        RouteEntry(
            pattern=match.group(1),
            module=posixpath.normpath(posixpath.join(base, match.group(2))),
            libraries=tuple(_QUOTED.findall(match.group(3) or "")),
        )
        for match in _ROUTE_ENTRY.finditer(source)
    )


def _normalize_path(path: str) -> str:
    if not path or path == "/":
        return "/"
    return path.removesuffix("/")


def _route_matches(pattern: str, path: str) -> bool:
    if not pattern.endswith("*"):
        return path == pattern
    prefix = pattern[:-1]
    return path == prefix[:-1] or path.startswith(prefix)


def match_route(path: str) -> RouteEntry | None:
    """Mirror route-loader.js: the first matching route wins."""
    normalized = _normalize_path(path)
    for entry in route_entries():
        if _route_matches(entry.pattern, normalized):
            return entry
    return None


@lru_cache(maxsize=64)
def _preloads_for_route(route_module: str | None) -> tuple[str, ...]:
    ordered: dict[str, None] = {}
    entries = (APP_ENTRY, *ALWAYS_LOADED_DYNAMIC)
    if route_module:
        entries = (*entries, route_module)
    for entry in entries:
        for module in module_closure(entry):
            ordered[module] = None
    return tuple(ordered)


def module_preloads(path: str) -> tuple[str, ...]:
    """Modules (relative to static/js) a page at ``path`` will load at start."""
    route = match_route(path)
    return _preloads_for_route(route.module if route else None)


def library_preload_urls(
    path: str, cdn: dict[str, str], map_provider: str | None
) -> list[str]:
    """CDN scripts route-loader will fetch for ``path`` before its page runs."""
    route = match_route(path)
    if route is None:
        return []
    urls = []
    for library in route.libraries:
        if library == "map":
            if str(map_provider or "").lower() != "google":
                urls.append(cdn["mapbox_gl_js"])
        elif library == "chart":
            urls.append(cdn["chartjs"])
        elif library == "deck":
            urls.append(cdn["deck_gl"])
        elif library == "topojson":
            urls.append(cdn["topojson"])
    return urls
