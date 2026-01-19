from unittest.mock import AsyncMock
import pytest

from core.http.blocklist import DEFAULT_FORBIDDEN_HOSTS, is_forbidden_host
from core.http.request import request_json
from tests.http_fakes import FakeResponse, FakeSession


def test_is_forbidden_host_matches_known_hosts() -> None:
    assert is_forbidden_host("https://overpass-api.de/api/interpreter")
    assert is_forbidden_host("https://nominatim.openstreetmap.org/search")
    assert is_forbidden_host("https://api.mapbox.com/styles/v1")


@pytest.mark.asyncio
async def test_request_json_raises_on_forbidden_host() -> None:
    session = FakeSession(get_responses=[FakeResponse(status=200, json_data={})])

    url = "https://overpass-api.de/api/interpreter"
    with pytest.raises(ValueError):
        await request_json(
            "GET",
            url,
            session=session,
            service_name="Test",
        )


@pytest.mark.asyncio
async def test_request_json_allows_local_host() -> None:
    session = FakeSession(
        get_responses=[FakeResponse(status=200, json_data={"ok": True})]
    )

    data = await request_json(
        "GET",
        "http://nominatim.test/search",
        session=session,
        service_name="Test",
    )
    assert data == {"ok": True}
    assert not is_forbidden_host(
        "http://nominatim.test/search", DEFAULT_FORBIDDEN_HOSTS
    )


@pytest.mark.asyncio
async def test_request_json_raises_on_rate_limit() -> None:
    response = FakeResponse(
        status=429, text_data="rate limited", headers={"Retry-After": "3"}
    )
    session = FakeSession(get_responses=[response])

    from aiohttp import ClientResponseError

    with pytest.raises(ClientResponseError):
        await request_json(
            "GET",
            "http://nominatim.test/search",
            session=session,
            service_name="Test",
        )
