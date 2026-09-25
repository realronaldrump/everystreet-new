import re
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from core.assets import (
    STATIC_ROOT,
    STYLESHEET_BUNDLES,
    css_bundle_response,
    get_css_bundle,
    library_preload_urls,
    match_route,
    module_preloads,
    route_entries,
)
from core.jinja import CDN

ROUTE_LOADER = Path(STATIC_ROOT, "js/modules/core/route-loader.js").read_text()


def test_every_bundled_stylesheet_exists_once() -> None:
    for paths in STYLESHEET_BUNDLES.values():
        assert len(paths) == len(set(paths))
        for path in paths:
            assert (STATIC_ROOT / "css" / path).is_file(), path


def test_css_bundle_keeps_cascade_order_and_rebases_urls() -> None:
    body = get_css_bundle("global").body.decode()
    positions = [body.index(f"/* {path} */") for path in STYLESHEET_BUNDLES["global"]]
    assert positions == sorted(positions)
    assert 'url("../images/landing/murano-ink.webp")' in body
    assert "../../images/" not in body
    assert 'url("#manual-hatch")' in body
    assert get_css_bundle("missing") is None


def test_css_bundle_route_validates_with_etag() -> None:
    app = FastAPI()

    @app.get("/static-v/{version}/{path:path}")
    async def versioned(version: str, path: str, request: Request):
        return css_bundle_response(path, request)

    client = TestClient(app)
    first = client.get("/static-v/7/css-bundles/map-features.css")
    assert first.status_code == 200
    assert first.headers["content-type"].startswith("text/css")
    assert "/* features/map/base.css */" in first.text
    again = client.get(
        "/static-v/7/css-bundles/map-features.css",
        headers={"If-None-Match": first.headers["etag"]},
    )
    assert again.status_code == 304


def test_route_table_matches_route_loader() -> None:
    declared = re.findall(r'"\.\./\.\./pages/([a-z0-9-]+)\.js"', ROUTE_LOADER)
    assert [entry.module for entry in route_entries()] == [
        f"pages/{name}.js" for name in declared
    ]
    assert match_route("/").module == "pages/landing.js"
    assert match_route("/trips").module == "pages/trips.js"
    assert match_route("/trips/abc/").module == "pages/trip-detail.js"
    assert match_route("/coverage-management/x").module == "pages/coverage-journal.js"
    assert match_route("/login") is None


def test_module_preloads_cover_the_page_module_graph() -> None:
    preloads = module_preloads("/map")
    assert preloads[0] == "app.js"
    # vendor/swup.js is built into the image, so a checkout may lack it.
    swup_built = (STATIC_ROOT / "js/vendor/swup.js").is_file()
    assert ("vendor/swup.js" in preloads) == swup_built
    for module in (
        "modules/core/navigation.js",
        "modules/core/route-loader.js",
        "pages/map.js",
        "modules/core/page-bootstrap.js",
    ):
        assert module in preloads
    assert len(preloads) == len(set(preloads))
    assert all((STATIC_ROOT / "js" / module).is_file() for module in preloads)
    assert "pages/map.js" not in module_preloads("/login")


def test_library_preloads_follow_route_libraries_and_provider() -> None:
    assert library_preload_urls("/insights", CDN, "self_hosted") == [
        CDN["chartjs"],
        CDN["deck_gl"],
    ]
    assert library_preload_urls("/map", CDN, "self_hosted") == [CDN["mapbox_gl_js"]]
    assert library_preload_urls("/map", CDN, "google") == []
    assert library_preload_urls("/export", CDN, None) == []
