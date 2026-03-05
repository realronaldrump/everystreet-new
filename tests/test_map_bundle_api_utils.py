from __future__ import annotations

from api.map_bundle import encode_polyline6, simplify_line_meters
from core.http.valhalla import ValhallaClient


def test_encode_polyline6_round_trip() -> None:
    coords = [
        [-97.146700, 31.549300],
        [-97.146100, 31.549900],
        [-97.145500, 31.550400],
    ]

    encoded = encode_polyline6(coords)
    decoded = ValhallaClient._decode_polyline(encoded, 6)

    assert len(decoded) == len(coords)
    for expected, actual in zip(coords, decoded, strict=True):
        assert abs(expected[0] - actual[0]) < 1e-6
        assert abs(expected[1] - actual[1]) < 1e-6


def test_simplify_line_meters_keeps_endpoints() -> None:
    coords = [
        [-97.1000, 31.5000],
        [-97.0999, 31.5003],
        [-97.0998, 31.5006],
        [-97.0997, 31.5009],
        [-97.0996, 31.5012],
    ]

    simplified = simplify_line_meters(coords, tolerance_m=40.0)

    assert simplified[0] == coords[0]
    assert simplified[-1] == coords[-1]
    assert len(simplified) < len(coords)
