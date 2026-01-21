"""Bouncie OAuth callback handler."""

from __future__ import annotations

import logging
from typing import Annotated, Any
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Query, Request
from fastapi.responses import RedirectResponse

from core.api import api_route
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bouncie", tags=["bouncie-oauth"])

BOUNCIE_AUTH_BASE = "https://auth.bouncie.com/dialog/authorize"


def _build_redirect_uri(request: Request) -> str:
    """Build the expected redirect URI from the current request."""
    # Use X-Forwarded headers if behind a proxy
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.url.netloc)
    return f"{scheme}://{host}/api/bouncie/callback"


@router.get("/authorize", response_model=None)
@api_route(logger)
async def initiate_bouncie_auth() -> RedirectResponse:
    """
    Initiate Bouncie OAuth flow.

    Redirects the user to Bouncie's authorization page where they can
    grant permission for this app to access their data.
    """
    credentials = await get_bouncie_credentials()
    client_id = credentials.get("client_id")
    redirect_uri = credentials.get("redirect_uri")

    if not client_id:
        return RedirectResponse(
            url="/setup?bouncie_error="
            + quote("Please save your Client ID before connecting.", safe=""),
            status_code=302,
        )

    if not redirect_uri:
        return RedirectResponse(
            url="/setup?bouncie_error="
            + quote("Please save your Redirect URI before connecting.", safe=""),
            status_code=302,
        )

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
    }

    auth_url = f"{BOUNCIE_AUTH_BASE}?{urlencode(params)}"
    logger.info("Redirecting to Bouncie authorization: %s", auth_url)

    return RedirectResponse(url=auth_url, status_code=302)


@router.get("/callback", response_model=None)
@api_route(logger)
async def bouncie_oauth_callback(
    code: Annotated[str | None, Query()] = None,
    error: Annotated[str | None, Query()] = None,
) -> RedirectResponse:
    """
    Handle Bouncie OAuth callback.

    This endpoint:
    1. Stores the authorization code
    2. Immediately exchanges it for an access token (to fail fast if invalid)
    3. Automatically fetches and syncs vehicles (hands-off setup)
    """
    if error:
        logger.error("Bouncie OAuth error: %s", error)
        return RedirectResponse(
            url="/setup?bouncie_error=" + quote(error, safe=""),
            status_code=302,
        )

    if not code:
        logger.error("Bouncie OAuth callback missing code parameter")
        return RedirectResponse(
            url="/setup?bouncie_error=missing_code",
            status_code=302,
        )

    try:
        # 1. Store the authorization code
        success = await update_bouncie_credentials({"authorization_code": code})
        if not success:
            logger.error("Failed to store authorization code")
            return RedirectResponse(
                url="/setup?bouncie_error=storage_failed",
                status_code=302,
            )

        logger.info("Successfully stored Bouncie authorization code")

        # 2. Immediately exchange for access token to verify it's valid
        from core.http.session import get_session
        from setup.services.bouncie_oauth import BouncieOAuth

        credentials = await get_bouncie_credentials()
        session = await get_session()

        token = await BouncieOAuth.get_access_token(
            session=session,
            credentials=credentials,
        )

        if not token:
            logger.error("Failed to exchange authorization code for access token")
            return RedirectResponse(
                url="/setup?bouncie_error="
                + quote("Failed to get access token. Please verify your credentials.", safe=""),
                status_code=302,
            )

        logger.info("Successfully obtained access token from authorization code")

        # 3. Automatically fetch and sync vehicles (hands-off setup)
        vehicle_count = await _sync_vehicles_after_auth(session, token)

        logger.info(
            "OAuth flow complete. Synced %d vehicles automatically.",
            vehicle_count,
        )

        return RedirectResponse(
            url=f"/setup?bouncie_connected=true&vehicles_synced={vehicle_count}",
            status_code=302,
        )

    except Exception as exc:
        logger.exception("Error in Bouncie OAuth callback")
        return RedirectResponse(
            url="/setup?bouncie_error=" + quote(str(exc), safe=""),
            status_code=302,
        )


