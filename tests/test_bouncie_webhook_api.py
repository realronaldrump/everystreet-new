from unittest.mock import AsyncMock

import pytest

import bouncie_webhook_api as webhook_api


@pytest.mark.asyncio
async def test_dispatch_event_rejects_invalid_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_creds = AsyncMock(return_value={"webhook_key": "expected"})
    record = AsyncMock()
    handler = AsyncMock()

    monkeypatch.setattr(webhook_api, "get_bouncie_credentials", get_creds)
    monkeypatch.setattr(webhook_api, "record_webhook_event", record)
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
    monkeypatch.setattr(webhook_api, "record_webhook_event", record)
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripStart": handler})

    await webhook_api._dispatch_event(
        {"eventType": "tripStart", "payload": {"id": "trip-1"}},
        auth_header="new-key",
    )

    update.assert_awaited_once_with({"webhook_key": "new-key"})
    record.assert_awaited_once_with("tripStart")
    handler.assert_awaited_once()
