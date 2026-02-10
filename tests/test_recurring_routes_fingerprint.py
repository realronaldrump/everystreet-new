import pytest

from recurring_routes.models import BuildRecurringRoutesRequest
from recurring_routes.services.fingerprint import (
    compute_route_key,
    compute_route_signature,
    sample_waypoints,
)


def _trip_with_gps(coords: list[list[float]], *, distance_miles: float = 10.2) -> dict:
    return {
        "gps": {"type": "LineString", "coordinates": coords},
        "distance": distance_miles,
        "startGeoPoint": {"type": "Point", "coordinates": coords[0]},
        "destinationGeoPoint": {"type": "Point", "coordinates": coords[-1]},
    }


def test_route_key_stability_same_geometry() -> None:
    params = BuildRecurringRoutesRequest().model_dump()
    coords = [[0.001, 0.001], [0.02, 0.02], [0.05, 0.05]]
    trip = _trip_with_gps(coords)

    sig1 = compute_route_signature(trip, params)
    sig2 = compute_route_signature(trip, params)

    assert sig1 is not None
    assert sig1 == sig2
    assert compute_route_key(sig1) == compute_route_key(sig2)


def test_route_key_tolerates_small_noise_within_cells() -> None:
    params = BuildRecurringRoutesRequest().model_dump()
    coords = [[0.001, 0.001], [0.02, 0.02], [0.05, 0.05]]
    noisy = [[lon + 0.00005, lat - 0.00005] for lon, lat in coords]  # ~5-6m jitter

    sig1 = compute_route_signature(_trip_with_gps(coords), params)
    sig2 = compute_route_signature(_trip_with_gps(noisy), params)

    assert sig1 is not None
    assert sig1 == sig2


def test_route_key_changes_for_different_path_between_same_endpoints() -> None:
    params = BuildRecurringRoutesRequest().model_dump()
    diagonal = _trip_with_gps([[0.001, 0.001], [0.02, 0.02], [0.05, 0.05]])
    l_shape = _trip_with_gps([[0.001, 0.001], [0.001, 0.05], [0.05, 0.05]])

    sig1 = compute_route_signature(diagonal, params)
    sig2 = compute_route_signature(l_shape, params)

    assert sig1 is not None
    assert sig2 is not None
    assert sig1 != sig2


def test_waypoint_sampling_simple_line() -> None:
    points = [[0.0, 0.0], [0.01, 0.0]]
    waypoints = sample_waypoints(points, waypoint_count=4)
    assert len(waypoints) == 4

    expected_lons = [0.002, 0.004, 0.006, 0.008]
    for idx, expected in enumerate(expected_lons):
        assert waypoints[idx][1] == pytest.approx(0.0, abs=1e-9)
        assert waypoints[idx][0] == pytest.approx(expected, abs=1e-6)

