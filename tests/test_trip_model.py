from datetime import UTC, datetime, timedelta

import pytest

from db.models import Trip


def test_trip_gps_list_normalization_deduplicates() -> None:
    trip = Trip(
        gps=[
            [-97.0, 32.0],
            [-97.0, 32.0],
            [-96.9, 32.1],
            [200, 0],
            "bad",
        ],
    )

    assert trip.gps is not None
    assert trip.gps["type"] == "LineString"
    assert trip.gps["coordinates"] == [[-97.0, 32.0], [-96.9, 32.1]]


def test_trip_gps_single_point_becomes_point() -> None:
    trip = Trip(gps=[[-97.0, 32.0]])
    assert trip.gps is not None
    assert trip.gps["type"] == "Point"
    assert trip.gps["coordinates"] == [-97.0, 32.0]


def test_trip_validate_meaningful_flags_stationary() -> None:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = start + timedelta(minutes=1)
    trip = Trip(
        distance=0.01,
        maxSpeed=0.2,
        startTime=start,
        endTime=end,
        gps={"type": "LineString", "coordinates": [[0.0, 0.0], [0.0001, 0.0001]]},
    )

    valid, message = trip.validate_meaningful()
    assert not valid
    assert message is not None
    assert "Stationary trip" in message


def test_trip_validate_meaningful_accepts_moving() -> None:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = start + timedelta(minutes=15)
    trip = Trip(
        distance=1.25,
        maxSpeed=30.0,
        startTime=start,
        endTime=end,
        gps={"type": "LineString", "coordinates": [[0.0, 0.0], [0.01, 0.01]]},
    )

    valid, message = trip.validate_meaningful()
    assert valid
    assert message is None


@pytest.mark.asyncio
async def test_trip_insert_and_find_round_trip(beanie_db) -> None:
    trip = Trip(
        transactionId="tx-123",
        startTime="2024-01-01T00:00:00Z",
        endTime="2024-01-01T00:10:00Z",
        gps=[[-97.0, 32.0], [-97.1, 32.1]],
    )

    await trip.insert()
    found = await Trip.find_one(Trip.transactionId == "tx-123")

    assert found is not None
    assert found.startTime is not None
    assert found.startTime.tzinfo == UTC
    assert found.gps is not None
    assert found.gps["type"] == "LineString"
