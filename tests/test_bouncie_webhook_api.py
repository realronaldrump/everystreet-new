from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tracking.api import webhooks as webhook_api


@pytest.fixture
def webhook_client() -> TestClient:
    app = FastAPI()
    app.include_router(webhook_api.router)
    return TestClient(app)


def _trip_start_payload() -> dict[str, object]:
    return {
        "eventType": "tripStart",
        "imei": "353816090000794",
        "vin": "1FTFW1E88MFA00001",
        "transactionId": "tx-live-1",
        "start": {
            "timestamp": "2026-02-21T12:00:00Z",
            "timeZone": "UTC",
            "odometer": 1234.5,
        },
    }


def _trip_data_payload() -> dict[str, object]:
    return {
        "eventType": "tripData",
        "imei": "353816090000794",
        "vin": "1FTFW1E88MFA00001",
        "transactionId": "tx-live-1",
        "data": [
            {
                "timestamp": "2026-02-21T12:01:00Z",
                "speed": 22.5,
                "gps": {
                    "lat": 32.0,
                    "lon": -97.0,
                    "heading": 90.0,
                },
                "fuelLevelInput": 72.0,
            },
        ],
    }


def _trip_metrics_payload() -> dict[str, object]:
    return {
        "eventType": "tripMetrics",
        "imei": "353816090000794",
        "vin": "1FTFW1E88MFA00001",
        "transactionId": "tx-live-1",
        "metrics": {
            "timestamp": "2026-02-21T12:02:00Z",
            "tripTime": 120,
            "tripDistance": 1.4,
            "totalIdlingTime": 0,
            "maxSpeed": 42,
            "averageDriveSpeed": 28,
            "hardBrakingCounts": 0,
            "hardAccelerationCounts": 1,
        },
    }


def _trip_end_payload() -> dict[str, object]:
    return {
        "eventType": "tripEnd",
        "imei": "353816090000794",
        "vin": "1FTFW1E88MFA00001",
        "transactionId": "tx-live-1",
        "end": {
            "timestamp": "2026-02-21T12:03:00Z",
            "timeZone": "UTC",
            "odometer": 1235.0,
            "fuelConsumed": 0.2,
        },
    }


def _patch_authorized_handler(
    monkeypatch: pytest.MonkeyPatch,
    *,
    event_type: str = "tripStart",
    handler: AsyncMock | None = None,
) -> AsyncMock:
    handler = handler or AsyncMock()
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
        {event_type: handler},
    )
    return handler


def test_live_webhook_accepts_authorized_trip_start(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _patch_authorized_handler(monkeypatch)

    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        json=_trip_start_payload(),
        headers={"Authorization": "expected-token"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    handler.assert_awaited_once()
    webhook_api.TrackingService.record_webhook_event.assert_awaited_once_with(
        "tripStart",
    )


def test_live_webhook_accepts_x_bouncie_authorization_header(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _patch_authorized_handler(monkeypatch)

    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        json=_trip_start_payload(),
        headers={"X-Bouncie-Authorization": "expected-token"},
    )

    assert resp.status_code == 200
    handler.assert_awaited_once()


def test_live_webhook_rejects_missing_configured_key(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = AsyncMock()
    monkeypatch.setattr(
        webhook_api,
        "get_bouncie_credentials",
        AsyncMock(return_value={"webhook_key": ""}),
    )
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripStart": handler})

    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        json=_trip_start_payload(),
        headers={"Authorization": "anything"},
    )

    assert resp.status_code == 503
    handler.assert_not_awaited()


def test_live_webhook_rejects_invalid_auth(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _patch_authorized_handler(monkeypatch)

    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        json=_trip_start_payload(),
        headers={"Authorization": "bad-token"},
    )

    assert resp.status_code == 401
    handler.assert_not_awaited()
    webhook_api.TrackingService.record_webhook_event.assert_not_awaited()


@pytest.mark.parametrize(
    ("payload", "event_type"),
    [
        (_trip_start_payload(), "tripStart"),
        (_trip_data_payload(), "tripData"),
        (_trip_metrics_payload(), "tripMetrics"),
        (_trip_end_payload(), "tripEnd"),
    ],
)
def test_live_webhook_accepts_documented_trip_payload_shapes(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, object],
    event_type: str,
) -> None:
    handler = _patch_authorized_handler(monkeypatch, event_type=event_type)

    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        json=payload,
        headers={"Authorization": "expected-token"},
    )

    assert resp.status_code == 200
    handler.assert_awaited_once_with(payload)


def test_live_webhook_rejects_empty_body(webhook_client: TestClient) -> None:
    resp = webhook_client.post(webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH, content=b"")

    assert resp.status_code == 400


def test_live_webhook_rejects_invalid_json(webhook_client: TestClient) -> None:
    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        content=b"not json",
    )

    assert resp.status_code == 400


def test_live_webhook_rejects_non_object_json(webhook_client: TestClient) -> None:
    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        content=b"[1,2,3]",
    )

    assert resp.status_code == 400


def test_live_webhook_acknowledges_unsupported_event_type(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _patch_authorized_handler(monkeypatch)
    payload = _trip_start_payload()
    payload["eventType"] = "connect"

    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        json=payload,
        headers={"Authorization": "expected-token"},
    )

    assert resp.status_code == 200
    handler.assert_not_awaited()
    webhook_api.TrackingService.record_webhook_event.assert_awaited_once_with(
        "connect",
    )


def test_live_webhook_acknowledges_trip_data_without_gps_heading(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _patch_authorized_handler(monkeypatch, event_type="tripData")
    payload = _trip_data_payload()
    data = payload["data"]
    assert isinstance(data, list)
    point = data[0]
    assert isinstance(point, dict)
    gps = point["gps"]
    assert isinstance(gps, dict)
    gps.pop("heading")

    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        json=payload,
        headers={"Authorization": "expected-token"},
    )

    assert resp.status_code == 200
    handler.assert_awaited_once_with(payload)


def test_live_webhook_acknowledges_when_processing_fails(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = AsyncMock(side_effect=RuntimeError("boom"))
    _patch_authorized_handler(monkeypatch, handler=handler)

    resp = webhook_client.post(
        webhook_api.LIVE_BOUNCIE_WEBHOOK_PATH,
        json=_trip_start_payload(),
        headers={"Authorization": "expected-token"},
    )

    assert resp.status_code == 200
    webhook_api.TrackingService.record_webhook_event.assert_awaited_once_with(
        "tripStart",
    )


def test_simulator_webhook_bypasses_real_auth(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = AsyncMock()
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripStart": handler})

    resp = webhook_client.post(
        "/api/simulator/bouncie-webhook",
        json=_trip_start_payload(),
    )

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    handler.assert_awaited_once()


def test_simulator_webhook_rejects_trip_data_without_required_gps_heading(
    webhook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = AsyncMock()
    monkeypatch.setattr(webhook_api, "TRIP_EVENT_HANDLERS", {"tripData": handler})
    payload = _trip_data_payload()
    data = payload["data"]
    assert isinstance(data, list)
    point = data[0]
    assert isinstance(point, dict)
    gps = point["gps"]
    assert isinstance(gps, dict)
    gps.pop("heading")

    resp = webhook_client.post(
        "/api/simulator/bouncie-webhook",
        json=payload,
    )

    assert resp.status_code == 400
    handler.assert_not_awaited()


@pytest.mark.parametrize(
    "path",
    [
        "/bouncie-webhook",
        "/bouncie-webhook/",
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
