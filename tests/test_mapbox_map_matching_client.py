from __future__ import annotations

import pytest
from http_fakes import FakeResponse, FakeSession

from core.exceptions import ExternalServiceException
from core.http import mapbox
from core.http.mapbox import MapboxMapMatchingClient, sanitize_mapbox_message


def test_sanitize_mapbox_message_redacts_tokens_and_coordinates() -> None:
    message = "NoSegment near -97.123456,32.654321 access_token=pk.secret-token"

    sanitized = sanitize_mapbox_message(message)

    assert "pk.secret-token" not in sanitized
    assert "-97.123456,32.654321" not in sanitized
    assert "access_token=[redacted]" in sanitized
    assert "[coordinate]" in sanitized


def test_mapbox_endpoint_is_strictly_allowlisted() -> None:
    assert MapboxMapMatchingClient._is_allowed_endpoint(
        "https://api.mapbox.com/matching/v5/mapbox/driving"
    )
    assert not MapboxMapMatchingClient._is_allowed_endpoint(
        "https://example.com/matching/v5/mapbox/driving"
    )
    assert not MapboxMapMatchingClient._is_allowed_endpoint(
        "http://api.mapbox.com/matching/v5/mapbox/driving"
    )
    assert not MapboxMapMatchingClient._is_allowed_endpoint(
        "https://api.mapbox.com/styles/v1/mapbox/streets-v12"
    )


def test_valid_timestamps_must_be_complete_and_strictly_ascending() -> None:
    coords = [[-97.0, 32.0], [-97.1, 32.1], [-97.2, 32.2]]
    valid = [1_700_000_000, 1_700_000_005, 1_700_000_010]

    assert MapboxMapMatchingClient._valid_timestamps(coords, valid) == valid
    assert (
        MapboxMapMatchingClient._valid_timestamps(
            coords,
            [1_700_000_000, 1_700_000_000, 1_700_000_010],
        )
        is None
    )
    assert (
        MapboxMapMatchingClient._valid_timestamps(
            coords,
            [1_700_000_000, None, 1_700_000_010],
        )
        is None
    )
    assert (
        MapboxMapMatchingClient._valid_timestamps(
            coords,
            [1_700_000_000, 1_700_000_005],
        )
        is None
    )
    assert MapboxMapMatchingClient._valid_timestamps(coords, [0, 5, 10]) is None


@pytest.mark.asyncio
async def test_match_posts_form_request_with_token_in_url(monkeypatch) -> None:
    fake_session = FakeSession(
        post_responses=[
            FakeResponse(
                status=200,
                json_data={
                    "code": "Ok",
                    "matchings": [
                        {
                            "confidence": 0.92,
                            "geometry": {
                                "type": "LineString",
                                "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
                            },
                        }
                    ],
                },
            )
        ]
    )

    async def fake_get_session() -> FakeSession:
        return fake_session

    monkeypatch.setattr(mapbox, "get_session", fake_get_session)
    monkeypatch.setattr(mapbox, "get_mapbox_map_matching_radius_meters", lambda: 25.0)
    monkeypatch.setattr(
        mapbox,
        "get_mapbox_map_matching_timeout_seconds",
        lambda: 5.0,
    )

    client = MapboxMapMatchingClient(token="sk.test-token")
    result = await client.match(
        [[-97.0, 32.0], [-97.1, 32.1]],
        [1_700_000_000, 1_700_000_005],
    )

    assert result["code"] == "Ok"
    assert result["confidence"] == 0.92
    assert len(fake_session.requests) == 1
    method, url, kwargs = fake_session.requests[0]
    assert method == "POST"
    assert url == "https://api.mapbox.com/matching/v5/mapbox/driving"
    assert kwargs["params"] == {"access_token": "sk.test-token"}
    assert kwargs["headers"] == {"Content-Type": "application/x-www-form-urlencoded"}
    assert kwargs["data"] == {
        "coordinates": "-97.000000,32.000000;-97.100000,32.100000",
        "geometries": "geojson",
        "overview": "full",
        "tidy": "true",
        "radiuses": "25.0;25.0",
        "timestamps": "1700000000;1700000005",
    }


@pytest.mark.asyncio
async def test_match_omits_invalid_timestamps(monkeypatch) -> None:
    fake_session = FakeSession(
        post_responses=[
            FakeResponse(
                status=200,
                json_data={
                    "code": "Ok",
                    "matchings": [
                        {
                            "geometry": {
                                "type": "LineString",
                                "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
                            }
                        }
                    ],
                },
            )
        ]
    )

    async def fake_get_session() -> FakeSession:
        return fake_session

    monkeypatch.setattr(mapbox, "get_session", fake_get_session)
    monkeypatch.setattr(mapbox, "get_mapbox_map_matching_radius_meters", lambda: 0)
    monkeypatch.setattr(
        mapbox,
        "get_mapbox_map_matching_timeout_seconds",
        lambda: 5.0,
    )

    client = MapboxMapMatchingClient(token="sk.test-token")
    await client.match(
        [[-97.0, 32.0], [-97.1, 32.1]],
        [1_700_000_005, 1_700_000_000],
    )

    data = fake_session.requests[0][2]["data"]
    assert "timestamps" not in data
    assert "radiuses" not in data


@pytest.mark.asyncio
async def test_match_sanitizes_provider_errors(monkeypatch) -> None:
    fake_session = FakeSession(
        post_responses=[
            FakeResponse(
                status=200,
                json_data={
                    "code": "NoSegment",
                    "message": "NoSegment near -97.123456,32.654321",
                },
            )
        ]
    )

    async def fake_get_session() -> FakeSession:
        return fake_session

    monkeypatch.setattr(mapbox, "get_session", fake_get_session)
    monkeypatch.setattr(
        mapbox,
        "get_mapbox_map_matching_timeout_seconds",
        lambda: 5.0,
    )

    client = MapboxMapMatchingClient(token="sk.test-token")
    result = await client.match([[-97.0, 32.0], [-97.1, 32.1]])

    assert result == {
        "code": "Error",
        "provider_code": "NoSegment",
        "message": "NoSegment near [coordinate]",
    }


@pytest.mark.asyncio
async def test_match_requires_token() -> None:
    client = MapboxMapMatchingClient(token="")

    with pytest.raises(ExternalServiceException) as raised:
        await client.match([[-97.0, 32.0], [-97.1, 32.1]])

    assert "token is not configured" in raised.value.message
