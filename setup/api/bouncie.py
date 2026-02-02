"""Bouncie OAuth callback handler."""

from __future__ import annotations

import logging
import secrets
import time
from typing import Annotated, Any
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Query, Request
from fastapi.responses import RedirectResponse

from core.api import api_route
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
)
from setup.services.bouncie_sync import (
    BouncieVehicleSyncError,
    sync_bouncie_vehicles,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bouncie", tags=["bouncie-oauth"])

BOUNCIE_AUTH_BASE = "https://auth.bouncie.com/dialog/authorize"
OAUTH_STATE_TTL_SECONDS = 10 * 60
SETUP_WIZARD_PATH = "/setup-wizard"


def _generate_oauth_state() -> str:
    return secrets.token_urlsafe(32)


def _state_expired(expires_at: float | None) -> bool:
    return bool(expires_at and expires_at < time.time())


def _first_forwarded_value(value: str | None) -> str | None:
    if not value:
        return None
    first = value.split(",")[0].strip()
    return first or None


def _build_redirect_uri(request: Request) -> str:
    """Build the expected redirect URI from the current request."""
    # Use X-Forwarded headers if behind a proxy (take first if multiple values).
    scheme = _first_forwarded_value(request.headers.get("x-forwarded-proto"))
    host = _first_forwarded_value(request.headers.get("x-forwarded-host"))
    port = _first_forwarded_value(request.headers.get("x-forwarded-port"))

    scheme = scheme or request.url.scheme
    host = host or request.url.netloc
    if port and host and ":" not in host:
        host = f"{host}:{port}"

    return f"{scheme}://{host}/api/bouncie/callback"


@router.get("/authorize", response_model=None)
@api_route(logger)
async def initiate_bouncie_auth(request: Request) -> RedirectResponse:
    """
    Initiate Bouncie OAuth flow.

    Redirects the user to Bouncie's authorization page where they can
    grant permission for this app to access their data.
    """
    credentials = await get_bouncie_credentials()
    client_id = credentials.get("client_id")
    client_secret = credentials.get("client_secret")
    redirect_uri = (credentials.get("redirect_uri") or "").strip()
    expected_redirect = _build_redirect_uri(request)

    if not client_id:
        return RedirectResponse(
            url=f"{SETUP_WIZARD_PATH}?bouncie_error="
            + quote("Please save your Client ID before connecting.", safe=""),
            status_code=302,
        )

    if not client_secret:
        return RedirectResponse(
            url=f"{SETUP_WIZARD_PATH}?bouncie_error="
            + quote("Please save your Client Secret before connecting.", safe=""),
            status_code=302,
        )

    if not redirect_uri:
        return RedirectResponse(
            url=f"{SETUP_WIZARD_PATH}?bouncie_error="
            + quote("Please save your Redirect URI before connecting.", safe=""),
            status_code=302,
        )

    if redirect_uri != expected_redirect:
        logger.info(
            "Stored redirect URI differs from request-derived callback; using stored value. stored=%s expected=%s",
            redirect_uri,
            expected_redirect,
        )

    # Idempotent: if already authorized, skip new auth flow and sync vehicles if needed
    if credentials.get("authorization_code"):
        from core.http.session import get_session
        from setup.services.bouncie_oauth import BouncieOAuth

        session = await get_session()
        token = await BouncieOAuth.get_access_token(
            session=session,
            credentials=credentials,
        )
        if token:
            try:
                vehicle_count = 0
                if not credentials.get("authorized_devices"):
                    vehicle_count = await _sync_vehicles_after_auth(
                        session,
                        token,
                        credentials=credentials,
                    )
                logger.info(
                    "Bouncie already authorized; skipping OAuth flow (vehicles_synced=%d).",
                    vehicle_count,
                )
                return RedirectResponse(
                    url=(
                        f"{SETUP_WIZARD_PATH}"
                        f"?bouncie_connected=true&vehicles_synced={vehicle_count}"
                    ),
                    status_code=302,
                )
            except BouncieVehicleSyncError:
                return RedirectResponse(
                    url=f"{SETUP_WIZARD_PATH}?bouncie_error=vehicle_sync_failed",
                    status_code=302,
                )

        logger.warning(
            "Existing Bouncie authorization code did not produce a token; starting new OAuth flow.",
        )

    state = _generate_oauth_state()
    state_expires_at = time.time() + OAUTH_STATE_TTL_SECONDS
    saved = await update_bouncie_credentials(
        {"oauth_state": state, "oauth_state_expires_at": state_expires_at},
    )
    if not saved:
        return RedirectResponse(
            url=f"{SETUP_WIZARD_PATH}?bouncie_error="
            + quote("Failed to save OAuth state. Please try again.", safe=""),
            status_code=302,
        )

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "state": state,
    }

    auth_url = f"{BOUNCIE_AUTH_BASE}?{urlencode(params)}"
    logger.info("Redirecting to Bouncie authorization (redirect_uri=%s)", redirect_uri)

    return RedirectResponse(url=auth_url, status_code=302)


