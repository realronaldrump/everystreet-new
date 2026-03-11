from __future__ import annotations

import os
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.middleware.sessions import SessionMiddleware

from core.auth import SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, get_session_secret, hash_password_for_owner, mark_owner_session
from tracking.api import live as live_api
from tracking.api.live import router

os.environ.setdefault("APP_SESSION_SECRET", "tracking-live-test-secret")
os.environ.setdefault("OWNER_PASSWORD_HASH", hash_password_for_owner("test-owner"))


def _create_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(
        SessionMiddleware,
        secret_key=get_session_secret(),
        session_cookie=SESSION_COOKIE_NAME,
        max_age=SESSION_TTL_SECONDS,
        same_site="lax",
        path="/",
        https_only=False,
    )

    @app.post("/__test/login")
    async def test_login(request: Request) -> dict[str, bool]:
        mark_owner_session(request)
        return {"ok": True}

    app.include_router(router)
    return app


def test_active_trip_endpoint_returns_live_payload() -> None:
    app = _create_app()
    active_trip = {
        "transactionId": "tx-live-api-1",
        "status": "active",
        "imei": "imei-1",
        "distance": 1.2,
        "pointsRecorded": 3,
        "lastUpdate": datetime(2026, 2, 21, 12, 0, tzinfo=UTC),
        "coordinates": [
            {
                "timestamp": datetime(2026, 2, 21, 11, 58, tzinfo=UTC),
                "lat": 32.0,
                "lon": -97.0,
            },
        ],
    }

    with (
        patch.object(
            live_api.TrackingService,
            "get_active_trip",
            new=AsyncMock(return_value=active_trip),
        ),
        TestClient(app) as client,
    ):
        client.post("/__test/login")
        response = client.get("/api/active_trip")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["has_active_trip"] is True
    assert payload["trip"]["transactionId"] == "tx-live-api-1"
    assert isinstance(payload["trip"]["distance"], float)
    assert isinstance(payload["trip"]["coordinates"], list)


def test_active_trip_endpoint_returns_no_active_payload() -> None:
    app = _create_app()

    with (
        patch.object(
            live_api.TrackingService,
            "get_active_trip",
            new=AsyncMock(return_value=None),
        ),
        TestClient(app) as client,
    ):
        client.post("/__test/login")
        response = client.get("/api/active_trip")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["has_active_trip"] is False
    assert payload["message"] == "No active trip"


def test_trip_updates_endpoint_returns_trip_snapshot() -> None:
    app = _create_app()

    with (
        patch.object(
            live_api.TrackingService,
            "get_trip_updates",
            new=AsyncMock(
                return_value={
                    "status": "success",
                    "has_update": True,
                    "trip": {
                        "transactionId": "tx-live-api-2",
                        "status": "active",
                        "distance": 2.5,
                    },
                },
            ),
        ),
        TestClient(app) as client,
    ):
        client.post("/__test/login")
        response = client.get("/api/trip_updates")

    assert response.status_code == 200
    payload = response.json()
    assert payload["has_update"] is True
    assert payload["trip"]["transactionId"] == "tx-live-api-2"
    assert "server_time" in payload


def test_trip_updates_endpoint_returns_no_update_after_clear() -> None:
    app = _create_app()

    with (
        patch.object(
            live_api.TrackingService,
            "get_trip_updates",
            new=AsyncMock(
                return_value={
                    "status": "success",
                    "has_update": False,
                    "message": "No active trip",
                },
            ),
        ),
        TestClient(app) as client,
    ):
        client.post("/__test/login")
        response = client.get("/api/trip_updates")

    assert response.status_code == 200
    payload = response.json()
    assert payload["has_update"] is False
    assert payload["message"] == "No active trip"
