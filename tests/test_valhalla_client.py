import pytest

from core.exceptions import ExternalServiceException
from core.http.valhalla import ValhallaClient


@pytest.mark.asyncio
async def test_valhalla_route_requires_two_locations() -> None:
    client = ValhallaClient()

    with pytest.raises(ExternalServiceException) as raised:
        await client.route([[0.0, 0.0]])

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


def test_coerce_shape_coordinates_handles_dict_points() -> None:
    """_coerce_shape_coordinates should extract lon/lat from dict points."""
    shape = [{"lon": 1.0, "lat": 2.0}, {"lon": 3.0, "lat": 4.0}]
    coords = ValhallaClient._coerce_shape_coordinates(shape)
    assert coords == [[1.0, 2.0], [3.0, 4.0]]


def test_coerce_shape_coordinates_handles_list_points() -> None:
    """_coerce_shape_coordinates should handle [lon, lat] list format."""
    shape = [[1.0, 2.0], [3.0, 4.0]]
    coords = ValhallaClient._coerce_shape_coordinates(shape)
    assert coords == [[1.0, 2.0], [3.0, 4.0]]


def test_coerce_shape_coordinates_handles_tuple_points() -> None:
    """_coerce_shape_coordinates should handle (lon, lat) tuple format."""
    shape = [(1.0, 2.0), (3.0, 4.0)]
    coords = ValhallaClient._coerce_shape_coordinates(shape)
    assert coords == [[1.0, 2.0], [3.0, 4.0]]


def test_coerce_shape_coordinates_skips_invalid_points() -> None:
    """_coerce_shape_coordinates should skip malformed points gracefully."""
    shape = [
        [1.0, 2.0],
        "invalid",
        None,
        [3.0],  # too short
        {"lon": None, "lat": 4.0},  # missing lon
        [5.0, 6.0],
    ]
    coords = ValhallaClient._coerce_shape_coordinates(shape)
    assert coords == [[1.0, 2.0], [5.0, 6.0]]


def test_coerce_shape_coordinates_returns_empty_for_none() -> None:
    """_coerce_shape_coordinates should return empty list for None input."""
    assert ValhallaClient._coerce_shape_coordinates(None) == []


def test_coerce_shape_coordinates_handles_shape_dict_wrapper() -> None:
    """_coerce_shape_coordinates should unwrap dict with 'coordinates' key."""
    shape = {"coordinates": [[1.0, 2.0], [3.0, 4.0]]}
    coords = ValhallaClient._coerce_shape_coordinates(shape)
    assert coords == [[1.0, 2.0], [3.0, 4.0]]


def test_coerce_shape_coordinates_handles_encoded_polyline() -> None:
    """_coerce_shape_coordinates should decode encoded polyline strings."""
    shape = "__c`|@~bl_xD_ibE~hbE"
    coords = ValhallaClient._coerce_shape_coordinates(shape)
    assert coords == [[-97.0, 32.0], [-97.1, 32.1]]


def test_normalize_route_response_handles_missing_legs() -> None:
    """_normalize_route_response should handle missing or empty legs."""
    data = {"trip": {"legs": []}}
    normalized = ValhallaClient._normalize_route_response(data)

    assert normalized["geometry"] is None
    assert normalized["duration_seconds"] == 0
    assert normalized["distance_meters"] == 0


def test_normalize_route_response_decodes_polyline_shape() -> None:
    data = {
        "trip": {
            "legs": [{"summary": {"length": 1.2, "time": 300}}],
            "shape": "__c`|@~bl_xD_ibE~hbE",
        },
    }

    normalized = ValhallaClient._normalize_route_response(data)

    assert normalized["geometry"]["coordinates"] == [[-97.0, 32.0], [-97.1, 32.1]]
