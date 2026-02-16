import time
from unittest.mock import AsyncMock

import pytest
from http_fakes import FakeResponse, FakeSession

from google_photos.services.oauth import (
    GOOGLE_PHOTOS_SCOPE_PICKER_READONLY,
    GooglePhotosOAuth,
)


@pytest.mark.asyncio
async def test_get_access_token_uses_cached_token_when_scope_present() -> None:
    credentials = {
        "access_token": "cached-token",
        "expires_at": time.time() + 1200,
        "granted_scopes": [GOOGLE_PHOTOS_SCOPE_PICKER_READONLY],
    }

    token = await GooglePhotosOAuth.get_access_token(
        credentials=credentials,
        required_scopes=[GOOGLE_PHOTOS_SCOPE_PICKER_READONLY],
        session=FakeSession(),
    )

    assert token == "cached-token"


@pytest.mark.asyncio
async def test_get_access_token_rejects_when_scope_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "google_photos.services.oauth.update_google_photos_credentials",
        AsyncMock(return_value=True),
    )
    credentials = {
        "access_token": "cached-token",
        "expires_at": time.time() + 1200,
        "granted_scopes": [],
    }

    token = await GooglePhotosOAuth.get_access_token(
        credentials=credentials,
        required_scopes=[GOOGLE_PHOTOS_SCOPE_PICKER_READONLY],
        session=FakeSession(),
    )

    assert token is None


@pytest.mark.asyncio
async def test_refresh_access_token_updates_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "google_photos.services.oauth.update_google_photos_credentials",
        AsyncMock(return_value=True),
    )
    credentials = {
        "client_id": "client",
        "client_secret": "secret",
        "refresh_token": "refresh-token",
        "granted_scopes": [GOOGLE_PHOTOS_SCOPE_PICKER_READONLY],
    }
    session = FakeSession(
        post_responses=[
            FakeResponse(
                status=200,
                json_data={
                    "access_token": "new-token",
                    "expires_in": 90,
                    "scope": GOOGLE_PHOTOS_SCOPE_PICKER_READONLY,
                },
            ),
        ],
    )

    token = await GooglePhotosOAuth.refresh_access_token(
        credentials=credentials,
        session=session,
    )

    assert token == "new-token"
    assert credentials["access_token"] == "new-token"
    assert credentials["expires_at"] > time.time()


@pytest.mark.asyncio
async def test_exchange_authorization_code_saves_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "google_photos.services.oauth.update_google_photos_credentials",
        AsyncMock(return_value=True),
    )
    credentials = {
        "client_id": "client",
        "client_secret": "secret",
        "redirect_uri": "https://example.com/api/google-photos/callback",
    }
    session = FakeSession(
        post_responses=[
            FakeResponse(
                status=200,
                json_data={
                    "access_token": "access",
                    "refresh_token": "refresh",
                    "expires_in": 120,
                    "scope": GOOGLE_PHOTOS_SCOPE_PICKER_READONLY,
                },
            ),
        ],
    )

    ok = await GooglePhotosOAuth.exchange_authorization_code(
        code="auth-code",
        credentials=credentials,
        session=session,
    )

    assert ok is True
    assert credentials["access_token"] == "access"
    assert credentials["refresh_token"] == "refresh"
    assert GOOGLE_PHOTOS_SCOPE_PICKER_READONLY in credentials["granted_scopes"]

