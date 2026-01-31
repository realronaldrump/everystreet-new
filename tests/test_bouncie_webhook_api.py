from unittest.mock import AsyncMock

import pytest

from tracking.api import webhooks as webhook_api


@pytest.mark.asyncio
async def test_dispatch_event_rejects_invalid_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_creds = AsyncMock(return_value={"webhook_key": "expected"})
    record = AsyncMock()
    handler = AsyncMock()

    monkeypatch.setattr(webhook_api, "get_bouncie_credentials", get_creds)
    monkeypatch.setattr(webhook_api.TrackingService, "record_webhook_event", record)
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripStart": handler})

    await webhook_api._dispatch_event({"eventType": "tripStart"}, auth_header="bad")

    record.assert_not_called()
    handler.assert_not_called()


@pytest.mark.asyncio
async def test_dispatch_event_saves_key_and_calls_handler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_creds = AsyncMock(return_value={"webhook_key": ""})
    update = AsyncMock(return_value=True)
    record = AsyncMock()
    handler = AsyncMock()

    monkeypatch.setattr(webhook_api, "get_bouncie_credentials", get_creds)
    monkeypatch.setattr(webhook_api, "update_bouncie_credentials", update)
    monkeypatch.setattr(webhook_api.TrackingService, "record_webhook_event", record)
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripStart": handler})

    await webhook_api._dispatch_event(
        {"eventType": "tripStart", "payload": {"id": "trip-1"}},
        auth_header="new-key",
    )

    update.assert_awaited_once_with({"webhook_key": "new-key"})
    record.assert_awaited_once_with("tripStart")
    handler.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_event_ignores_unknown_event_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unknown event types should be logged but not cause errors."""
    get_creds = AsyncMock(return_value={"webhook_key": ""})
    record = AsyncMock()

    monkeypatch.setattr(webhook_api, "get_bouncie_credentials", get_creds)
    monkeypatch.setattr(webhook_api.TrackingService, "record_webhook_event", record)
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {})

    # Should not raise
    await webhook_api._dispatch_event(
        {"eventType": "unknownEvent"},
        auth_header=None,
    )

    record.assert_awaited_once_with("unknownEvent")


@pytest.mark.asyncio
async def test_dispatch_event_handles_missing_event_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Missing eventType should log warning but not crash."""
    get_creds = AsyncMock(return_value={"webhook_key": ""})
    record = AsyncMock()

    monkeypatch.setattr(webhook_api, "get_bouncie_credentials", get_creds)
    monkeypatch.setattr(webhook_api.TrackingService, "record_webhook_event", record)
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {})

    # Should not raise even with missing eventType
    await webhook_api._dispatch_event({}, auth_header=None)

    record.assert_awaited_once_with(None)


@pytest.mark.asyncio
async def test_dispatch_event_catches_handler_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Handler exceptions should be caught and logged, not propagated."""
    get_creds = AsyncMock(return_value={"webhook_key": ""})
    record = AsyncMock()
    handler = AsyncMock(side_effect=ValueError("handler failed"))

    monkeypatch.setattr(webhook_api, "get_bouncie_credentials", get_creds)
    monkeypatch.setattr(webhook_api.TrackingService, "record_webhook_event", record)
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripStart": handler})

    # Should not raise
    await webhook_api._dispatch_event(
        {"eventType": "tripStart"},
        auth_header=None,
    )

    handler.assert_awaited_once()


def test_ok_response_returns_200() -> None:
    """_ok_response should return a 200 JSON response."""
    response = webhook_api._ok_response()

    assert response.status_code == 200
