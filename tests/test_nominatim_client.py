from unittest.mock import AsyncMock

import pytest

from core.exceptions import ExternalServiceException
from core.http.nominatim import NominatimClient
from tests.http_fakes import FakeResponse, FakeSession


@pytest.mark.asyncio
async def test_nominatim_search_normalizes_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(
        status=200,
        json_data=[
            {
                "display_name": "Waco, Texas",
                "lon": "-97.1467",
                "lat": "31.5493",
                "type": "city",
                "name": "Waco",
                "osm_id": 123,
                "osm_type": "relation",
                "address": {"state": "Texas"},
                "importance": 0.9,
                "boundingbox": ["31.4", "31.6", "-97.2", "-97.0"],
            },
        ],
    )
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    results = await client.search("Waco", proximity=(-97.0, 32.0), limit=1)

    assert results[0]["place_name"] == "Waco, Texas"
    assert results[0]["center"] == [-97.1467, 31.5493]
    assert results[0]["place_type"] == ["city"]
    assert session.requests[0][2]["params"]["bounded"] == 1


@pytest.mark.asyncio
async def test_nominatim_search_raises_on_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=500, text_data="boom")
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()

    with pytest.raises(ExternalServiceException) as raised:
        await client.search("Waco")

    assert "Nominatim search" in raised.value.message


@pytest.mark.asyncio
async def test_nominatim_reverse_returns_json(monkeypatch: pytest.MonkeyPatch) -> None:
    response = FakeResponse(status=200, json_data={"place_id": 42})
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    result = await client.reverse(31.5, -97.1)

    assert result == {"place_id": 42}


@pytest.mark.asyncio
async def test_nominatim_reverse_returns_none_on_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=404, text_data="not found")
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    result = await client.reverse(31.5, -97.1)

    assert result is None


@pytest.mark.asyncio
async def test_nominatim_reverse_raises_on_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=500, text_data="oops")
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()

    with pytest.raises(ExternalServiceException) as raised:
        await client.reverse(31.5, -97.1)

    assert "Nominatim reverse" in raised.value.message
