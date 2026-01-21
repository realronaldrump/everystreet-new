"""
Bouncie webhook handler.

Ensures fast 2xx responses to avoid webhook deactivation.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Request, Response, status
from fastapi.responses import JSONResponse

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


def _ok_response() -> Response:
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={"status": "ok"},
    )


async def _dispatch_event(payload: dict[str, Any], auth_header: str | None) -> None:
    credentials = await get_bouncie_credentials()
    webhook_key = (credentials.get("webhook_key") or "").strip()
    if webhook_key:
        if auth_header != webhook_key:
            logger.warning(
                "Bouncie webhook auth failed (eventType=%s)",
                payload.get("eventType"),
            )
            return
    elif auth_header:
        saved = await update_bouncie_credentials({"webhook_key": auth_header})
        if saved:
            logger.info("Saved Bouncie webhook key from incoming request")
    else:
        logger.debug(
            "Bouncie webhook received without auth header; no key configured",
        )

    event_type = payload.get("eventType")
    await TrackingService.record_webhook_event(event_type)
    handler = TRIP_EVENT_HANDLERS.get(event_type)
    if not handler:
        if event_type:
            logger.debug("Ignoring Bouncie webhook event type=%s", event_type)
        else:
            logger.warning("Bouncie webhook payload missing eventType")
        return

    try:
        await handler(payload)
    except Exception:
        logger.exception(
            "Failed to handle Bouncie webhook event=%s",
            event_type,
        )


@router.post("/api/webhooks/bouncie", response_model=dict[str, str])
@router.post("/api/webhooks/bouncie/", response_model=dict[str, str])
@router.post("/webhook/bouncie", response_model=dict[str, str])
@router.post("/webhook/bouncie/", response_model=dict[str, str])
@router.post("/bouncie-webhook", response_model=dict[str, str])
@router.post("/bouncie-webhook/", response_model=dict[str, str])
@api_route(logger)
async def bouncie_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
) -> Response:
    """
    Receive Bouncie webhook events and process them asynchronously.

    Always returns 2xx to prevent webhook deactivation.
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

        background_tasks.add_task(_dispatch_event, payload, auth_header)
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
