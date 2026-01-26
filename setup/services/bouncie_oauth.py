"""
Centralized Bouncie OAuth service.

Handles OAuth token acquisition and caching for the Bouncie API. All
Bouncie API integrations should use this service for authentication.
"""

import json
import logging
import time

import aiohttp

from config import AUTH_URL, get_bouncie_config
from core.http.retry import retry_async
from core.http.session import get_session
from setup.services.bouncie_credentials import update_bouncie_credentials

logger = logging.getLogger(__name__)


def _mask_value(value: str | None, keep: int = 4) -> str:
    if not value:
        return "<empty>"
    if len(value) <= keep:
        return "*" * len(value)
    return f"{value[:keep]}...{value[-keep:]}"


class BouncieOAuth:
    """
    Centralized OAuth handler for Bouncie API.

    Provides token caching and automatic refresh using authorization_code flow.

    Bouncie OAuth Flow (per API docs):
    - Authorization codes can be invalidated if a new code is issued
    - To get a new access token, re-use the same authorization code
    - There are NO refresh tokens in Bouncie's API
    """

    @staticmethod
    async def _set_auth_error(
        current_credentials: dict,
        *,
        code: str,
        detail: str | None = None,
    ) -> None:
        update_data = {
            "last_auth_error": code,
            "last_auth_error_detail": detail,
            "last_auth_error_at": time.time(),
        }
        success = await update_bouncie_credentials(update_data)
        if success:
            current_credentials["last_auth_error"] = code
            current_credentials["last_auth_error_detail"] = detail
            current_credentials["last_auth_error_at"] = update_data["last_auth_error_at"]

    @staticmethod
    @retry_async(max_retries=3, retry_delay=1.5)
    async def get_access_token(
        session: aiohttp.ClientSession | None = None,
        credentials: dict | None = None,
        *,
        force_refresh: bool = False,
    ) -> str | None:
        """
        Get an access token, using cached token if still valid.

        Args:
            session: Optional aiohttp session (will create if not provided)
            credentials: Optional pre-fetched credentials (will fetch if not provided)
            force_refresh: If True, bypass cached token and request a new one

        Returns:
            Access token string or None if authentication fails
        """
        # Get credentials if not provided
        if credentials is None:
            credentials = await get_bouncie_config()

        # Get session if not provided
        if session is None:
            session = await get_session()

        # Check if we have a valid cached token (with 5 minute buffer)
        access_token = credentials.get("access_token")
        expires_at = credentials.get("expires_at")

        if not force_refresh and access_token and expires_at:
            if expires_at > time.time() + 300:  # 5 minute buffer
                logger.debug(
                    "Using cached access token (valid for %d more seconds)",
                    int(expires_at - time.time()),
                )
                return access_token
            logger.info("Access token expired or expiring soon, getting new one...")
        elif force_refresh:
            logger.info("Forcing refresh of Bouncie access token")

        # Get new access token using authorization code
        client_id = credentials.get("client_id")
        client_secret = credentials.get("client_secret")
        redirect_uri = credentials.get("redirect_uri")
        auth_code = credentials.get("authorization_code")

        if not auth_code:
            logger.error(
                "No authorization code configured. Please set up Bouncie credentials "
                "via Settings > Credentials.",
            )
            await BouncieOAuth._set_auth_error(
                credentials,
                code="auth_required",
                detail="Missing authorization code",
            )
            return None

        if not all([client_id, client_secret, redirect_uri]):
            logger.error(
                "Missing required OAuth credentials (client_id, client_secret, or redirect_uri)",
            )
            await BouncieOAuth._set_auth_error(
                credentials,
                code="credentials_missing",
                detail="Missing client_id, client_secret, or redirect_uri",
            )
            return None

        headers = {"Content-Type": "application/json"}
        payload = {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "authorization_code",
            "code": auth_code,
            "redirect_uri": redirect_uri,
        }

        try:
            logger.debug(
                "Requesting Bouncie access token: client_id=%s redirect_uri=%s auth_code_len=%d",
                _mask_value(client_id),
                redirect_uri,
                len(str(auth_code)),
            )
            async with session.post(
                AUTH_URL,
                json=payload,
                headers=headers,
            ) as response:
                if response.status >= 400:
                    text = await response.text()
                    error_code = None
                    error_description = None
                    try:
                        payload = json.loads(text)
                    except json.JSONDecodeError:
                        payload = None
                    if isinstance(payload, dict):
                        error_code = payload.get("error")
                        error_description = payload.get("error_description")
                    if error_code == "invalid_grant":
                        await BouncieOAuth._clear_invalid_authorization(
                            credentials,
                            reason=error_description,
                        )
                    else:
                        await BouncieOAuth._set_auth_error(
                            credentials,
                            code="token_exchange_failed",
                            detail=error_description or text,
                        )
                    logger.error(
                        "Access token exchange failed: status=%s client_id=%s redirect_uri=%s response=%s",
                        response.status,
                        _mask_value(client_id),
                        redirect_uri,
                        text,
                    )
                    return None

                data = await response.json()

                new_access_token = data.get("access_token")
                expires_in = data.get("expires_in", 3600)

                if not new_access_token:
                    logger.error(
                        "Access token not found in response for client_id=%s redirect_uri=%s",
                        _mask_value(client_id),
                        redirect_uri,
                    )
                    return None

                # Save new token to storage
                await BouncieOAuth._save_token(
                    credentials,
                    new_access_token,
                    int(expires_in) if expires_in is not None else 3600,
                )
                logger.info(
                    "Successfully obtained new access token (expires in %d seconds)",
                    int(expires_in) if expires_in is not None else 3600,
                )
                return new_access_token

        except aiohttp.ClientResponseError as e:
            logger.exception(
                "HTTP error retrieving access token: %s %s",
                e.status,
                e.message,
            )
            return None
        except Exception:
            logger.exception("Error retrieving access token")
            return None

    @staticmethod
    async def _save_token(
        current_credentials: dict,
        access_token: str,
        expires_in: int,
    ) -> None:
        """Save token to database and update in-memory credentials."""
        expires_at = time.time() + int(expires_in)

        update_data = {
            "access_token": access_token,
            "expires_at": expires_at,
            "last_auth_error": None,
            "last_auth_error_detail": None,
            "last_auth_error_at": None,
        }

        success = await update_bouncie_credentials(update_data)

        if success:
            logger.info("Saved new access token to database")
            # Update in-memory dict for current session
            current_credentials["access_token"] = access_token
            current_credentials["expires_at"] = expires_at
            current_credentials["last_auth_error"] = None
            current_credentials["last_auth_error_detail"] = None
            current_credentials["last_auth_error_at"] = None
        else:
            logger.error("Failed to save access token to database")

    @staticmethod
    async def _clear_invalid_authorization(
        current_credentials: dict,
        *,
        reason: str | None = None,
    ) -> None:
        """Clear stored auth code and token after invalid_grant responses."""
        update_data = {
            "authorization_code": None,
            "access_token": None,
            "expires_at": None,
            "last_auth_error": "auth_invalid",
            "last_auth_error_detail": reason,
            "last_auth_error_at": time.time(),
        }
        success = await update_bouncie_credentials(update_data)
        if success:
            current_credentials["authorization_code"] = ""
            current_credentials["access_token"] = None
            current_credentials["expires_at"] = None
            current_credentials["last_auth_error"] = "auth_invalid"
            current_credentials["last_auth_error_detail"] = reason
            current_credentials["last_auth_error_at"] = update_data["last_auth_error_at"]
        message = "Cleared stored authorization code after invalid_grant"
        if reason:
            message = f"{message}: {reason}"
        logger.error(message)
