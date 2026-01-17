import time
from unittest.mock import AsyncMock

import pytest

from bouncie_oauth import BouncieOAuth
from tests.http_fakes import FakeResponse, FakeSession


@pytest.mark.asyncio
async def test_get_access_token_returns_cached() -> None:
    credentials = {
        "access_token": "cached",
        "expires_at": time.time() + 1000,
    }

    token = await BouncieOAuth.get_access_token(
        session=FakeSession(),
        credentials=credentials,
    )

    assert token == "cached"


@pytest.mark.asyncio
async def test_get_access_token_missing_auth_code() -> None:
    credentials = {
        "client_id": "client",
        "client_secret": "secret",
        "redirect_uri": "https://example.com",
        "authorization_code": "",
    }

    token = await BouncieOAuth.get_access_token(
        session=FakeSession(),
        credentials=credentials,
    )

    assert token is None


@pytest.mark.asyncio
async def test_get_access_token_missing_oauth_fields() -> None:
    credentials = {
        "client_id": "client",
        "client_secret": "",
        "redirect_uri": "https://example.com",
        "authorization_code": "auth",
    }

    token = await BouncieOAuth.get_access_token(
        session=FakeSession(),
        credentials=credentials,
    )

    assert token is None


@pytest.mark.asyncio
async def test_get_access_token_handles_unauthorized() -> None:
    credentials = {
        "client_id": "client",
        "client_secret": "secret",
        "redirect_uri": "https://example.com",
        "authorization_code": "auth",
    }
    session = FakeSession(
        post_responses=[FakeResponse(status=401, text_data="unauthorized")],
    )

    token = await BouncieOAuth.get_access_token(
        session=session,
        credentials=credentials,
    )

    assert token is None


@pytest.mark.asyncio
async def test_get_access_token_saves_token(monkeypatch: pytest.MonkeyPatch) -> None:
    credentials = {
        "client_id": "client",
        "client_secret": "secret",
        "redirect_uri": "https://example.com",
        "authorization_code": "auth",
    }
    session = FakeSession(
        post_responses=[
            FakeResponse(
                status=200,
                json_data={"access_token": "new-token", "expires_in": 120},
            ),
        ],
    )
    update = AsyncMock(return_value=True)
    monkeypatch.setattr("bouncie_oauth.update_bouncie_credentials", update)

    token = await BouncieOAuth.get_access_token(
        session=session,
        credentials=credentials,
    )

    assert token == "new-token"
    assert credentials["access_token"] == "new-token"
    assert credentials["expires_at"] > time.time()
