"""Bouncie webhook monitoring and reconciliation helpers."""

from __future__ import annotations

import logging
import secrets
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from config import API_BASE_URL
from core.date_utils import parse_timestamp
from core.http.session import get_session
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
)
from setup.services.bouncie_oauth import BouncieOAuth

logger = logging.getLogger(__name__)

LIVE_TRIP_WEBHOOK_NAME = "EveryStreet Live Trip Tracking"
LIVE_TRIP_WEBHOOK_EVENTS = [
    "tripStart",
    "tripData",
    "tripMetrics",
    "tripEnd",
]


def _normalize_webhook_url(url: str | None) -> str | None:
    if not url:
        return None
    stripped = str(url).strip()
    if not stripped:
        return None
    return stripped.rstrip("/")


def get_expected_bouncie_webhook_url(credentials: dict[str, Any]) -> str | None:
    """Derive the public webhook URL from the configured redirect URI."""
    redirect_uri = str(credentials.get("redirect_uri") or "").strip()
    if not redirect_uri:
        return None

    parts = urlsplit(redirect_uri)
    if not parts.scheme or not parts.netloc:
        return None

    return urlunsplit((parts.scheme, parts.netloc, "/bouncie-webhook", "", ""))


def _parse_bouncie_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    try:
        return parse_timestamp(value)
    except Exception:
        return None


def _normalize_auth_key(value: Any) -> str:
    return str(value or "").strip()


def _build_webhook_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": token,
        "Content-Type": "application/json",
    }


async def probe_public_webhook(webhook_url: str | None) -> dict[str, Any]:
    """Probe the public webhook endpoint via GET to verify edge reachability."""
    checked_at = datetime.now(UTC)
    if not webhook_url:
        return {
            "checked_at": checked_at,
            "ok": False,
            "status_code": None,
            "error": "Webhook URL is not configured",
        }

    session = await get_session()
    try:
        async with session.get(webhook_url) as response:
            return {
                "checked_at": checked_at,
                "ok": 200 <= response.status < 300,
                "status_code": response.status,
                "error": None if 200 <= response.status < 300 else f"HTTP {response.status}",
            }
    except Exception as exc:
        logger.warning("Failed to probe public webhook %s: %s", webhook_url, exc)
        return {
            "checked_at": checked_at,
            "ok": False,
            "status_code": None,
            "error": str(exc),
        }


async def fetch_bouncie_webhooks(token: str) -> list[dict[str, Any]]:
    """Fetch the webhooks configured for the current Bouncie application."""
    session = await get_session()
    async with session.get(
        f"{API_BASE_URL}/webhooks",
        headers=_build_webhook_headers(token),
    ) as response:
        response.raise_for_status()
        payload = await response.json()

    if not isinstance(payload, list):
        msg = "Unexpected Bouncie webhook response format"
        raise TypeError(msg)

    return [item for item in payload if isinstance(item, dict)]


async def create_bouncie_webhook(
    token: str,
    *,
    webhook_url: str,
    auth_key: str,
) -> dict[str, Any]:
    """Create the canonical live-trip webhook in Bouncie."""
    session = await get_session()
    payload = {
        "name": LIVE_TRIP_WEBHOOK_NAME,
        "url": webhook_url,
        "authKey": auth_key,
        "events": LIVE_TRIP_WEBHOOK_EVENTS,
        "active": True,
    }
    async with session.post(
        f"{API_BASE_URL}/webhooks",
        headers=_build_webhook_headers(token),
        json=payload,
    ) as response:
        response.raise_for_status()
        created = await response.json()

    if not isinstance(created, dict):
        msg = "Unexpected Bouncie create-webhook response format"
        raise TypeError(msg)

    return created


async def update_bouncie_webhook(
    token: str,
    webhook_id: str,
    *,
    webhook_url: str,
    auth_key: str,
    active: bool,
) -> dict[str, Any]:
    """Update the canonical live-trip webhook in Bouncie."""
    session = await get_session()
    payload = {
        "name": LIVE_TRIP_WEBHOOK_NAME,
        "url": webhook_url,
        "authKey": auth_key,
        "events": LIVE_TRIP_WEBHOOK_EVENTS,
        "active": active,
    }
    async with session.put(
        f"{API_BASE_URL}/webhooks/{webhook_id}",
        headers=_build_webhook_headers(token),
        json=payload,
    ) as response:
        response.raise_for_status()
        updated = await response.json()

    if not isinstance(updated, dict):
        msg = "Unexpected Bouncie update-webhook response format"
        raise TypeError(msg)

    return updated


def _select_webhook_candidate(
    webhooks: list[dict[str, Any]],
    webhook_url: str,
) -> dict[str, Any] | None:
    normalized_target = _normalize_webhook_url(webhook_url)
    if normalized_target:
        for webhook in webhooks:
            current_url = _normalize_webhook_url(webhook.get("url"))
            if current_url == normalized_target:
                return webhook
    for webhook in webhooks:
        if str(webhook.get("name") or "").strip() == LIVE_TRIP_WEBHOOK_NAME:
            return webhook
    return None


