"""Bouncie live-tracking webhook handler."""

from __future__ import annotations

import json
import logging
import math
import secrets
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status

from core.api import api_route
from core.date_utils import parse_timestamp
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


def _payload_error(message: str) -> HTTPException:
    return _webhook_error(status.HTTP_400_BAD_REQUEST, message)


def _require_nonempty_string(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise _payload_error(f"Missing or invalid '{field}'.")
    return value.strip()


def _require_object(payload: dict[str, Any], field: str) -> dict[str, Any]:
    value = payload.get(field)
    if not isinstance(value, dict):
        raise _payload_error(f"Missing or invalid '{field}'.")
    return value


def _require_array(payload: dict[str, Any], field: str) -> list[Any]:
    value = payload.get(field)
    if not isinstance(value, list):
        raise _payload_error(f"Missing or invalid '{field}'.")
    return value


def _require_timestamp(payload: dict[str, Any], field: str) -> datetime:
    value = payload.get(field)
    parsed = parse_timestamp(value)
    if parsed is None:
        raise _payload_error(f"Missing or invalid '{field}'.")
    return parsed


def _is_json_number(value: Any) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _require_number(payload: dict[str, Any], field: str) -> float:
    value = payload.get(field)
    if not _is_json_number(value):
        raise _payload_error(f"Missing or invalid '{field}'.")
    return float(value)


def _validate_optional_number(payload: dict[str, Any], field: str) -> None:
    if field in payload and payload.get(field) is not None:
        _require_number(payload, field)


def _validate_base_trip_payload(payload: dict[str, Any]) -> str:
    event_type = payload.get("eventType")
    if event_type not in TRIP_EVENT_HANDLERS:
        raise _payload_error("Unsupported or missing 'eventType'.")

    for field in ("imei", "vin", "transactionId"):
        _require_nonempty_string(payload, field)

    return str(event_type)


def _validate_trip_start_payload(payload: dict[str, Any]) -> None:
    start = _require_object(payload, "start")
    _require_timestamp(start, "timestamp")
    _require_nonempty_string(start, "timeZone")
    _require_number(start, "odometer")


def _validate_trip_data_payload(payload: dict[str, Any]) -> None:
    data_points = _require_array(payload, "data")
    for index, point in enumerate(data_points):
        if not isinstance(point, dict):
            raise _payload_error(f"Invalid 'data[{index}]'.")
        _require_timestamp(point, "timestamp")
        gps = _require_object(point, "gps")
        for field in ("lat", "lon", "heading"):
            _require_number(gps, field)
        _validate_optional_number(point, "speed")
        _validate_optional_number(point, "fuelLevelInput")


def _validate_trip_metrics_payload(payload: dict[str, Any]) -> None:
    metrics = _require_object(payload, "metrics")
    _require_timestamp(metrics, "timestamp")
    for field in (
        "tripTime",
        "tripDistance",
        "totalIdlingTime",
        "maxSpeed",
        "averageDriveSpeed",
        "hardBrakingCounts",
        "hardAccelerationCounts",
    ):
        _require_number(metrics, field)


def _validate_trip_end_payload(payload: dict[str, Any]) -> None:
    end = _require_object(payload, "end")
    _require_timestamp(end, "timestamp")
    _require_nonempty_string(end, "timeZone")
    _require_number(end, "odometer")
    _require_number(end, "fuelConsumed")


def _validate_live_trip_payload(payload: dict[str, Any]) -> str:
    event_type = _validate_base_trip_payload(payload)
    if event_type == "tripStart":
        _validate_trip_start_payload(payload)
    elif event_type == "tripData":
        _validate_trip_data_payload(payload)
    elif event_type == "tripMetrics":
        _validate_trip_metrics_payload(payload)
    elif event_type == "tripEnd":
        _validate_trip_end_payload(payload)
    return event_type


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
    strict_schema: bool,
) -> str | None:
    """Dispatch a webhook payload to the matching trip handler."""
    if strict_schema:
        event_type = _validate_live_trip_payload(payload)
    else:
        event_type = _extract_trip_event_type(payload, source_label=source_label)
        if event_type not in TRIP_EVENT_HANDLERS:
            return event_type

    assert event_type in TRIP_EVENT_HANDLERS
    handler = TRIP_EVENT_HANDLERS[event_type]

    try:
        await handler(payload)
    except Exception as exc:
        logger.exception(
            "%s failed to process event=%s",
            source_label,
            event_type,
        )
        if strict_schema:
            raise _webhook_error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Webhook processing failed.",
            ) from exc

    return event_type


async def _handle_live_webhook_request(
    request: Request,
    *,
    require_auth: bool,
    source_label: str,
    strict_schema: bool,
) -> Response:
    payload = await _parse_request_payload(request, source_label=source_label)
    if require_auth:
        await _require_bouncie_authorization(request)
    event_type = await _process_payload(
        payload,
        source_label=source_label,
        strict_schema=strict_schema,
    )
    if require_auth:
        await TrackingService.record_webhook_event(event_type)
    return _ok_response()


@router.post(LIVE_BOUNCIE_WEBHOOK_PATH)
async def bouncie_live_webhook(request: Request) -> Response:
    """Receive authenticated Bouncie live-trip webhook events."""
    return await _handle_live_webhook_request(
        request,
        require_auth=True,
        source_label="Bouncie live webhook",
        strict_schema=False,
    )


@router.post("/api/simulator/bouncie-webhook")
async def simulator_bouncie_webhook(request: Request) -> Response:
    """
    Simulator-only ingress for synthetic webhook traffic.

    This endpoint intentionally bypasses real webhook auth validation so
    the production Bouncie webhook key is never coupled to a browser-
    side tool.
    """
    return await _handle_live_webhook_request(
        request,
        require_auth=False,
        source_label="Simulator Bouncie webhook",
        strict_schema=True,
    )


@router.get("/api/webhooks/bouncie/status", response_model=dict[str, Any])
@api_route(logger)
async def bouncie_webhook_status() -> dict[str, Any]:
    """Return the most recent webhook receipt information."""
    status_payload = await TrackingService.get_webhook_status()
    status_payload["status"] = "success"
    status_payload["server_time"] = datetime.now(UTC).isoformat()
    return status_payload
