import pytest

from routing.validation import validate_route


def _coords_small_gap() -> list[list[float]]:
    # ~36ft gap (0.0001 degrees latitude)
    return [[0.0, 0.0], [0.0, 0.0001]]


def test_validate_route_coverage_ratio_uses_eligible_segments() -> None:
    stats = {
        "required_distance": 10_000.0,
        "required_distance_completed": 10_000.0,
        "total_distance": 12_000.0,
        "deadhead_distance": 2_000.0,
        "required_reqs": 10.0,
        "skipped_disconnected": 0.0,
    }

    errors, warnings, details = validate_route(
        _coords_small_gap(),
        stats,
        mapped_segments=80,
        total_segments=100,
        eligible_segments=90,
        skipped_invalid_geometry=10,
        skipped_mapping_distance=10,
    )

    assert errors
    assert any("eligible undriven segments mapped" in msg for msg in errors)
    assert warnings == []
    assert details["coverage_ratio"] == pytest.approx(80 / 90)


def test_validate_route_deadhead_ratio_floor_warns_for_tiny_required_work() -> None:
    # required work is tiny: ratio is noisy, should warn not error.
    stats = {
        "required_distance": 100.0,
        "required_distance_completed": 100.0,
        "total_distance": 2_000.0,
        "deadhead_distance": 1_900.0,
        "required_reqs": 1.0,
        "skipped_disconnected": 0.0,
    }

    errors, warnings, details = validate_route(
        _coords_small_gap(),
        stats,
        mapped_segments=1,
        total_segments=1,
        eligible_segments=1,
    )

    assert errors == []
    assert warnings
    assert details["deadhead_ratio_completed"] == pytest.approx(20.0)


def test_validate_route_deadhead_ratio_errors_for_large_required_work() -> None:
    # required work is large: ratio threshold should hard-fail.
    stats = {
        "required_distance": 6_000.0,
        "required_distance_completed": 6_000.0,
        "total_distance": 70_000.0,
        "deadhead_distance": 64_000.0,
        "required_reqs": 1.0,
        "skipped_disconnected": 0.0,
    }

    errors, warnings, _details = validate_route(
        _coords_small_gap(),
        stats,
        mapped_segments=1,
        total_segments=1,
        eligible_segments=1,
    )

    assert warnings == []
    assert errors
    assert any("Deadhead ratio" in msg for msg in errors)


def test_validate_route_skipped_requirements_warn_vs_error() -> None:
    base_stats = {
        "required_distance": 10_000.0,
        "required_distance_completed": 10_000.0,
        "total_distance": 12_000.0,
        "deadhead_distance": 2_000.0,
    }

    # Small skip -> warning
    errors, warnings, _details = validate_route(
        _coords_small_gap(),
        dict(base_stats, required_reqs=100.0, skipped_disconnected=1.0),
        mapped_segments=100,
        total_segments=100,
        eligible_segments=100,
    )
    assert errors == []
    assert any("skipped 1/100" in msg for msg in warnings)

    # Larger skip -> error
    errors, warnings, _details = validate_route(
        _coords_small_gap(),
        dict(base_stats, required_reqs=100.0, skipped_disconnected=5.0),
        mapped_segments=100,
        total_segments=100,
        eligible_segments=100,
    )
    assert warnings == []
    assert any("skipped 5/100" in msg for msg in errors)

