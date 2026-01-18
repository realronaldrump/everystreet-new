import pytest
import pytest

from core.exceptions import ExternalServiceException
from core.http.valhalla import ValhallaClient


@pytest.mark.asyncio
async def test_valhalla_route_requires_two_locations() -> None:
    client = ValhallaClient()

    with pytest.raises(ExternalServiceException) as raised:
        await client.route([(0.0, 0.0)])

    assert "at least two locations" in raised.value.message


@pytest.mark.asyncio
async def test_valhalla_trace_route_requires_two_points() -> None:
    client = ValhallaClient()

    with pytest.raises(ExternalServiceException) as raised:
        await client.trace_route([{"lat": 0.0, "lon": 0.0}])

    assert "at least two points" in raised.value.message


def test_normalize_route_response_extracts_geometry() -> None:
    data = {
        "trip": {
            "legs": [{"summary": {"length": 1.2, "time": 300}}],
            "shape": {"coordinates": [[0.0, 0.0], [1.0, 1.0]]},
        },
    }

    normalized = ValhallaClient._normalize_route_response(data)

    assert normalized["geometry"]["type"] == "LineString"
    assert normalized["duration_seconds"] == 300
    assert normalized["distance_meters"] == 1200


def test_normalize_route_response_extracts_geometry_from_leg() -> None:
    data = {
        "trip": {
            "legs": [
                {
                    "summary": {"length": 1.2, "time": 300},
                    "shape": {"coordinates": [[0.0, 0.0], [1.0, 1.0]]},
                },
            ],
        },
    }

    normalized = ValhallaClient._normalize_route_response(data)

    assert normalized["geometry"]["type"] == "LineString"
    assert normalized["geometry"]["coordinates"] == [[0.0, 0.0], [1.0, 1.0]]


def test_normalize_trace_response_extracts_geometry() -> None:
    data = {"trip": {"shape": {"coordinates": [[0.0, 0.0], [1.0, 1.0]]}}}

    normalized = ValhallaClient._normalize_trace_response(data)

    assert normalized["geometry"]["type"] == "LineString"
    assert normalized["geometry"]["coordinates"] == [[0.0, 0.0], [1.0, 1.0]]


def test_normalize_trace_response_extracts_geometry_from_leg() -> None:
    data = {"trip": {"legs": [{"shape": {"coordinates": [[0.0, 0.0], [1.0, 1.0]]}}]}}

    normalized = ValhallaClient._normalize_trace_response(data)

    assert normalized["geometry"]["type"] == "LineString"
    assert normalized["geometry"]["coordinates"] == [[0.0, 0.0], [1.0, 1.0]]


def test_normalize_trace_response_extracts_geometry_from_top_level() -> None:
    data = {"shape": {"coordinates": [[0.0, 0.0], [1.0, 1.0]]}}

    normalized = ValhallaClient._normalize_trace_response(data)

    assert normalized["geometry"]["type"] == "LineString"
    assert normalized["geometry"]["coordinates"] == [[0.0, 0.0], [1.0, 1.0]]


def test_normalize_trace_response_returns_none_for_empty_coords() -> None:
    """Verify that empty coordinates result in None geometry, not empty LineString."""
    # Empty trip
    data = {"trip": {}}
    normalized = ValhallaClient._normalize_trace_response(data)
    assert normalized["geometry"] is None

    # Empty shape
    data = {"trip": {"shape": {}}}
    normalized = ValhallaClient._normalize_trace_response(data)
    assert normalized["geometry"] is None

    # Empty coordinates
    data = {"trip": {"shape": {"coordinates": []}}}
    normalized = ValhallaClient._normalize_trace_response(data)
    assert normalized["geometry"] is None
