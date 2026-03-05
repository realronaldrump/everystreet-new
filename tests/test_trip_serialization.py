from __future__ import annotations

from datetime import UTC, datetime

from trips.serialization import TripSerializer


def test_calculate_duration_seconds_prefers_existing_duration() -> None:
    trip = {
        "duration": "123.5",
        "startTime": "2024-01-01T00:00:00Z",
        "endTime": "2024-01-01T01:00:00Z",
    }
    assert TripSerializer.calculate_duration_seconds(trip) == 123.5


def test_calculate_duration_seconds_falls_back_to_start_end() -> None:
    trip = {
        "startTime": "2024-01-01T00:00:00Z",
        "endTime": "2024-01-01T00:10:30Z",
    }
    assert TripSerializer.calculate_duration_seconds(trip) == 630.0


def test_to_dict_normalizes_trip_fields() -> None:
    trip = {
        "transactionId": "tx-1",
        "imei": "123456",
        "vin": "VIN123",
        "startTime": "2024-01-01T00:00:00Z",
        "endTime": "2024-01-01T00:30:00Z",
        "startTimeZone": "America/Chicago",
        "distance": "12.34",
        "maxSpeed": "55.5",
        "fuelConsumed": "1.2",
        "matched_at": datetime(2024, 1, 1, 1, 0, tzinfo=UTC),
    }

    serialized = TripSerializer.to_dict(trip)

    assert serialized["transactionId"] == "tx-1"
    assert serialized["startTime"].startswith("2024-01-01T00:00:00")
    assert serialized["endTime"].startswith("2024-01-01T00:30:00")
    assert serialized["timeZone"] == "America/Chicago"
    assert serialized["distance"] == 12.34
    assert serialized["maxSpeed"] == 55.5
    assert serialized["fuelConsumed"] == 1.2
    assert serialized["duration"] == 1800.0
    assert isinstance(serialized["matched_at"], str)


def test_to_dict_supports_field_subset() -> None:
    trip = {
        "transactionId": "tx-2",
        "startTime": "2024-01-01T00:00:00Z",
        "endTime": "2024-01-01T00:01:00Z",
        "distance": 1.0,
    }

    subset = TripSerializer.to_dict(
        trip, fields={"transactionId", "duration", "distance"}
    )

    assert subset == {
        "transactionId": "tx-2",
        "duration": 60.0,
        "distance": 1.0,
    }


def test_to_geojson_properties_handles_optional_fields() -> None:
    trip = {
        "transactionId": "tx-3",
        "startTime": "2024-01-01T00:00:00Z",
        "endTime": "2024-01-01T00:01:00Z",
        "distance": 1.0,
        "matched_at": datetime(2024, 1, 1, 1, 0, tzinfo=UTC),
    }

    props = TripSerializer.to_geojson_properties(
        trip,
        estimated_cost=4.5,
        points_recorded=12,
        include_matched_at=False,
        coverage_distance_miles=0.7,
    )

    assert props["estimated_cost"] == 4.5
    assert props["pointsRecorded"] == 12
    assert props["coverageDistance"] == 0.7
    assert "matched_at" not in props
