from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from setup.services import bouncie_webhooks


def test_expected_webhook_url_uses_redirect_origin() -> None:
    url = bouncie_webhooks.get_expected_bouncie_webhook_url(
        {"redirect_uri": "https://www.everystreet.me/api/bouncie/callback"},
    )

    assert url == "https://www.everystreet.me/bouncie-webhook"


@pytest.mark.asyncio
async def test_monitor_creates_missing_webhook_when_public_probe_is_healthy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    update = AsyncMock(return_value=True)
    created = {
        "id": "wh_123",
        "name": bouncie_webhooks.LIVE_TRIP_WEBHOOK_NAME,
        "url": "https://www.everystreet.me/bouncie-webhook",
        "authKey": "generated-key",
        "active": True,
        "updatedAt": "2026-03-05T18:00:00Z",
    }

    monkeypatch.setattr(
        bouncie_webhooks,
        "get_bouncie_credentials",
        AsyncMock(
            return_value={
                "redirect_uri": "https://www.everystreet.me/api/bouncie/callback",
                "webhook_key": "",
            },
        ),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "probe_public_webhook",
        AsyncMock(
            return_value={
                "checked_at": datetime(2026, 3, 5, 18, 0, tzinfo=UTC),
                "ok": True,
                "status_code": 200,
                "error": None,
            },
        ),
    )
    monkeypatch.setattr(
        bouncie_webhooks.BouncieOAuth,
        "get_access_token",
        AsyncMock(return_value="token-123"),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "fetch_bouncie_webhooks",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "create_bouncie_webhook",
        AsyncMock(return_value=created),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "update_bouncie_credentials",
        update,
    )

    result = await bouncie_webhooks.ensure_bouncie_live_trip_webhook()

    assert result["status"] == "success"
    assert result["action"] == "created"
    update.assert_awaited_once()
    update_kwargs = update.await_args.args[0]
    assert update_kwargs["webhook_id"] == "wh_123"
    assert update_kwargs["webhook_url"] == "https://www.everystreet.me/bouncie-webhook"
    assert update_kwargs["webhook_active"] is True
    assert update_kwargs["webhook_key"] == "generated-key"


@pytest.mark.asyncio
async def test_monitor_does_not_create_webhook_when_public_endpoint_is_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    update = AsyncMock(return_value=True)
    create = AsyncMock()

    monkeypatch.setattr(
        bouncie_webhooks,
        "get_bouncie_credentials",
        AsyncMock(
            return_value={
                "redirect_uri": "https://www.everystreet.me/api/bouncie/callback",
                "webhook_key": "",
            },
        ),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "probe_public_webhook",
        AsyncMock(
            return_value={
                "checked_at": datetime(2026, 3, 5, 18, 0, tzinfo=UTC),
                "ok": False,
                "status_code": 530,
                "error": "HTTP 530",
            },
        ),
    )
    monkeypatch.setattr(
        bouncie_webhooks.BouncieOAuth,
        "get_access_token",
        AsyncMock(return_value="token-123"),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "fetch_bouncie_webhooks",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "create_bouncie_webhook",
        create,
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "update_bouncie_credentials",
        update,
    )

    result = await bouncie_webhooks.ensure_bouncie_live_trip_webhook()

    assert result["status"] == "error"
    create.assert_not_awaited()
    update.assert_awaited_once()
    assert update.await_args.args[0]["webhook_last_status_code"] == 530


@pytest.mark.asyncio
async def test_monitor_reactivates_existing_webhook_and_syncs_auth_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    update = AsyncMock(return_value=True)
    updated = {
        "id": "wh_existing",
        "name": bouncie_webhooks.LIVE_TRIP_WEBHOOK_NAME,
        "url": "https://www.everystreet.me/bouncie-webhook",
        "authKey": "portal-key",
        "active": True,
        "updatedAt": "2026-03-05T18:05:00Z",
    }

    monkeypatch.setattr(
        bouncie_webhooks,
        "get_bouncie_credentials",
        AsyncMock(
            return_value={
                "redirect_uri": "https://www.everystreet.me/api/bouncie/callback",
                "webhook_key": "stale-local-key",
            },
        ),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "probe_public_webhook",
        AsyncMock(
            return_value={
                "checked_at": datetime(2026, 3, 5, 18, 5, tzinfo=UTC),
                "ok": True,
                "status_code": 200,
                "error": None,
            },
        ),
    )
    monkeypatch.setattr(
        bouncie_webhooks.BouncieOAuth,
        "get_access_token",
        AsyncMock(return_value="token-123"),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "fetch_bouncie_webhooks",
        AsyncMock(
            return_value=[
                {
                    "id": "wh_existing",
                    "name": bouncie_webhooks.LIVE_TRIP_WEBHOOK_NAME,
                    "url": "https://www.everystreet.me/bouncie-webhook",
                    "authKey": "portal-key",
                    "events": ["tripStart", "tripData", "tripMetrics", "tripEnd"],
                    "active": False,
                    "updatedAt": "2026-03-05T18:04:00Z",
                }
            ],
        ),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "update_bouncie_webhook",
        AsyncMock(return_value=updated),
    )
    monkeypatch.setattr(
        bouncie_webhooks,
        "update_bouncie_credentials",
        update,
    )

    result = await bouncie_webhooks.ensure_bouncie_live_trip_webhook()

    assert result["status"] == "success"
    assert result["action"] == "updated"
    update.assert_awaited_once()
    update_kwargs = update.await_args.args[0]
    assert update_kwargs["webhook_key"] == "portal-key"
    assert update_kwargs["webhook_active"] is True
