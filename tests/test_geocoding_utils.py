from unittest.mock import AsyncMock

import pytest
from aiohttp import ClientResponseError

from core.http.geocoding import reverse_geocode_nominatim, validate_location_osm
from tests.http_fakes import FakeResponse, FakeSession


@pytest.mark.asyncio
async def test_validate_location_osm_returns_first_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=200, json_data=[{"display_name": "Waco"}])
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.geocoding.get_session",
        AsyncMock(return_value=session),
    )

    result = await validate_location_osm("Waco", "city")
    assert result == {"display_name": "Waco"}


@pytest.mark.asyncio
async def test_validate_location_osm_returns_none_on_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=500, text_data="oops")
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.geocoding.get_session",
        AsyncMock(return_value=session),
    )

    result = await validate_location_osm("Waco", "city")
    assert result is None


@pytest.mark.asyncio
async def test_reverse_geocode_returns_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    response = FakeResponse(status=200, json_data={"place_id": 7})
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.geocoding.get_session",
        AsyncMock(return_value=session),
    )

    result = await reverse_geocode_nominatim(31.5, -97.1)
    assert result == {"place_id": 7}


@pytest.mark.asyncio
async def test_reverse_geocode_returns_none_on_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=500, text_data="boom")
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.geocoding.get_session",
        AsyncMock(return_value=session),
    )

    result = await reverse_geocode_nominatim(31.5, -97.1)
    assert result is None


@pytest.mark.asyncio
async def test_reverse_geocode_raises_on_rate_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(
        status=429,
        text_data="rate limited",
        headers={"Retry-After": "7"},
    )
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.geocoding.get_session",
        AsyncMock(return_value=session),
    )

    with pytest.raises(ClientResponseError) as raised:
        await reverse_geocode_nominatim.__wrapped__(31.5, -97.1)

    assert raised.value.status == 429
