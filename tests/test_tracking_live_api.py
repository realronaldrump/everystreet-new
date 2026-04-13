from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.sessions import SessionMiddleware
from starlette.websockets import WebSocketState

from core.auth import SESSION_COOKIE_NAME, SESSION_TTL_SECONDS
from tracking.api import live as live_api
from tracking.api.live import router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(
        SessionMiddleware,
        secret_key="tracking-live-test-secret",
        session_cookie=SESSION_COOKIE_NAME,
        max_age=SESSION_TTL_SECONDS,
        same_site="lax",
        path="/",
        https_only=False,
    )

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
        response = client.get("/api/trip_updates")

    assert response.status_code == 200
    payload = response.json()
    assert payload["has_update"] is False
    assert payload["message"] == "No active trip"


@pytest.mark.asyncio
async def test_websocket_endpoint_releases_pubsub_on_idle_disconnect() -> None:
    class FakePubSub:
        def __init__(self) -> None:
            self.subscribed: list[str] = []
            self.unsubscribed: list[str] = []
            self.closed = False
            self.get_message_calls = 0

        async def subscribe(self, channel: str) -> None:
            self.subscribed.append(channel)

        async def get_message(
            self,
            *,
            ignore_subscribe_messages: bool,
            **kwargs,
        ) -> None:
            del ignore_subscribe_messages, kwargs
            self.get_message_calls += 1
            await asyncio.sleep(0)

        async def unsubscribe(self, channel: str) -> None:
            self.unsubscribed.append(channel)

        async def close(self) -> None:
            self.closed = True

    class FakeRedis:
        def __init__(self, pubsub: FakePubSub) -> None:
            self._pubsub = pubsub
            self.closed = False

        def pubsub(self) -> FakePubSub:
            return self._pubsub

        async def close(self) -> None:
            self.closed = True

    class FakeWebSocket:
        def __init__(self) -> None:
            self.application_state = WebSocketState.CONNECTED
            self.accepted = False

        async def accept(self) -> None:
            self.accepted = True

        async def send_text(self, _text: str) -> None:
            return None

        async def receive(self) -> dict[str, object]:
            return {"type": "websocket.disconnect", "code": 1000}

    fake_pubsub = FakePubSub()
    fake_redis = FakeRedis(fake_pubsub)
    websocket = FakeWebSocket()

    with (
        patch.object(live_api, "require_owner_websocket", return_value=None),
        patch.object(
            live_api.TrackingService,
            "get_active_trip",
            new=AsyncMock(return_value=None),
        ),
        patch.object(live_api, "create_pubsub_redis", return_value=fake_redis),
    ):
        await live_api.websocket_endpoint(websocket)

    assert websocket.accepted is True
    assert fake_pubsub.subscribed == ["trip_updates"]
    assert fake_pubsub.unsubscribed == ["trip_updates"]
    assert fake_pubsub.closed is True
    assert fake_redis.closed is True
