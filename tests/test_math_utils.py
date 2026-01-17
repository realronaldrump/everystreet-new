from core.math_utils import calculate_circular_average_hour


def test_circular_average_handles_empty() -> None:
    assert calculate_circular_average_hour([]) == 0.0


def test_circular_average_wraps_midnight() -> None:
    avg = calculate_circular_average_hour([23.0, 0.0, 1.0])
    assert 23.0 <= avg or avg <= 1.0


def test_circular_average_standard_case() -> None:
    avg = calculate_circular_average_hour([10.0, 12.0, 14.0])
    assert round(avg, 1) == 12.0
