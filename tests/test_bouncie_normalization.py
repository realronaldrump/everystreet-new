from __future__ import annotations

from datetime import datetime

from core.bouncie_normalization import normalize_rest_trip_payload


def test_normalize_rest_trip_payload_maps_timezone_and_metrics() -> None:
    normalized = normalize_rest_trip_payload(
        {
            "transactionId": "tx-1",
            "startTime": "2026-03-01T10:00:00Z",
            "endTime": "2026-03-01T11:00:00Z",
            "timeZone": "America/Chicago",
            "averageSpeed": 42.5,
            "hardBrakingCount": 2,
            "hardAccelerationCount": 3,
            "totalIdlingTime": 120,
            "gps": {
                "type": "LineString",
                "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
            },
        },
    )

    assert isinstance(normalized.get("startTime"), datetime)
    assert isinstance(normalized.get("endTime"), datetime)
    assert normalized.get("startTimeZone") == "America/Chicago"
    assert normalized.get("endTimeZone") == "America/Chicago"
    assert normalized.get("avgSpeed") == 42.5
    assert normalized.get("hardBrakingCounts") == 2
    assert normalized.get("hardAccelerationCounts") == 3
    assert normalized.get("totalIdleDuration") == 120.0

    assert "averageSpeed" not in normalized
    assert "hardBrakingCount" not in normalized
    assert "hardAccelerationCount" not in normalized
    assert "totalIdlingTime" not in normalized
    assert "timeZone" not in normalized
    assert "source" not in normalized
    assert "status" not in normalized


def test_normalize_rest_trip_payload_preserves_explicit_start_end_timezones() -> None:
    normalized = normalize_rest_trip_payload(
        {
            "transactionId": "tx-2",
            "timeZone": "UTC",
            "startTimeZone": "America/Denver",
            "endTimeZone": "America/Phoenix",
        },
    )

    assert normalized.get("startTimeZone") == "America/Denver"
    assert normalized.get("endTimeZone") == "America/Phoenix"
    assert "timeZone" not in normalized
