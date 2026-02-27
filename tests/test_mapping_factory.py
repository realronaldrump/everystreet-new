from __future__ import annotations

from types import SimpleNamespace

import pytest
from beanie.exceptions import CollectionWasNotInitialized

from core.exceptions import ValidationException
from core.mapping.factory import get_mapping_provider, is_google_map_provider
from core.mapping.google_provider import GoogleProvider
from core.mapping.local_provider import LocalProvider
from db.models import AppSettings, MapProvider


@pytest.mark.asyncio
async def test_get_mapping_provider_returns_google_provider(monkeypatch: pytest.MonkeyPatch):
    async def fake_find_one(_query):
        return SimpleNamespace(
            map_provider=MapProvider.GOOGLE,
            google_maps_api_key="test-key",
        )

    monkeypatch.setattr(AppSettings, "find_one", fake_find_one)

    provider = await get_mapping_provider()
    assert isinstance(provider, GoogleProvider)


@pytest.mark.asyncio
async def test_get_mapping_provider_returns_local_provider(monkeypatch: pytest.MonkeyPatch):
    async def fake_find_one(_query):
        return SimpleNamespace(
            map_provider=MapProvider.SELF_HOSTED,
            google_maps_api_key=None,
        )

    monkeypatch.setattr(AppSettings, "find_one", fake_find_one)

    provider = await get_mapping_provider()
    assert isinstance(provider, LocalProvider)


@pytest.mark.asyncio
async def test_get_mapping_provider_raises_when_google_key_missing(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_find_one(_query):
        return SimpleNamespace(
            map_provider=MapProvider.GOOGLE,
            google_maps_api_key="  ",
        )

    monkeypatch.setattr(AppSettings, "find_one", fake_find_one)

    with pytest.raises(ValidationException):
        await get_mapping_provider()


@pytest.mark.asyncio
async def test_get_mapping_provider_raises_when_settings_missing(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_find_one(_query):
        return None

    monkeypatch.setattr(AppSettings, "find_one", fake_find_one)

    with pytest.raises(ValidationException):
        await get_mapping_provider()


@pytest.mark.asyncio
async def test_get_mapping_provider_raises_when_collection_uninitialized(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_find_one(_query):
        raise CollectionWasNotInitialized()

    monkeypatch.setattr(AppSettings, "find_one", fake_find_one)

    with pytest.raises(ValidationException):
        await get_mapping_provider()


@pytest.mark.asyncio
async def test_is_google_map_provider(monkeypatch: pytest.MonkeyPatch):
    async def fake_find_one(_query):
        return SimpleNamespace(
            map_provider=MapProvider.GOOGLE,
            google_maps_api_key="test-key",
        )

    monkeypatch.setattr(AppSettings, "find_one", fake_find_one)

    assert await is_google_map_provider() is True
