"""Bouncie OAuth callback handler."""

from __future__ import annotations

import logging
from typing import Annotated, Any
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse

from core.api import api_route
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bouncie", tags=["bouncie-oauth"])

BOUNCIE_AUTH_BASE = "https://auth.bouncie.com/dialog/authorize"


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
    """Handle Bouncie OAuth callback and store authorization code."""
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
        success = await update_bouncie_credentials({"authorization_code": code})
        if not success:
            logger.error("Failed to store authorization code")
            return RedirectResponse(
                url="/setup?bouncie_error=storage_failed",
                status_code=302,
            )

        logger.info("Successfully stored Bouncie authorization code")

        return RedirectResponse(
            url="/setup?bouncie_connected=true",
            status_code=302,
        )

    except Exception as exc:
        logger.exception("Error storing Bouncie authorization code")
        return RedirectResponse(
            url="/setup?bouncie_error=" + quote(str(exc), safe=""),
            status_code=302,
        )


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

    return {
        "configured": has_client_id and has_client_secret and has_redirect_uri,
        "connected": has_auth_code,
        "has_token": has_access_token,
    }
