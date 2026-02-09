from __future__ import annotations

from datetime import UTC, datetime

import aiohttp
import pytest
from http_fakes import FakeResponse, FakeSession

from trips.services.trip_history_import_service import _fetch_trips_for_device_window_resilient


@pytest.mark.asyncio
async def test_fetch_trips_for_device_window_resilient_splits_on_500_and_dedupes() -> None:
    window_start = datetime(2020, 3, 1, 6, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 8, 6, 0, 0, tzinfo=UTC)

    # First call (full window) 500s, then fallback windows succeed but return
    # overlapping duplicates.
    trip = {
        "transactionId": "tx-1",
        "imei": "359486068397551",
        "startTime": "2020-03-02T00:00:00Z",
        "endTime": "2020-03-02T00:10:00Z",
        # Polyline that decodes to a tiny line (same as Valhalla tests).
        "gps": "__c`|@~bl_xD_ibE~hbE",
        "distance": 1.0,
        "hardBrakingCount": 0,
        "hardAccelerationCount": 0,
        "startOdometer": 0,
        "endOdometer": 1,
        "averageSpeed": 10,
        "maxSpeed": 15,
        "fuelConsumed": 0.1,
        "timeZone": "UTC",
        "totalIdleDuration": 0,
    }

    session = FakeSession(
        get_responses=[
            FakeResponse(status=500, text_data='{"message":"Response code 500"}'),
            # Fallback tier 1 will issue multiple requests; return duplicates.
            *[FakeResponse(status=200, json_data=[trip]) for _ in range(7)],
        ],
    )

    trips = await _fetch_trips_for_device_window_resilient(
        session,
        token="token",
        imei="359486068397551",
        window_start=window_start,
        window_end=window_end,
    )

    assert len(trips) == 1
    assert trips[0]["transactionId"] == "tx-1"

    # One failing request + 7 fallback requests.
    assert len(session.requests) == 8
    assert all(req[2]["params"]["gps-format"] == "polyline" for req in session.requests)


@pytest.mark.asyncio
async def test_fetch_trips_for_device_window_resilient_raises_non_500() -> None:
    window_start = datetime(2020, 3, 1, 6, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 8, 6, 0, 0, tzinfo=UTC)

    session = FakeSession(
        get_responses=[FakeResponse(status=401, text_data="unauthorized")],
    )

    with pytest.raises(aiohttp.ClientResponseError):
        await _fetch_trips_for_device_window_resilient(
            session,
            token="token",
            imei="359486068397551",
            window_start=window_start,
            window_end=window_end,
        )

