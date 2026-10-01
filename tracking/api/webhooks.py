"""Bouncie live-tracking webhook handler."""

from __future__ import annotations

import json
import logging
import secrets
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status

from core import live_tracking
from core.api import api_route
from setup.services.bouncie_credentials import get_bouncie_credentials
from tracking.services.tracking_service import TrackingService

logger = logging.getLogger(__name__)
router = APIRouter()

TripHandler = Callable[[dict[str, Any]], Awaitable[None]]
LIVE_BOUNCIE_WEBHOOK_PATH = "/api/webhooks/bouncie/live"

TRIP_EVENT_HANDLERS: dict[str, TripHandler] = {
    "tripStart": TrackingService.process_trip_start,
    "tripData": TrackingService.process_trip_data,
    "tripMetrics": TrackingService.process_trip_metrics,
    "tripEnd": TrackingService.process_trip_end,
}

_OK_BODY = b'{"status":"ok"}'


def _ok_response() -> Response:
    return Response(
        content=_OK_BODY,
        status_code=status.HTTP_200_OK,
        media_type="application/json",
    )


def _webhook_error(
    status_code: int,
    detail: str,
) -> HTTPException:
    return HTTPException(status_code=status_code, detail=detail)


def _extract_auth_token(auth_header: str | None) -> str | None:
    """Normalize inbound Authorization header values to a token string."""
    if not auth_header:
        return None

    token = auth_header.strip()
    if not token:
        return None

    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    return token


async def _parse_request_payload(
    request: Request,
    *,
    source_label: str,
) -> dict[str, Any]:
    raw_body = await request.body()
    if not raw_body:
        logger.warning("%s received empty body", source_label)
        raise _webhook_error(
            status.HTTP_400_BAD_REQUEST,
            "Request body must be a JSON object.",
        )

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        logger.warning("%s invalid JSON: %s", source_label, exc)
        raise _webhook_error(
            status.HTTP_400_BAD_REQUEST,
            "Request body must be valid JSON.",
        ) from exc

    if not isinstance(payload, dict):
        logger.warning(
            "%s expected JSON object, got %s",
            source_label,
            type(payload).__name__,
        )
        raise _webhook_error(
            status.HTTP_400_BAD_REQUEST,
            "Request body must be a JSON object.",
        )

    return payload


async def _require_bouncie_authorization(request: Request) -> None:
    auth_header = request.headers.get(
        "x-bouncie-authorization",
    ) or request.headers.get("authorization")
    auth_token = _extract_auth_token(auth_header)
    credentials = await get_bouncie_credentials()
    webhook_key = (credentials.get("webhook_key") or "").strip()

    if not webhook_key:
        logger.error("Bouncie webhook key is not configured")
        raise _webhook_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Bouncie webhook key is not configured.",
        )

    if not auth_token or not secrets.compare_digest(auth_token, webhook_key):
        logger.warning("Bouncie webhook auth failed")
        raise _webhook_error(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid Bouncie webhook Authorization header.",
        )


def _extract_trip_event_type(
    payload: dict[str, Any],
    *,
    source_label: str,
) -> str | None:
    event_type = payload.get("eventType")
    if not isinstance(event_type, str) or not event_type.strip():
        logger.warning("%s missing eventType; acknowledging receipt", source_label)
        return None

    event_type = event_type.strip()
    if event_type not in TRIP_EVENT_HANDLERS:
        logger.warning(
            "%s unsupported eventType=%s; acknowledging receipt",
            source_label,
            event_type,
        )
        return event_type

    return event_type


async def _process_payload(
    payload: dict[str, Any],
    *,
    source_label: str,
) -> str | None:
    """Dispatch a webhook payload to the matching trip handler."""
    event_type = _extract_trip_event_type(payload, source_label=source_label)
    if event_type not in TRIP_EVENT_HANDLERS:
        return event_type

    handler = TRIP_EVENT_HANDLERS[event_type]

    try:
        await handler(payload)
    except Exception:
        logger.exception(
            "%s failed to process event=%s",
            source_label,
            event_type,
        )

    return event_type


@router.post(LIVE_BOUNCIE_WEBHOOK_PATH)
async def bouncie_live_webhook(request: Request) -> Response:
    """Receive authenticated Bouncie live-trip webhook events."""
    if not await live_tracking.is_enabled():
        # Acknowledge without parsing, dispatching, or recording a delivery.
        # Provider retries must not turn disabled tracking into background work.
        return _ok_response()
    source_label = "Bouncie live webhook"
    payload = await _parse_request_payload(request, source_label=source_label)
    await _require_bouncie_authorization(request)
    event_type = await _process_payload(payload, source_label=source_label)
    await TrackingService.record_webhook_event(event_type)
    return _ok_response()


@router.get("/api/webhooks/bouncie/status", response_model=dict[str, Any])
@api_route(logger)
async def bouncie_webhook_status() -> dict[str, Any]:
    """Return the most recent webhook receipt information."""
    status_payload = await TrackingService.get_webhook_status()
    status_payload["status"] = "success"
    status_payload["server_time"] = datetime.now(UTC).isoformat()
    return status_payload
