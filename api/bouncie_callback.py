"""
Bouncie OAuth callback handler.

This module handles the OAuth authorization flow with Bouncie:
- Initiates authorization by redirecting to Bouncie's auth page
- Handles the callback with authorization code
"""

from __future__ import annotations

import logging
from typing import Annotated
from urllib.parse import quote, urlencode

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse

from bouncie_credentials import get_bouncie_credentials, update_bouncie_credentials

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bouncie", tags=["bouncie-oauth"])

BOUNCIE_AUTH_BASE = "https://auth.bouncie.com/dialog/authorize"


@router.get("/authorize")
async def initiate_bouncie_auth():
    """
    Initiate Bouncie OAuth flow.

    Redirects the user to Bouncie's authorization page where they can
    grant permission for this app to access their data.
    """
    credentials = await get_bouncie_credentials()
    client_id = credentials.get("client_id")
    redirect_uri = credentials.get("redirect_uri")

    if not client_id:
        raise HTTPException(
            status_code=400,
            detail="Bouncie client_id not configured. Please enter your credentials first.",
        )

    if not redirect_uri:
        raise HTTPException(
            status_code=400,
            detail="Bouncie redirect_uri not configured. Please enter your credentials first.",
        )

    # Build the authorization URL
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
    }

    auth_url = f"{BOUNCIE_AUTH_BASE}?{urlencode(params)}"
    logger.info("Redirecting to Bouncie authorization: %s", auth_url)

    return RedirectResponse(url=auth_url, status_code=302)


@router.get("/callback")
async def bouncie_oauth_callback(
    code: Annotated[str | None, Query()] = None,
    error: Annotated[str | None, Query()] = None,
):
    """
    Handle Bouncie OAuth callback.

    Bouncie redirects here after the user grants (or denies) permission.
    The authorization code is captured and stored for later use.
    """
    if error:
        logger.error("Bouncie OAuth error: %s", error)
        # Redirect to setup with error message (URL-encoded to prevent XSS)
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

    # Store the authorization code
    try:
        success = await update_bouncie_credentials({"authorization_code": code})
        if not success:
            logger.error("Failed to store authorization code")
            return RedirectResponse(
                url="/setup?bouncie_error=storage_failed",
                status_code=302,
            )

        logger.info("Successfully stored Bouncie authorization code")

        # Redirect back to setup with success indicator
        return RedirectResponse(
            url="/setup?bouncie_connected=true",
            status_code=302,
        )

    except Exception as e:
        logger.exception("Error storing Bouncie authorization code")
        return RedirectResponse(
            url="/setup?bouncie_error=" + quote(str(e), safe=""),
            status_code=302,
        )


@router.get("/status")
async def get_bouncie_auth_status():
    """
    Check if Bouncie OAuth is configured.

    Returns whether an authorization code is present.
    """
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
