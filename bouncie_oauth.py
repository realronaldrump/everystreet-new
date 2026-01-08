"""Centralized Bouncie OAuth service.

Handles OAuth token acquisition and caching for the Bouncie API.
All Bouncie API integrations should use this service for authentication.
"""

import logging
import time

import aiohttp

from bouncie_credentials import update_bouncie_credentials
from config import AUTH_URL, get_bouncie_config
from utils import get_session, retry_async

logger = logging.getLogger(__name__)


class BouncieOAuth:
    """Centralized OAuth handler for Bouncie API.

    Provides token caching and automatic refresh using authorization_code flow.

    Bouncie OAuth Flow (per API docs):
    - Authorization codes do NOT expire
    - To get a new access token, re-use the same authorization code
    - There are NO refresh tokens in Bouncie's API
    """

    @staticmethod
    @retry_async(max_retries=3, retry_delay=1.5)
    async def get_access_token(
        session: aiohttp.ClientSession | None = None,
        credentials: dict | None = None,
    ) -> str | None:
        """Get an access token, using cached token if still valid.

        Args:
            session: Optional aiohttp session (will create if not provided)
            credentials: Optional pre-fetched credentials (will fetch if not provided)

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

        if access_token and expires_at:
            if expires_at > time.time() + 300:  # 5 minute buffer
                logger.debug(
                    "Using cached access token (valid for %d more seconds)",
                    int(expires_at - time.time()),
                )
                return access_token
            logger.info("Access token expired or expiring soon, getting new one...")

        # Get new access token using authorization code
        client_id = credentials.get("client_id")
        client_secret = credentials.get("client_secret")
        redirect_uri = credentials.get("redirect_uri")
        auth_code = credentials.get("authorization_code")

        if not auth_code:
            logger.error(
                "No authorization code configured. Please set up Bouncie credentials "
                "via the profile page."
            )
            return None

        if not all([client_id, client_secret, redirect_uri]):
            logger.error(
                "Missing required OAuth credentials (client_id, client_secret, or redirect_uri)"
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
            async with session.post(AUTH_URL, json=payload, headers=headers) as response:
                if response.status == 401:
                    text = await response.text()
                    logger.error(
                        "Authorization failed (401). The authorization code may be invalid. "
                        "Please re-authorize via Bouncie Developer Portal. Response: %s",
                        text,
                    )
                    return None

                response.raise_for_status()
                data = await response.json()

                new_access_token = data.get("access_token")
                expires_in = data.get("expires_in", 3600)

                if not new_access_token:
                    logger.error("Access token not found in response: %s", data)
                    return None

                # Save new token to storage
                await BouncieOAuth._save_token(credentials, new_access_token, expires_in)
                logger.info(
                    "Successfully obtained new access token (expires in %d seconds)",
                    expires_in,
                )
                return new_access_token

        except aiohttp.ClientResponseError as e:
            logger.error("HTTP error retrieving access token: %s %s", e.status, e.message)
            return None
        except Exception as e:
            logger.error("Error retrieving access token: %s", e)
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
        }

        success = await update_bouncie_credentials(update_data)

        if success:
            logger.info("Saved new access token to database")
            # Update in-memory dict for current session
            current_credentials["access_token"] = access_token
            current_credentials["expires_at"] = expires_at
        else:
            logger.error("Failed to save access token to database")
