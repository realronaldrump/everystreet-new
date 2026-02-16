"""OAuth helpers for Google Photos integration."""

from __future__ import annotations

import logging
import secrets
import time
from collections.abc import Iterable
from urllib.parse import urlencode

import aiohttp

from core.http.session import get_session
from google_photos.services.credentials import (
    get_google_photos_credentials,
    update_google_photos_credentials,
)

logger = logging.getLogger(__name__)

GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

GOOGLE_PHOTOS_SCOPE_PICKER_READONLY = (
    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"
)
GOOGLE_PHOTOS_SCOPE_APPENDONLY = (
    "https://www.googleapis.com/auth/photoslibrary.appendonly"
)
GOOGLE_PHOTOS_SCOPE_EDIT_APPCREATED = (
    "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata"
)

OAUTH_STATE_TTL_SECONDS = 10 * 60


def _normalize_scopes(scopes: Iterable[str] | None) -> list[str]:
    if scopes is None:
        return []
    normalized: list[str] = []
    for raw in scopes:
        value = str(raw).strip()
        if value and value not in normalized:
            normalized.append(value)
    return normalized


def _scopes_cover(granted_scopes: Iterable[str], required_scopes: Iterable[str]) -> bool:
    granted = set(_normalize_scopes(granted_scopes))
    required = set(_normalize_scopes(required_scopes))
    return required.issubset(granted)


def _mask_value(value: str | None, keep: int = 4) -> str:
    if not value:
        return "<empty>"
    if len(value) <= keep:
        return "*" * len(value)
    return f"{value[:keep]}...{value[-keep:]}"


