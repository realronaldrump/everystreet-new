"""
Bouncie webhook handler.

Ensures fast 2xx responses to avoid webhook deactivation.

CRITICAL: This module intentionally does NOT use the @api_route decorator.
The @api_route decorator converts exceptions into non-2xx HTTPExceptions,
which would cause Bouncie to consider the webhook delivery failed and
eventually deactivate the webhook after repeated failures.  Instead, every
code path here returns a 200 OK response unconditionally, and event
processing is dispatched via asyncio.create_task() so it is fully decoupled
from the HTTP response lifecycle.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request, Response, status

from core.api import api_route
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
)
from tracking.services.tracking_service import TrackingService

logger = logging.getLogger(__name__)
router = APIRouter()

TripHandler = Callable[[dict[str, Any]], Awaitable[None]]

TRIP_EVENT_HANDLERS: dict[str, TripHandler] = {
    "tripStart": TrackingService.process_trip_start,
    "tripData": TrackingService.process_trip_data,
    "tripMetrics": TrackingService.process_trip_metrics,
    "tripEnd": TrackingService.process_trip_end,
}

# Pre-built response bytes to avoid any per-request object creation.
_OK_BODY = b'{"status":"ok"}'
_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


def _ok_response() -> Response:
    return Response(
        content=_OK_BODY,
        status_code=status.HTTP_200_OK,
        media_type="application/json",
    )


def _extract_auth_token(auth_header: str | None) -> str | None:
    """Normalize inbound Authorization header values to a token string."""
    if not isinstance(auth_header, str):
        return None

    token = auth_header.strip()
    if not token:
        return None

    if token.lower().startswith("bearer "):
        bearer_value = token[7:].strip()
        return bearer_value or None

    return token


async def _dispatch_event(payload: dict[str, Any], auth_header: str | None) -> None:
    """Process a webhook event.  Fully guarded — never raises."""
    try:
        auth_token = _extract_auth_token(auth_header)
        credentials = await get_bouncie_credentials()
        webhook_key = (credentials.get("webhook_key") or "").strip()
        if webhook_key:
            if auth_token != webhook_key:
                logger.warning(
                    "Bouncie webhook auth failed (eventType=%s)",
                    payload.get("eventType"),
                )
                return
        else:
            # No webhook key configured yet.  Only accept the incoming auth
            # header when Bouncie credentials are already fully configured
            # (client_id + authorization_code) to prevent an attacker from
            # poisoning the stored key before the real setup completes.
            client_id = (credentials.get("client_id") or "").strip()
            auth_code = (credentials.get("authorization_code") or "").strip()
            if auth_token and client_id and auth_code:
                saved = await update_bouncie_credentials(
                    {"webhook_key": auth_token},
                )
                if saved:
                    logger.info("Saved Bouncie webhook key from incoming request")
            elif not auth_token:
                logger.debug(
                    "Bouncie webhook received without auth header; "
                    "no key configured",
                )
            else:
                logger.warning(
                    "Bouncie webhook received before credentials are "
                    "configured; ignoring auth header to prevent key poisoning",
                )
                return

        event_type = payload.get("eventType")
        await TrackingService.record_webhook_event(event_type)
        handler = TRIP_EVENT_HANDLERS.get(event_type)
        if not handler:
            if event_type:
                logger.debug(
                    "Ignoring Bouncie webhook event type=%s", event_type,
                )
            else:
                logger.warning("Bouncie webhook payload missing eventType")
            return

        await handler(payload)
    except Exception:
        logger.exception(
            "Failed to handle Bouncie webhook event=%s",
            payload.get("eventType"),
        )


@router.post("/api/webhooks/bouncie")
@router.post("/api/webhooks/bouncie/")
@router.post("/webhook/bouncie")
@router.post("/webhook/bouncie/")
@router.post("/bouncie-webhook")
@router.post("/bouncie-webhook/")
async def bouncie_webhook(request: Request) -> Response:
    """
    Receive Bouncie webhook events and process them asynchronously.

    Always returns 200 OK to prevent webhook deactivation.

    NOTE: This handler deliberately avoids @api_route and response_model
    so that *nothing* can convert the response to a non-2xx status code.
    Event processing is fire-and-forget via asyncio.create_task().
    """
    try:
        auth_header = request.headers.get(
            "x-bouncie-authorization",
        ) or request.headers.get("authorization")

        raw_body = await request.body()
        if not raw_body:
            logger.warning("Bouncie webhook received empty body")
            return _ok_response()

        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError as exc:
            logger.warning("Bouncie webhook invalid JSON: %s", exc)
            return _ok_response()

        if not isinstance(payload, dict):
            logger.warning(
                "Bouncie webhook expected JSON object, got %s",
                type(payload).__name__,
            )
            return _ok_response()

        task = asyncio.create_task(_dispatch_event(payload, auth_header))
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_TASKS.discard)
        return _ok_response()
    except Exception:
        logger.exception("Unhandled error in Bouncie webhook")
        return _ok_response()


@router.get("/api/webhooks/bouncie/status", response_model=dict[str, Any])
@api_route(logger)
async def bouncie_webhook_status() -> dict[str, Any]:
    """Return the most recent webhook receipt information."""
    status_payload = await TrackingService.get_webhook_status()
    status_payload["status"] = "success"
    status_payload["server_time"] = datetime.now(UTC).isoformat()
    return status_payload
