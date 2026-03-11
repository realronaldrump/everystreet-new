from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.testclient import TestClient
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.websockets import WebSocketDisconnect

from api.pages import router as pages_router
from auth.api import router as auth_router
from core.auth import (
    AuthGuardMiddleware,
    SESSION_COOKIE_NAME,
    SESSION_TTL_SECONDS,
    hash_password_for_owner,
    parse_allowed_hosts,
    parse_cors_allowed_origins,
    require_owner_websocket,
    get_session_secret,
)
from tracking.api import live as live_api


class _FakeSettings:
    map_provider = "self_hosted"
    mapTripsWithinCoverageOnly = False
    tripLayersUseHeatmap = True
    google_maps_api_key = None


class _FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, int] = {}

    async def get(self, key: str) -> str | None:
        value = self.values.get(key)
        return None if value is None else str(value)

    async def incr(self, key: str) -> int:
        next_value = self.values.get(key, 0) + 1
        self.values[key] = next_value
        return next_value

    async def expire(self, _key: str, _seconds: int) -> bool:
        return True

    async def delete(self, key: str) -> int:
        self.values.pop(key, None)
        return 1


class _FakePubSub:
    async def subscribe(self, _channel: str) -> None:
        return None

    async def unsubscribe(self, _channel: str) -> None:
        return None

    async def close(self) -> None:
        return None

    async def listen(self) -> AsyncIterator[dict[str, object]]:
        if False:  # pragma: no cover
            yield {}


class _FakePubSubRedis:
    def pubsub(self) -> _FakePubSub:
        return _FakePubSub()

    async def close(self) -> None:
        return None


@pytest.fixture
def auth_test_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    password = "owner-secret"
    monkeypatch.setenv("APP_SESSION_SECRET", "test-session-secret")
    monkeypatch.setenv("OWNER_PASSWORD_HASH", hash_password_for_owner(password))
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://testserver")
    monkeypatch.setenv("ALLOWED_HOSTS", "testserver")

    fake_redis = _FakeRedis()

    async def fake_get_settings() -> _FakeSettings:
        return _FakeSettings()

    async def fake_get_shared_redis() -> _FakeRedis:
        return fake_redis

    async def fake_get_active_trip() -> dict[str, object]:
        return {
            "transactionId": "trip-1",
            "status": "active",
            "distance": 1.2,
        }

    monkeypatch.setattr(
        "admin.services.admin_service.AdminService.get_persisted_app_settings",
        staticmethod(fake_get_settings),
    )
    monkeypatch.setattr("core.auth.get_shared_redis", fake_get_shared_redis)
    monkeypatch.setattr(
        live_api.TrackingService,
        "get_active_trip",
        staticmethod(fake_get_active_trip),
    )
    monkeypatch.setattr(
        live_api.TrackingService,
        "get_trip_updates",
        staticmethod(lambda: fake_get_active_trip()),
    )
    monkeypatch.setattr(
        live_api,
        "create_pubsub_redis",
        lambda: _FakePubSubRedis(),
    )

    app = FastAPI()
    app.mount("/static", StaticFiles(directory="static"), name="static")
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=parse_allowed_hosts(),
    )
    app.add_middleware(AuthGuardMiddleware)
    app.add_middleware(
        SessionMiddleware,
        secret_key=get_session_secret(),
        session_cookie=SESSION_COOKIE_NAME,
        max_age=SESSION_TTL_SECONDS,
        same_site="lax",
        path="/",
        https_only=True,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=parse_cors_allowed_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth_router)
    app.include_router(pages_router)
    app.include_router(live_api.router)

    @app.get("/api/private")
    async def private_api() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/private-write")
    async def private_write() -> dict[str, str]:
        return {"status": "updated"}

    @app.post("/api/routing/route")
    async def public_route_compute() -> dict[str, str]:
        return {"status": "ok"}

    @app.websocket("/ws/protected")
    async def protected_socket(websocket: WebSocket) -> None:
        require_owner_websocket(websocket)
        await websocket.accept()
        await websocket.send_json({"ok": True})
        await websocket.close()

    return TestClient(app, base_url="https://testserver")


