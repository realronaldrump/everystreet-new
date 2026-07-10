from unittest.mock import AsyncMock

import pytest
from http_fakes import FakeResponse, FakeSession

from core.exceptions import ExternalServiceException
from core.http.nominatim import NominatimClient


@pytest.mark.asyncio
async def test_search_raw_returns_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(
        status=200,
        json_data=[{"display_name": "Waco", "type": "city"}],
    )
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    result = await client.search_raw(query="Waco", limit=1, polygon_geojson=True)
    assert result == [{"display_name": "Waco", "type": "city"}]


@pytest.mark.asyncio
async def test_search_raw_raises_on_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=500, text_data="oops")
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    with pytest.raises(ExternalServiceException):
        await client.search_raw(query="Waco", limit=1, polygon_geojson=True)


@pytest.mark.asyncio
async def test_reverse_geocode_returns_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    response = FakeResponse(status=200, json_data={"place_id": 7})
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    result = await client.reverse(31.5, -97.1)
    assert result == {"place_id": 7}


@pytest.mark.asyncio
async def test_reverse_geocode_raises_on_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=500, text_data="boom")
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    with pytest.raises(ExternalServiceException):
        await client.reverse(31.5, -97.1)


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
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    with pytest.raises(ExternalServiceException) as raised:
        await client.reverse(31.5, -97.1)

    assert raised.value.details.get("status") == 429


@pytest.mark.asyncio
async def test_lookup_raw_builds_lookup_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(status=200, json_data=[{"osm_id": 123}])
    session = FakeSession(get_responses=[response])
    monkeypatch.setattr(
        "core.http.nominatim.get_session",
        AsyncMock(return_value=session),
    )

    client = NominatimClient()
    result = await client.lookup_raw(osm_id="123", osm_type="relation")

    assert result == [{"osm_id": 123}]
    method, url, kwargs = session.requests[0]
    assert method == "GET"
    assert "/lookup" in url
    assert kwargs["params"]["osm_ids"] == "R123"