async def _sync_vehicles_after_auth(session, token: str) -> int:
    """
    Automatically sync vehicles after successful OAuth.

    Returns the number of vehicles synced.
    """
    from datetime import UTC, datetime

    from config import API_BASE_URL
    from db.models import Vehicle

    try:
        headers = {
            "Authorization": token,
            "Content-Type": "application/json",
        }

        async with session.get(f"{API_BASE_URL}/vehicles", headers=headers) as resp:
            if resp.status != 200:
                error_text = await resp.text()
                logger.warning(
                    "Auto-sync vehicles failed: %s - %s",
                    resp.status,
                    error_text,
                )
                return 0

            vehicles_data = await resp.json()

        if not vehicles_data:
            logger.info("No vehicles found in Bouncie account")
            return 0

        found_imeis = []

        for v in vehicles_data:
            imei = v.get("imei")
            if not imei:
                continue

            found_imeis.append(imei)

            model_data = v.get("model")
            if isinstance(model_data, dict):
                model_name = model_data.get("name")
                make = v.get("make") or model_data.get("make")
                year = v.get("year") or model_data.get("year")
            else:
                model_name = model_data
                make = v.get("make")
                year = v.get("year")

            custom_name = v.get("nickName") or f"{year or ''} {make or ''} {model_name or ''}".strip() or f"Vehicle {imei}"

            existing_vehicle = await Vehicle.find_one({"imei": imei})
            if existing_vehicle:
                existing_vehicle.vin = v.get("vin")
                existing_vehicle.make = make
                existing_vehicle.model = model_name
                existing_vehicle.year = year
                existing_vehicle.nickName = v.get("nickName")
                existing_vehicle.custom_name = custom_name
                existing_vehicle.is_active = True
                existing_vehicle.updated_at = datetime.now(UTC)
                existing_vehicle.last_synced_at = datetime.now(UTC)
                existing_vehicle.bouncie_data = v
                await existing_vehicle.save()
            else:
                new_vehicle = Vehicle(
                    imei=imei,
                    vin=v.get("vin"),
                    make=make,
                    model=model_name,
                    year=year,
                    custom_name=custom_name,
                    is_active=True,
                    updated_at=datetime.now(UTC),
                )
                await new_vehicle.insert()

        # Update authorized_devices in credentials
        if found_imeis:
            await update_bouncie_credentials({"authorized_devices": found_imeis})
            logger.info("Updated authorized_devices with %d IMEIs", len(found_imeis))

        return len(found_imeis)

    except Exception:
        logger.exception("Error during automatic vehicle sync")
        return 0


@router.get("/status", response_model=dict[str, Any])
@api_route(logger)
async def get_bouncie_auth_status() -> dict[str, Any]:
    """Return whether Bouncie OAuth is configured."""
    credentials = await get_bouncie_credentials()

    has_client_id = bool(credentials.get("client_id"))
    has_client_secret = bool(credentials.get("client_secret"))
    has_redirect_uri = bool(credentials.get("redirect_uri"))
    has_auth_code = bool(credentials.get("authorization_code"))
    has_access_token = bool(credentials.get("access_token"))
    has_devices = bool(credentials.get("authorized_devices"))

    return {
        "configured": has_client_id and has_client_secret and has_redirect_uri,
        "connected": has_auth_code and has_access_token,
        "has_token": has_access_token,
        "has_devices": has_devices,
        "device_count": len(credentials.get("authorized_devices", [])),
    }


@router.get("/redirect-uri", response_model=dict[str, str])
@api_route(logger)
async def get_expected_redirect_uri(request: Request) -> dict[str, str]:
    """
    Return the expected redirect URI for this installation.

    Users should copy this value to their Bouncie Developer Portal
    when setting up the application redirect URIs.
    """
    redirect_uri = _build_redirect_uri(request)
    return {
        "redirect_uri": redirect_uri,
        "instructions": (
            "Copy this URL to your Bouncie Developer Portal under "
            "'Redirect URIs' for your application."
        ),
    }
