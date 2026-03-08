import re

from fastapi.testclient import TestClient

from app import app


def _find_route_content_close(html: str) -> int:
    start = html.find('<div id="route-content"')
    assert start != -1, "Missing #route-content container"
    content_start = html.find(">", start)
    assert content_start != -1, "Malformed #route-content opening tag"

    depth = 1
    token_re = re.compile(r"<div\b|</div>")
    for token_match in token_re.finditer(html, content_start + 1):
        token = token_match.group(0)
        if token == "<div":
            depth += 1
        else:
            depth -= 1
            if depth == 0:
                return token_match.end()
    return -1


def test_control_center_page_renders_core_settings_before_footer() -> None:
    client = TestClient(app, raise_server_exceptions=False)

    response = client.get("/control-center")
    assert response.status_code == 200

    html = response.text
    assert 'id="map-trips-within-coverage-only"' in html
    assert 'id="trip-layers-use-heatmap"' in html

    footer_pos = html.find('<footer class="app-footer">')
    assert footer_pos != -1, "Missing app footer"

    route_content_close = _find_route_content_close(html)
    assert route_content_close != -1, "Missing closing #route-content"
    assert route_content_close < footer_pos, (
        "Footer should appear after #route-content closes so page swaps do not"
        " duplicate layout sections"
    )
