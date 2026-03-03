from fastapi.testclient import TestClient

from app import app


client = TestClient(app, raise_server_exceptions=False)


def test_control_center_route_renders() -> None:
    response = client.get("/control-center")
    assert response.status_code == 200


def test_legacy_system_routes_removed() -> None:
    for path in ("/settings", "/status", "/server-logs", "/profile"):
        response = client.get(path)
        assert response.status_code == 404


def test_database_management_redirects_to_control_center_storage() -> None:
    response = client.get("/database-management", follow_redirects=False)
    assert response.status_code == 301
    assert response.headers.get("location") == "/control-center#storage"


def test_navigation_only_links_to_control_center_for_system_tools() -> None:
    response = client.get("/map")
    assert response.status_code == 200
    html = response.text

    assert 'href="/control-center"' in html
    assert 'href="/settings"' not in html
    assert 'href="/status"' not in html
    assert 'href="/server-logs"' not in html
    assert 'href="/profile"' not in html
