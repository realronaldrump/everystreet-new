from pathlib import Path
import re

from fastapi.testclient import TestClient

from app import app


def _content_block(template_name: str) -> str:
    template_path = Path(__file__).resolve().parents[1] / "templates" / template_name
    text = template_path.read_text(encoding="utf-8")
    match = re.search(r"{% block content %}(.*){% endblock %}", text, re.S)
    assert match is not None, f"Missing content block in {template_name}"
    return match.group(1)


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


def test_settings_and_profile_content_blocks_have_balanced_divs() -> None:
    for template_name in ("settings.html", "profile.html"):
        content = _content_block(template_name)
        open_divs = len(re.findall(r"<div\b", content))
        close_divs = len(re.findall(r"</div>", content))
        assert open_divs == close_divs, (
            f"{template_name} has unbalanced <div> tags "
            f"(open={open_divs}, close={close_divs})"
        )


def test_settings_and_profile_route_content_closes_before_footer() -> None:
    client = TestClient(app, raise_server_exceptions=False)

    for path in ("/settings", "/profile"):
        response = client.get(path)
        assert response.status_code == 200, f"{path} did not render successfully"
        html = response.text
        footer_pos = html.find('<footer class="app-footer">')
        assert footer_pos != -1, f"{path} is missing the app footer"

        route_content_close = _find_route_content_close(html)
        assert route_content_close != -1, f"{path} never closed #route-content"
        assert route_content_close < footer_pos, (
            f"{path} footer appears before #route-content closes, "
            "which can duplicate layout sections during SWUP container swaps"
        )