def _build_metadata_update(
    *,
    probe: dict[str, Any],
    webhook_url: str | None,
    webhook: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "webhook_url": webhook.get("url") if webhook else webhook_url,
        "webhook_id": webhook.get("id") if webhook else None,
        "webhook_name": webhook.get("name") if webhook else None,
        "webhook_active": webhook.get("active") if webhook else None,
        "webhook_updated_at": (
            _parse_bouncie_timestamp(webhook.get("updatedAt")) if webhook else None
        ),
        "webhook_last_checked_at": probe.get("checked_at"),
        "webhook_last_status_code": probe.get("status_code"),
        "webhook_last_public_ok": probe.get("ok"),
        "webhook_last_error": probe.get("error"),
    }


async def ensure_bouncie_live_trip_webhook(
    *,
    force_reactivate: bool = False,
) -> dict[str, Any]:
    """
    Reconcile the Bouncie webhook with app expectations and store monitor state.

    This keeps the stored webhook key in sync with Bouncie, recreates missing
    webhooks, and re-enables inactive webhooks once the public endpoint is
    reachable again.
    """
    credentials = await get_bouncie_credentials()
    webhook_url = get_expected_bouncie_webhook_url(credentials)
    probe = await probe_public_webhook(webhook_url)

    if not webhook_url:
        await update_bouncie_credentials(
            _build_metadata_update(probe=probe, webhook_url=None),
        )
        return {
            "status": "skipped",
            "message": "Redirect URI is not configured; webhook URL unavailable.",
            "webhook_url": None,
            "public_probe": probe,
        }

    token = await BouncieOAuth.get_access_token(credentials=credentials)
    if not token:
        updates = _build_metadata_update(probe=probe, webhook_url=webhook_url)
        updates["webhook_last_error"] = "Unable to obtain Bouncie access token"
        await update_bouncie_credentials(updates)
        return {
            "status": "error",
            "message": "Unable to obtain Bouncie access token.",
            "webhook_url": webhook_url,
            "public_probe": probe,
        }

    action = "synced"
    try:
        webhooks = await fetch_bouncie_webhooks(token)
        webhook = _select_webhook_candidate(webhooks, webhook_url)

        stored_key = _normalize_auth_key(credentials.get("webhook_key"))
        desired_auth_key = stored_key or secrets.token_urlsafe(24)

        if webhook is None:
            if not probe.get("ok"):
                updates = _build_metadata_update(probe=probe, webhook_url=webhook_url)
                updates["webhook_last_error"] = (
                    f"Public webhook endpoint is unreachable ({probe.get('error')})"
                )
                await update_bouncie_credentials(updates)
                return {
                    "status": "error",
                    "message": (
                        "Public webhook endpoint is unreachable; refusing to create webhook."
                    ),
                    "webhook_url": webhook_url,
                    "public_probe": probe,
                }

            webhook = await create_bouncie_webhook(
                token,
                webhook_url=webhook_url,
                auth_key=desired_auth_key,
            )
            action = "created"
        else:
            portal_auth_key = _normalize_auth_key(webhook.get("authKey"))
            desired_auth_key = (
                portal_auth_key or stored_key or secrets.token_urlsafe(24)
            )
            current_url = _normalize_webhook_url(webhook.get("url"))
            events = webhook.get("events") or []
            desired_events = set(LIVE_TRIP_WEBHOOK_EVENTS)
            current_events = {str(event).strip() for event in events if str(event).strip()}
            active = bool(webhook.get("active"))
            needs_update = (
                current_url != _normalize_webhook_url(webhook_url)
                or current_events != desired_events
                or str(webhook.get("name") or "").strip() != LIVE_TRIP_WEBHOOK_NAME
                or not portal_auth_key
                or (force_reactivate and not active)
                or (probe.get("ok") and not active)
            )
            if needs_update:
                if probe.get("ok"):
                    webhook = await update_bouncie_webhook(
                        token,
                        str(webhook.get("id") or "").strip(),
                        webhook_url=webhook_url,
                        auth_key=desired_auth_key,
                        active=True,
                    )
                    action = "updated"
                else:
                    action = "pending_reactivation"

        returned_auth_key = str((webhook or {}).get("authKey") or "").strip()
        if returned_auth_key:
            desired_auth_key = returned_auth_key

        updates = _build_metadata_update(
            probe=probe,
            webhook_url=webhook_url,
            webhook=webhook,
        )
        if desired_auth_key and desired_auth_key != stored_key:
            updates["webhook_key"] = desired_auth_key
        await update_bouncie_credentials(updates)

        return {
            "status": "success" if probe.get("ok") else "warning",
            "action": action,
            "message": (
                "Webhook reconciled successfully."
                if probe.get("ok")
                else "Webhook metadata synced, but the public endpoint probe failed."
            ),
            "webhook_url": webhook_url,
            "webhook_active": webhook.get("active") if webhook else None,
            "webhook_id": webhook.get("id") if webhook else None,
            "public_probe": probe,
        }
    except Exception as exc:
        logger.exception("Failed to reconcile Bouncie webhook")
        updates = _build_metadata_update(probe=probe, webhook_url=webhook_url)
        updates["webhook_last_error"] = str(exc)
        await update_bouncie_credentials(updates)
        return {
            "status": "error",
            "message": str(exc),
            "webhook_url": webhook_url,
            "public_probe": probe,
        }


__all__ = [
    "LIVE_TRIP_WEBHOOK_EVENTS",
    "LIVE_TRIP_WEBHOOK_NAME",
    "create_bouncie_webhook",
    "ensure_bouncie_live_trip_webhook",
    "fetch_bouncie_webhooks",
    "get_expected_bouncie_webhook_url",
    "probe_public_webhook",
    "update_bouncie_webhook",
]
