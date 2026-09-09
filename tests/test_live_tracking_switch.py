import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from db_helpers import init_mock_beanie
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from admin.services.admin_service import AdminService
from core import live_tracking
from core.service_config import reset_service_config_state
from db.models import AppSettings
from tracking.api import live, webhooks
from tracking.services import tracking_service


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [None, False, "true", 1, True])
async def test_only_explicit_true_enables_tracking(monkeypatch, value):
    monkeypatch.setattr(
        live_tracking,
        "get_service_config",
        AsyncMock(return_value=SimpleNamespace(bouncieLiveTrackingEnabled=value)),
    )
    assert await live_tracking.is_enabled() is (value is True)


@pytest.mark.asyncio
async def test_missing_or_unavailable_settings_disable_tracking(monkeypatch):
    read = AsyncMock(return_value=SimpleNamespace(showLiveTracking=True))
    monkeypatch.setattr(live_tracking, "get_service_config", read)
    assert await live_tracking.is_enabled() is False
    read.side_effect = RuntimeError("unavailable")
    assert await live_tracking.is_enabled() is False


@pytest.mark.asyncio
async def test_switch_saves_independently_of_history_preferences():
    reset_service_config_state()
    try:
        await init_mock_beanie(AppSettings, database_name="test_live_switch")
        original = AppSettings(showLiveTracking=True, mapMatchTripsOnFetch=True)
        await original.insert()
        assert await live_tracking.is_enabled() is False
        for enabled in (True, False):
            saved = await AdminService.update_app_settings(
                {"bouncieLiveTrackingEnabled": enabled}
            )
            assert saved["bouncieLiveTrackingEnabled"] is enabled
            assert saved["mapMatchTripsOnFetch"] is True
            assert saved["geocodeTripsOnFetch"] is True
            assert await live_tracking.is_enabled() is enabled
    finally:
        reset_service_config_state()


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["false", "true", None, 0, 1])
async def test_settings_reject_non_boolean_switch(value):
    with pytest.raises(HTTPException) as error:
        await AdminService.update_app_settings({"bouncieLiveTrackingEnabled": value})
    assert error.value.status_code == 400


@pytest.fixture
def disabled(monkeypatch):
    monkeypatch.setattr(live_tracking, "is_enabled", AsyncMock(return_value=False))


def test_disabled_webhook_acknowledges_without_parsing_auth_or_dispatch(
    disabled, monkeypatch
):
    parse = AsyncMock(side_effect=AssertionError("must not parse payload"))
    auth = AsyncMock(side_effect=AssertionError("must not fetch credentials"))
    record = AsyncMock(side_effect=AssertionError("must not record delivery"))
    dispatch = AsyncMock(side_effect=AssertionError("must not dispatch"))
    monkeypatch.setattr(webhooks, "_parse_request_payload", parse)
    monkeypatch.setattr(webhooks, "_require_bouncie_authorization", auth)
    monkeypatch.setattr(webhooks, "_process_payload", dispatch)
    monkeypatch.setattr(webhooks.TrackingService, "record_webhook_event", record)
    app = FastAPI()
    app.include_router(webhooks.router)
    with TestClient(app) as client:
        response = client.post(webhooks.LIVE_BOUNCIE_WEBHOOK_PATH, content="not-json")
        simulator = client.post("/api/simulator/bouncie-webhook", json={})
    assert response.status_code == 200
    assert simulator.status_code == 409
    for call in (parse, auth, record, dispatch):
        call.assert_not_awaited()


def test_disabled_live_endpoints_never_read_or_subscribe(disabled, monkeypatch):
    active = AsyncMock(side_effect=AssertionError("must not read live state"))
    updates = AsyncMock(side_effect=AssertionError("must not read updates"))
    monkeypatch.setattr(live.TrackingService, "get_active_trip", active)
    monkeypatch.setattr(live.TrackingService, "get_trip_updates", updates)
    monkeypatch.setattr(live, "require_owner_websocket", lambda _: None)
    monkeypatch.setattr(live, "create_pubsub_redis", lambda: pytest.fail("subscribed"))
    app = FastAPI()
    app.include_router(live.router)
    with TestClient(app) as client:
        for path in ("/api/active_trip", "/api/trip_updates"):
            response = client.get(path)
            assert response.status_code == 200
            assert response.json()["enabled"] is False
            assert "trip" not in response.json()
        with client.websocket_connect("/ws/trips") as websocket:
            assert websocket.receive_json() == {
                "type": "tracking_disabled",
                "enabled": False,
            }
            assert websocket.receive()["type"] == "websocket.close"
    active.assert_not_awaited()
    updates.assert_not_awaited()


@pytest.mark.asyncio
async def test_disabling_an_open_socket_releases_redis(monkeypatch):
    monkeypatch.setattr(
        live_tracking, "is_enabled", AsyncMock(side_effect=[True, False])
    )
    monkeypatch.setattr(live, "require_owner_websocket", lambda _: None)
    monkeypatch.setattr(
        live.TrackingService, "get_active_trip", AsyncMock(return_value=None)
    )
    pubsub = SimpleNamespace(
        subscribe=AsyncMock(), unsubscribe=AsyncMock(), close=AsyncMock()
    )
    redis = SimpleNamespace(pubsub=lambda: pubsub, close=AsyncMock())
    monkeypatch.setattr(live, "create_pubsub_redis", lambda: redis)

    async def receive():
        await asyncio.Event().wait()

    socket = SimpleNamespace(
        accept=AsyncMock(), send_json=AsyncMock(), close=AsyncMock(), receive=receive
    )
    await live.websocket_endpoint(socket)
    socket.send_json.assert_awaited_once_with(
        {"type": "tracking_disabled", "enabled": False}
    )
    socket.close.assert_awaited_once()
    pubsub.subscribe.assert_awaited_once()
    pubsub.unsubscribe.assert_awaited_once()
    pubsub.close.assert_awaited_once()
    redis.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_disabled_service_never_touches_live_state_or_queues_history(
    disabled, monkeypatch
):
    calls = []
    for name in (
        "get_active_trip_snapshot",
        "get_trip_snapshot",
        "save_trip_snapshot",
        "clear_trip_snapshot",
        "is_trip_marked_closed",
        "enqueue_completed_trip_sync",
    ):
        call = AsyncMock(side_effect=AssertionError(name))
        calls.append(call)
        monkeypatch.setattr(tracking_service, name, call)
    # Valid-shaped events must not reach storage, including tripEnd's fast-sync path.
    payload = {
        "transactionId": "test-live-switch",
        "start": {"timestamp": "2026-09-08T12:00:00Z"},
        "end": {"timestamp": "2026-09-08T12:01:00Z"},
        "data": [{"timestamp": "2026-09-08T12:00:30Z", "gps": {"lat": 32, "lon": -97}}],
        "metrics": {"tripTime": 60},
    }
    for handler in (
        tracking_service.process_trip_start,
        tracking_service.process_trip_data,
        tracking_service.process_trip_metrics,
        tracking_service.process_trip_end,
    ):
        await handler(payload)
    assert await tracking_service.get_active_trip() is None
    for call in calls:
        call.assert_not_awaited()