class GooglePhotosOAuth:
    """Centralized Google Photos OAuth handler."""

    @staticmethod
    def generate_state() -> str:
        return secrets.token_urlsafe(32)

    @staticmethod
    def state_expired(expires_at: float | None) -> bool:
        return bool(expires_at and expires_at < time.time())

    @staticmethod
    async def set_auth_error(
        credentials: dict,
        *,
        code: str,
        detail: str | None = None,
    ) -> None:
        update_data = {
            "last_auth_error": code,
            "last_auth_error_detail": detail,
            "last_auth_error_at": time.time(),
        }
        success = await update_google_photos_credentials(update_data)
        if success:
            credentials.update(update_data)

    @staticmethod
    async def clear_auth_error(credentials: dict) -> None:
        update_data = {
            "last_auth_error": None,
            "last_auth_error_detail": None,
            "last_auth_error_at": None,
        }
        success = await update_google_photos_credentials(update_data)
        if success:
            credentials.update(update_data)

    @staticmethod
    def build_authorize_url(
        *,
        client_id: str,
        redirect_uri: str,
        state: str,
        request_postcard_scopes: bool = False,
    ) -> str:
        scopes = [GOOGLE_PHOTOS_SCOPE_PICKER_READONLY]
        if request_postcard_scopes:
            scopes.extend(
                [
                    GOOGLE_PHOTOS_SCOPE_APPENDONLY,
                    GOOGLE_PHOTOS_SCOPE_EDIT_APPCREATED,
                ],
            )

        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(scopes),
            "access_type": "offline",
            "include_granted_scopes": "true",
            "prompt": "consent",
            "state": state,
        }
        return f"{GOOGLE_OAUTH_AUTHORIZE_URL}?{urlencode(params)}"

    @staticmethod
    async def exchange_authorization_code(
        *,
        code: str,
        credentials: dict,
        session: aiohttp.ClientSession | None = None,
    ) -> bool:
        if session is None:
            session = await get_session()

        client_id = (credentials.get("client_id") or "").strip()
        client_secret = (credentials.get("client_secret") or "").strip()
        redirect_uri = (credentials.get("redirect_uri") or "").strip()

        if not client_id or not client_secret or not redirect_uri:
            await GooglePhotosOAuth.set_auth_error(
                credentials,
                code="credentials_missing",
                detail="Missing client_id, client_secret, or redirect_uri",
            )
            return False

        payload = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
        }

        try:
            async with session.post(GOOGLE_OAUTH_TOKEN_URL, data=payload) as response:
                if response.status >= 400:
                    detail = await response.text()
                    await GooglePhotosOAuth.set_auth_error(
                        credentials,
                        code="token_exchange_failed",
                        detail=detail,
                    )
                    logger.error(
                        "Google Photos token exchange failed: status=%s client_id=%s detail=%s",
                        response.status,
                        _mask_value(client_id),
                        detail,
                    )
                    return False
                data = await response.json()
        except Exception:
            logger.exception("Failed to exchange Google Photos authorization code")
            await GooglePhotosOAuth.set_auth_error(
                credentials,
                code="token_exchange_failed",
                detail="Token exchange request failed",
            )
            return False

        expires_in = int(data.get("expires_in") or 3600)
        refresh_token = data.get("refresh_token") or credentials.get("refresh_token")
        granted = data.get("scope", "")
        granted_scopes = _normalize_scopes(granted.split(" "))
        update_data = {
            "access_token": data.get("access_token"),
            "refresh_token": refresh_token,
            "expires_at": time.time() + expires_in,
            "granted_scopes": granted_scopes,
            "oauth_state": None,
            "oauth_state_expires_at": None,
            "last_auth_error": None,
            "last_auth_error_detail": None,
            "last_auth_error_at": None,
        }
        if not update_data["access_token"]:
            await GooglePhotosOAuth.set_auth_error(
                credentials,
                code="token_missing",
                detail="Token response did not include access_token",
            )
            return False

        success = await update_google_photos_credentials(update_data)
        if success:
            credentials.update(update_data)
        return success

    @staticmethod
    async def refresh_access_token(
        *,
        credentials: dict,
        session: aiohttp.ClientSession | None = None,
    ) -> str | None:
        if session is None:
            session = await get_session()

        client_id = (credentials.get("client_id") or "").strip()
        client_secret = (credentials.get("client_secret") or "").strip()
        refresh_token = (credentials.get("refresh_token") or "").strip()
        if not client_id or not client_secret or not refresh_token:
            await GooglePhotosOAuth.set_auth_error(
                credentials,
                code="refresh_missing",
                detail="Missing client credentials or refresh token",
            )
            return None

        payload = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        }

        try:
            async with session.post(GOOGLE_OAUTH_TOKEN_URL, data=payload) as response:
                if response.status >= 400:
                    detail = await response.text()
                    await GooglePhotosOAuth.set_auth_error(
                        credentials,
                        code="refresh_failed",
                        detail=detail,
                    )
                    logger.error(
                        "Google Photos token refresh failed: status=%s client_id=%s detail=%s",
                        response.status,
                        _mask_value(client_id),
                        detail,
                    )
                    return None
                data = await response.json()
        except Exception:
            logger.exception("Failed to refresh Google Photos access token")
            await GooglePhotosOAuth.set_auth_error(
                credentials,
                code="refresh_failed",
                detail="Token refresh request failed",
            )
            return None

        access_token = data.get("access_token")
        expires_in = int(data.get("expires_in") or 3600)
        granted = data.get("scope")
        scopes = (
            _normalize_scopes(granted.split(" "))
            if isinstance(granted, str)
            else _normalize_scopes(credentials.get("granted_scopes"))
        )
        update_data = {
            "access_token": access_token,
            "expires_at": time.time() + expires_in,
            "granted_scopes": scopes,
            "last_auth_error": None,
            "last_auth_error_detail": None,
            "last_auth_error_at": None,
        }
        if not access_token:
            await GooglePhotosOAuth.set_auth_error(
                credentials,
                code="refresh_missing_token",
                detail="Refresh response did not include access_token",
            )
            return None
        success = await update_google_photos_credentials(update_data)
        if not success:
            return None
        credentials.update(update_data)
        return access_token

    @staticmethod
    async def get_access_token(
        *,
        credentials: dict | None = None,
        required_scopes: Iterable[str] | None = None,
        force_refresh: bool = False,
        session: aiohttp.ClientSession | None = None,
    ) -> str | None:
        if credentials is None:
            credentials = await get_google_photos_credentials()
        required = _normalize_scopes(required_scopes)
        access_token = credentials.get("access_token")
        expires_at = credentials.get("expires_at")

        if (
            not force_refresh
            and access_token
            and expires_at
            and float(expires_at) > time.time() + 300
        ):
            if required and not _scopes_cover(credentials.get("granted_scopes", []), required):
                await GooglePhotosOAuth.set_auth_error(
                    credentials,
                    code="scope_missing",
                    detail=f"Missing required scopes: {', '.join(required)}",
                )
                return None
            return str(access_token)

        refreshed = await GooglePhotosOAuth.refresh_access_token(
            credentials=credentials,
            session=session,
        )
        if not refreshed:
            return None
        if required and not _scopes_cover(credentials.get("granted_scopes", []), required):
            await GooglePhotosOAuth.set_auth_error(
                credentials,
                code="scope_missing",
                detail=f"Missing required scopes: {', '.join(required)}",
            )
            return None
        return refreshed

    @staticmethod
    async def revoke_tokens(
        *,
        credentials: dict,
        session: aiohttp.ClientSession | None = None,
    ) -> None:
        if session is None:
            session = await get_session()

        tokens = []
        access_token = (credentials.get("access_token") or "").strip()
        refresh_token = (credentials.get("refresh_token") or "").strip()
        if access_token:
            tokens.append(access_token)
        if refresh_token:
            tokens.append(refresh_token)

        for token in tokens:
            try:
                async with session.post(
                    GOOGLE_OAUTH_REVOKE_URL,
                    params={"token": token},
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                ):
                    pass
            except Exception:
                logger.exception("Failed to revoke Google Photos token")


__all__ = [
    "GOOGLE_OAUTH_AUTHORIZE_URL",
    "GOOGLE_PHOTOS_SCOPE_APPENDONLY",
    "GOOGLE_PHOTOS_SCOPE_EDIT_APPCREATED",
    "GOOGLE_PHOTOS_SCOPE_PICKER_READONLY",
    "GooglePhotosOAuth",
]
