from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

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
async def test_dispatch_event_accepts_bearer_auth_format(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_creds = AsyncMock(return_value={"webhook_key": "expected-token"})
    record = AsyncMock()
    handler = AsyncMock()

    monkeypatch.setattr(webhook_api, "get_bouncie_credentials", get_creds)
    monkeypatch.setattr(webhook_api.TrackingService, "record_webhook_event", record)
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripStart": handler})

    await webhook_api._dispatch_event(
        {"eventType": "tripStart"},
        auth_header="Bearer expected-token",
    )

    record.assert_awaited_once_with("tripStart")
    handler.assert_awaited_once()


def test_webhook_accepts_x_bouncie_authorization_header(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        webhook_api,
        "get_bouncie_credentials",
        AsyncMock(return_value={"webhook_key": "expected-token"}),
    )
    monkeypatch.setattr(
        webhook_api.TrackingService,
        "record_webhook_event",
        AsyncMock(),
    )
    monkeypatch.setattr(
        webhook_api,
        "TRIP_EVENT_HANDLERS",
        {"tripStart": AsyncMock()},
    )

    resp = webhook_client.post(
        "/bouncie-webhook",
        json={"eventType": "tripStart", "transactionId": "t-1"},
        headers={"X-Bouncie-Authorization": "expected-token"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_dispatch_event_saves_key_and_calls_handler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_creds = AsyncMock(
        return_value={
            "webhook_key": "",
            "client_id": "client-1",
            "authorization_code": "auth-code-1",
        },
    )
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


@pytest.mark.asyncio
async def test_dispatch_event_saves_normalized_key_when_header_has_whitespace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_creds = AsyncMock(
        return_value={
            "webhook_key": "",
            "client_id": "client-1",
            "authorization_code": "auth-code-1",
        },
    )
    update = AsyncMock(return_value=True)
    record = AsyncMock()
    handler = AsyncMock()

    monkeypatch.setattr(webhook_api, "get_bouncie_credentials", get_creds)
    monkeypatch.setattr(webhook_api, "update_bouncie_credentials", update)
    monkeypatch.setattr(webhook_api.TrackingService, "record_webhook_event", record)
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripStart": handler})

    await webhook_api._dispatch_event(
        {"eventType": "tripStart"},
        auth_header="  abc123  ",
    )

    update.assert_awaited_once_with({"webhook_key": "abc123"})
    record.assert_awaited_once_with("tripStart")
    handler.assert_awaited_once()


def test_ok_response_returns_200() -> None:
    """_ok_response should return a 200 JSON response."""
    response = webhook_api._ok_response()

    assert response.status_code == 200


# ---------------------------------------------------------------------------
# HTTP integration tests — verify the endpoint always returns 200
# ---------------------------------------------------------------------------

@pytest.fixture
def webhook_client() -> TestClient:
    """FastAPI test client with only the webhook router mounted."""
    app = FastAPI()
    app.include_router(webhook_api.router)
    return TestClient(app)


_WEBHOOK_PATHS = [
    "/bouncie-webhook",
    "/bouncie-webhook/",
]


@pytest.mark.parametrize("path", _WEBHOOK_PATHS)
def test_webhook_returns_200_for_valid_json(
    webhook_client: TestClient,
    path: str,
) -> None:
    """Every registered path must return 200 for a valid JSON payload."""
    resp = webhook_client.post(
        path,
        json={"eventType": "tripStart", "transactionId": "t-1"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_webhook_returns_200_for_empty_body(
    webhook_client: TestClient,
) -> None:
    """Empty request body must still return 200."""
    resp = webhook_client.post("/bouncie-webhook", content=b"")
    assert resp.status_code == 200


def test_webhook_returns_200_for_invalid_json(
    webhook_client: TestClient,
) -> None:
    """Malformed JSON must still return 200."""
    resp = webhook_client.post("/bouncie-webhook", content=b"not json")
    assert resp.status_code == 200


def test_webhook_returns_200_for_non_dict_json(
    webhook_client: TestClient,
) -> None:
    """JSON arrays or scalars must still return 200."""
    resp = webhook_client.post("/bouncie-webhook", content=b"[1,2,3]")
    assert resp.status_code == 200


def test_webhook_returns_200_for_invalid_auth_header(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        webhook_api,
        "get_bouncie_credentials",
        AsyncMock(return_value={"webhook_key": "expected"}),
    )

    resp = webhook_client.post(
        "/bouncie-webhook",
        json={"eventType": "tripStart", "transactionId": "t-1"},
        headers={"Authorization": "bad"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_webhook_returns_200_even_if_handler_crashes(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        webhook_api,
        "get_bouncie_credentials",
        AsyncMock(return_value={"webhook_key": ""}),
    )
    monkeypatch.setattr(
        webhook_api,
        "TRIP_EVENT_HANDLERS",
        {"tripStart": AsyncMock(side_effect=RuntimeError("boom"))},
    )

    resp = webhook_client.post(
        "/bouncie-webhook",
        json={"eventType": "tripStart", "transactionId": "t-1"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "path",
    [
        "/webhook/bouncie",
        "/webhook/bouncie/",
        "/api/webhooks/bouncie",
        "/api/webhooks/bouncie/",
    ],
)
def test_legacy_webhook_aliases_are_removed(
    webhook_client: TestClient,
    path: str,
) -> None:
    resp = webhook_client.post(path, json={"eventType": "tripStart"})
    assert resp.status_code == 404


def test_webhook_no_api_route_decorator() -> None:
    """Ensure the webhook handler is NOT wrapped by @api_route.

    The @api_route decorator converts exceptions to non-2xx HTTPExceptions,
    which would cause Bouncie to deactivate the webhook.
    """
    # The actual handler function (unwrapped) should be bouncie_webhook.
    # If @api_route were applied, the function would be wrapped in a
    # closure named 'wrapper'.
    assert webhook_api.bouncie_webhook.__name__ == "bouncie_webhook"
