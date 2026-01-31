from datetime import UTC, datetime, timedelta

from core.spatial import extract_timestamps_for_coordinates


def test_elapsed_from_coordinate_timestamps() -> None:
    coords = [[-1.0, 1.0], [-1.1, 1.1], [-1.2, 1.2]]
    trip_data = {
        "coordinates": [
            {"timestamp": 100},
            {"timestamp": 105},
            {"timestamp": 110},
        ],
    }

    result = extract_timestamps_for_coordinates(coords, trip_data)

    assert result == [0, 5, 10]


def test_elapsed_from_start_end_times() -> None:
    coords = [[-1.0, 1.0], [-1.1, 1.1], [-1.2, 1.2]]
    start = datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC)
    end = start + timedelta(seconds=10)
    trip_data = {"startTime": start, "endTime": end}

    result = extract_timestamps_for_coordinates(coords, trip_data)

    assert result == [0, 5, 10]


def test_incomplete_coordinate_timestamps_returns_none() -> None:
    coords = [[-1.0, 1.0], [-1.1, 1.1]]
    trip_data = {"coordinates": [{"timestamp": 100}, {}]}

    result = extract_timestamps_for_coordinates(coords, trip_data)

    assert result == [None, None]