def _login(client: TestClient, password: str = "owner-secret") -> TestClient:
    response = client.post(
        "/login",
        data={"password": password, "next": "/map"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    return client


def _cookie_header(client: TestClient) -> dict[str, str]:
    cookie = client.cookies.get(SESSION_COOKIE_NAME)
    assert cookie
    return {"cookie": f"{SESSION_COOKIE_NAME}={cookie}"}


def test_login_sets_secure_owner_session_cookie(auth_test_client: TestClient) -> None:
    response = auth_test_client.post(
        "/login",
        data={"password": "owner-secret", "next": "/map"},
        follow_redirects=False,
    )

    assert response.status_code == 303
    cookie_header = response.headers["set-cookie"].lower()
    assert f"{SESSION_COOKIE_NAME}=" in cookie_header
    assert "secure" in cookie_header
    assert "httponly" in cookie_header


def test_failed_login_rate_limits_after_ten_attempts(auth_test_client: TestClient) -> None:
    for _ in range(10):
        response = auth_test_client.post(
            "/login",
            data={"password": "wrong-password", "next": "/map"},
        )
        assert response.status_code == 401

    blocked = auth_test_client.post(
        "/login",
        data={"password": "wrong-password", "next": "/map"},
    )
    assert blocked.status_code == 429


def test_owner_only_page_redirects_viewer_to_login(auth_test_client: TestClient) -> None:
    response = auth_test_client.get("/control-center", follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"].startswith("/login?next=/control-center")


def test_owner_only_api_rejects_viewer_and_requires_csrf(auth_test_client: TestClient) -> None:
    viewer_response = auth_test_client.get("/api/private")
    assert viewer_response.status_code == 401

    client = _login(auth_test_client)
    no_csrf = client.post("/api/private-write")
    assert no_csrf.status_code == 403

    session_payload = client.get("/api/auth/session").json()
    csrf_token = session_payload["csrf_token"]
    with_csrf = client.post(
        "/api/private-write",
        headers={"X-CSRF-Token": csrf_token},
    )
    assert with_csrf.status_code == 200
    assert with_csrf.json() == {"status": "updated"}


def test_viewer_public_map_page_renders_shell_banner(auth_test_client: TestClient) -> None:
    response = auth_test_client.get("/map")

    assert response.status_code == 200
    assert 'data-viewer-mode="true"' in response.text
    assert "Viewer mode is active." in response.text


def test_viewer_live_trip_endpoint_returns_empty_state(auth_test_client: TestClient) -> None:
    response = auth_test_client.get("/api/active_trip")

    assert response.status_code == 200
    body = response.json()
    assert body["has_active_trip"] is False


def test_owner_live_trip_endpoint_returns_real_payload(auth_test_client: TestClient) -> None:
    client = _login(auth_test_client)

    response = client.get("/api/active_trip")
    assert response.status_code == 200
    assert response.json()["trip"]["transactionId"] == "trip-1"


def test_websocket_requires_owner_session(auth_test_client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect):
        with auth_test_client.websocket_connect("/ws/protected"):
            pass

    client = _login(auth_test_client)
    with client.websocket_connect("/ws/protected", headers=_cookie_header(client)) as websocket:
        assert websocket.receive_json() == {"ok": True}


def test_live_trip_websocket_requires_owner_session(auth_test_client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect):
        with auth_test_client.websocket_connect("/ws/trips"):
            pass

    client = _login(auth_test_client)
    with client.websocket_connect("/ws/trips", headers=_cookie_header(client)) as websocket:
        payload = websocket.receive_json()
        assert payload["type"] == "trip_state"
        assert payload["trip"]["transactionId"] == "trip-1"


def test_cors_allows_only_configured_origins(auth_test_client: TestClient) -> None:
    allowed = auth_test_client.options(
        "/api/routing/route",
        headers={
            "Origin": "https://testserver",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert allowed.headers["access-control-allow-origin"] == "https://testserver"

    blocked = auth_test_client.options(
        "/api/routing/route",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in blocked.headers
