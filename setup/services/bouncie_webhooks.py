"""Simple Bouncie webhook health check.

Periodically verifies that the Bouncie webhook is active and re-enables
it if Bouncie has deactivated it (e.g. after transient deploy downtime).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from config import API_BASE_URL
from core.http.session import get_session
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
)
from setup.services.bouncie_oauth import BouncieOAuth

logger = logging.getLogger(__name__)

_WEBHOOKS_URL = f"{API_BASE_URL}/webhooks"


async def ensure_webhook_active() -> dict:
    """Check the Bouncie webhook and re-enable it if deactivated.

    Returns a summary dict suitable for task history logging.
    """
    credentials = await get_bouncie_credentials()
    webhook_id = credentials.get("webhook_id")
    webhook_url = credentials.get("webhook_url")

    if not webhook_id and not webhook_url:
        return {"skipped": True, "reason": "no webhook configured"}

    token = await BouncieOAuth.get_access_token(credentials=credentials)
    if not token:
        return {"error": "failed to obtain access token"}

    session = await get_session()
    headers = {"Authorization": token, "Content-Type": "application/json"}

    # Fetch all webhooks for this application.
    try:
        async with session.get(_WEBHOOKS_URL, headers=headers) as resp:
            if resp.status != 200:
                text = await resp.text()
                logger.warning("Bouncie GET /webhooks failed: %s %s", resp.status, text)
                return {"error": f"GET /webhooks returned {resp.status}"}
            webhooks = await resp.json()
    except Exception:
        logger.exception("Failed to fetch Bouncie webhooks")
        return {"error": "request failed"}

    if not isinstance(webhooks, list):
        return {"error": "unexpected response format"}

    # Find our webhook by ID or URL.
    target = None
    for wh in webhooks:
        if webhook_id and wh.get("id") == webhook_id:
            target = wh
            break
        if webhook_url and wh.get("url") == webhook_url:
            target = wh
            break

    if target is None:
        logger.warning("Bouncie webhook not found (id=%s url=%s)", webhook_id, webhook_url)
        return {"error": "webhook not found on Bouncie"}

    now = datetime.now(UTC)
    is_active = target.get("active", False)

    # Persist latest check metadata.
    await update_bouncie_credentials({
        "webhook_id": target.get("id"),
        "webhook_name": target.get("name"),
        "webhook_url": target.get("url"),
        "webhook_active": is_active,
        "webhook_last_checked_at": now,
        "webhook_last_error": None,
    })

    if is_active:
        logger.debug("Bouncie webhook is active")
        return {"active": True}

    # Re-enable the deactivated webhook.
    logger.info("Bouncie webhook is INACTIVE — re-enabling")
    put_url = f"{_WEBHOOKS_URL}/{target['id']}"
    put_body = {
        "name": target.get("name", "EveryStreet Live Trip Tracking"),
        "url": target.get("url", webhook_url),
        "authKey": target.get("authKey", credentials.get("webhook_key", "")),
        "events": target.get("events", [
            "tripStart", "tripData", "tripMetrics", "tripEnd",
        ]),
        "active": True,
    }

    try:
        async with session.put(put_url, json=put_body, headers=headers) as resp:
            if resp.status == 200:
                logger.info("Bouncie webhook re-enabled successfully")
                await update_bouncie_credentials({
                    "webhook_active": True,
                    "webhook_last_error": None,
                    "webhook_updated_at": now,
                })
                return {"reactivated": True}
            text = await resp.text()
            logger.error("Failed to re-enable webhook: %s %s", resp.status, text)
            await update_bouncie_credentials({
                "webhook_last_error": f"PUT returned {resp.status}: {text[:200]}",
            })
            return {"error": f"re-enable failed ({resp.status})"}
    except Exception:
        logger.exception("Failed to re-enable Bouncie webhook")
        return {"error": "re-enable request failed"}
