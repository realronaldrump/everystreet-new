from __future__ import annotations

from datetime import datetime

import pytest

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


@pytest.mark.parametrize("empty", [None, ""])
def test_normalize_timezone_fills_empty_canonical_fields(empty: str | None) -> None:
    normalized = normalize_rest_trip_payload(
        {"timeZone": "-0700", "startTimeZone": empty, "endTimeZone": empty}
    )
    assert normalized["startTimeZone"] == "-0700"
    assert normalized["endTimeZone"] == "-0700"


def test_normalize_timezone_zero_offset_is_valid_utc() -> None:
    normalized = normalize_rest_trip_payload({"timeZone": "0000"})
    assert normalized["startTimeZone"] == "UTC"
    assert normalized["endTimeZone"] == "UTC"


def test_normalize_timezone_does_not_invent_missing_metadata() -> None:
    normalized = normalize_rest_trip_payload({"transactionId": "no-timezone"})
    assert normalized.get("startTimeZone") is None
    assert normalized.get("endTimeZone") is None


def test_normalize_rest_trip_payload_decodes_polyline_gps() -> None:
    normalized = normalize_rest_trip_payload(
        {
            "transactionId": "tx-polyline",
            "gps": "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
        },
    )

    assert normalized["gps"] == {
        "type": "LineString",
        "coordinates": [
            [-120.2, 38.5],
            [-120.95, 40.7],
            [-126.453, 43.252],
        ],
    }