@router.get("/callback", response_model=None)
@api_route(logger)
async def bouncie_oauth_callback(
    code: Annotated[str | None, Query()] = None,
    error: Annotated[str | None, Query()] = None,
    state: Annotated[str | None, Query()] = None,
) -> RedirectResponse:
    """
    Handle Bouncie OAuth callback.

    This endpoint:
    1. Stores the authorization code
    2. Immediately exchanges it for an access token (to fail fast if invalid)
    3. Automatically fetches and syncs vehicles (hands-off setup)
    """
    credentials = await get_bouncie_credentials()
    stored_state = credentials.get("oauth_state")
    stored_state_expires_at = credentials.get("oauth_state_expires_at")

    if error:
        logger.error("Bouncie OAuth error: %s", error)
        await update_bouncie_credentials(
            {"oauth_state": None, "oauth_state_expires_at": None},
        )
        return RedirectResponse(
            url=f"{SETUP_WIZARD_PATH}?bouncie_error=" + quote(error, safe=""),
            status_code=302,
        )

    if stored_state:
        if not state:
            logger.error("Bouncie OAuth callback missing state parameter")
            await update_bouncie_credentials(
                {"oauth_state": None, "oauth_state_expires_at": None},
            )
            return RedirectResponse(
                url=f"{SETUP_WIZARD_PATH}?bouncie_error=missing_state",
                status_code=302,
            )
        if state != stored_state:
            logger.error("Bouncie OAuth state mismatch")
            await update_bouncie_credentials(
                {"oauth_state": None, "oauth_state_expires_at": None},
            )
            return RedirectResponse(
                url=f"{SETUP_WIZARD_PATH}?bouncie_error=state_mismatch",
                status_code=302,
            )
        if _state_expired(stored_state_expires_at):
            logger.error("Bouncie OAuth state expired")
            await update_bouncie_credentials(
                {"oauth_state": None, "oauth_state_expires_at": None},
            )
            return RedirectResponse(
                url=f"{SETUP_WIZARD_PATH}?bouncie_error=state_expired",
                status_code=302,
            )
    elif state:
        logger.warning("Bouncie OAuth callback received unexpected state")
    else:
        logger.warning(
            "Bouncie OAuth callback missing state; no stored state found",
        )

    if not code:
        logger.error("Bouncie OAuth callback missing code parameter")
        await update_bouncie_credentials(
            {"oauth_state": None, "oauth_state_expires_at": None},
        )
        return RedirectResponse(
            url=f"{SETUP_WIZARD_PATH}?bouncie_error=missing_code",
            status_code=302,
        )

    try:
        # 1. Store the authorization code
        success = await update_bouncie_credentials(
            {
                "authorization_code": code,
                "oauth_state": None,
                "oauth_state_expires_at": None,
                "last_auth_error": None,
                "last_auth_error_detail": None,
                "last_auth_error_at": None,
            },
        )
        if not success:
            logger.error("Failed to store authorization code")
            return RedirectResponse(
                url=f"{SETUP_WIZARD_PATH}?bouncie_error=storage_failed",
                status_code=302,
            )

        logger.info(
            "Successfully stored Bouncie authorization code (length=%d)",
            len(code),
        )

        # 2. Immediately exchange for access token to verify it's valid
        from core.http.session import get_session
        from setup.services.bouncie_oauth import BouncieOAuth

        credentials = await get_bouncie_credentials()
        session = await get_session()

        token = await BouncieOAuth.get_access_token(
            session=session,
            credentials=credentials,
            force_refresh=True,
        )

        if not token:
            logger.error("Failed to exchange authorization code for access token")
            return RedirectResponse(
                url=f"{SETUP_WIZARD_PATH}?bouncie_error=token_exchange_failed",
                status_code=302,
            )

        logger.info("Successfully obtained access token from authorization code")

        # 3. Automatically fetch and sync vehicles (hands-off setup)
        try:
            vehicle_count = await _sync_vehicles_after_auth(
                session,
                token,
                credentials=credentials,
            )
        except BouncieVehicleSyncError:
            return RedirectResponse(
                url=f"{SETUP_WIZARD_PATH}?bouncie_error=vehicle_sync_failed",
                status_code=302,
            )

        logger.info(
            "OAuth flow complete. Synced %d vehicles automatically.",
            vehicle_count,
        )

        return RedirectResponse(
            url=(
                f"{SETUP_WIZARD_PATH}"
                f"?bouncie_connected=true&vehicles_synced={vehicle_count}"
            ),
            status_code=302,
        )

    except Exception as exc:
        logger.exception("Error in Bouncie OAuth callback")
        return RedirectResponse(
            url=f"{SETUP_WIZARD_PATH}?bouncie_error=" + quote(str(exc), safe=""),
            status_code=302,
        )


async def _sync_vehicles_after_auth(
    session,
    token: str,
    *,
    credentials: dict[str, Any] | None = None,
) -> int:
    """
    Automatically sync vehicles after successful OAuth.

    Returns the number of vehicles synced.
    """
    try:
        result = await sync_bouncie_vehicles(
            session,
            token,
            credentials=credentials,
            merge_authorized_devices=False,
            update_authorized_devices=True,
        )
        if not result.get("imeis"):
            logger.info("No vehicles found in Bouncie account")
        return len(result.get("imeis", []))

    except BouncieVehicleSyncError:
        raise
    except Exception:
        logger.exception("Error during automatic vehicle sync")
        msg = "unexpected_error"
        raise BouncieVehicleSyncError(msg)


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
        "connected": has_auth_code
        and has_client_id
        and has_client_secret
        and has_redirect_uri,
        "has_token": has_access_token,
        "has_devices": has_devices,
        "device_count": len(credentials.get("authorized_devices", [])),
    }


@router.get("/redirect-uri", response_model=dict[str, str])
@api_route(logger)
async def get_expected_redirect_uri(request: Request) -> dict[str, str]:
    """
    Return the expected redirect URI for this installation.

    Users should copy this value to their Bouncie Developer Portal when
    setting up the application redirect URIs.
    """
    redirect_uri = _build_redirect_uri(request)
    return {
        "redirect_uri": redirect_uri,
        "instructions": (
            "Copy this URL to your Bouncie Developer Portal under "
            "'Redirect URIs' for your application."
        ),
    }
