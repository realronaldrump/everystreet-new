from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from trips.services.trip_history_import_service import _fetch_trips_for_window


@pytest.mark.asyncio
async def test_fetch_trips_for_window_success() -> None:
    """Happy path: BouncieClient returns trips, they get normalized."""
    window_start = datetime(2020, 3, 1, 6, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 8, 6, 0, 0, tzinfo=UTC)

    raw_trip = {
        "transactionId": "tx-1",
        "imei": "359486068397551",
        "startTime": datetime(2020, 3, 2, 0, 0, 0, tzinfo=UTC),
        "endTime": datetime(2020, 3, 2, 0, 10, 0, tzinfo=UTC),
        "gps": {
            "type": "LineString",
            "coordinates": [[-73.9, 40.7], [-73.8, 40.8]],
        },
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

    mock_client = AsyncMock()
    mock_client.fetch_trips_for_device_resilient.return_value = [raw_trip]

    trips = await _fetch_trips_for_window(
        mock_client,
        token="token",
        imei="359486068397551",
        window_start=window_start,
        window_end=window_end,
        _split_chunk_hours=999,
    )

    assert len(trips) == 1
    assert trips[0]["transactionId"] == "tx-1"
    mock_client.fetch_trips_for_device_resilient.assert_awaited_once()


@pytest.mark.asyncio
async def test_fetch_trips_for_window_splits_on_failure() -> None:
    """When the full window fails, the function splits and retries sub-windows."""
    window_start = datetime(2020, 3, 1, 6, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 8, 6, 0, 0, tzinfo=UTC)

    raw_trip = {
        "transactionId": "tx-1",
        "imei": "359486068397551",
        "startTime": datetime(2020, 3, 2, 0, 0, 0, tzinfo=UTC),
        "endTime": datetime(2020, 3, 2, 0, 10, 0, tzinfo=UTC),
        "gps": {
            "type": "LineString",
            "coordinates": [[-73.9, 40.7], [-73.8, 40.8]],
        },
        "distance": 1.0,
    }

    call_count = 0

    async def mock_fetch(token, imei, start_dt, end_dt):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            # First call (full window) fails
            msg = "Server error"
            raise RuntimeError(msg)
        # Sub-window calls succeed
        return [raw_trip]

    mock_client = AsyncMock()
    mock_client.fetch_trips_for_device_resilient.side_effect = mock_fetch

    trips = await _fetch_trips_for_window(
        mock_client,
        token="token",
        imei="359486068397551",
        window_start=window_start,
        window_end=window_end,
        _split_chunk_hours=999,
    )

    # Should have split into 2 sub-windows and returned trips from both
    assert len(trips) == 2  # One trip per sub-window
    # Total calls: 1 (failed full) + 2 (sub-windows) = 3
    assert call_count == 3


@pytest.mark.asyncio
async def test_fetch_trips_for_window_uses_chunked_split() -> None:
    """A failed 7-day window can be split into fixed-size chunks."""
    window_start = datetime(2020, 3, 1, 6, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 8, 6, 0, 0, tzinfo=UTC)

    raw_trip = {
        "transactionId": "tx-1",
        "imei": "359486068397551",
        "startTime": datetime(2020, 3, 2, 0, 0, 0, tzinfo=UTC),
        "endTime": datetime(2020, 3, 2, 0, 10, 0, tzinfo=UTC),
        "gps": {
            "type": "LineString",
            "coordinates": [[-73.9, 40.7], [-73.8, 40.8]],
        },
        "distance": 1.0,
    }

    call_count = 0

    async def mock_fetch(token, imei, start_dt, end_dt):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            msg = "Server error"
            raise RuntimeError(msg)
        return [raw_trip]

    mock_client = AsyncMock()
    mock_client.fetch_trips_for_device_resilient.side_effect = mock_fetch

    trips = await _fetch_trips_for_window(
        mock_client,
        token="token",
        imei="359486068397551",
        window_start=window_start,
        window_end=window_end,
        _split_chunk_hours=12,
    )

    assert len(trips) == 14
    # 1 failed full-window call + 14 chunk calls
    assert call_count == 15


@pytest.mark.asyncio
async def test_fetch_trips_for_window_raises_for_small_window() -> None:
    """When the window is too small to split, the error propagates."""
    window_start = datetime(2020, 3, 1, 6, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 2, 0, 0, 0, tzinfo=UTC)  # 18 hours

    mock_client = AsyncMock()
    mock_client.fetch_trips_for_device_resilient.side_effect = RuntimeError(
        "Server error",
    )

    with pytest.raises(RuntimeError, match="Server error"):
        await _fetch_trips_for_window(
            mock_client,
            token="token",
            imei="359486068397551",
            window_start=window_start,
            window_end=window_end,
            _min_window_hours=24,
        )


@pytest.mark.asyncio
async def test_fetch_trips_for_window_can_split_below_24_hours() -> None:
    """A failing 18-hour window can recover by splitting below one day."""
    window_start = datetime(2020, 3, 1, 6, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 2, 0, 0, 0, tzinfo=UTC)  # 18 hours

    raw_trip = {
        "transactionId": "tx-1",
        "imei": "359486068397551",
        "startTime": datetime(2020, 3, 1, 12, 0, 0, tzinfo=UTC),
        "endTime": datetime(2020, 3, 1, 12, 10, 0, tzinfo=UTC),
        "gps": {
            "type": "LineString",
            "coordinates": [[-73.9, 40.7], [-73.8, 40.8]],
        },
        "distance": 1.0,
    }

    call_count = 0

    async def mock_fetch(token, imei, start_dt, end_dt):
        nonlocal call_count
        call_count += 1
        span_hours = (end_dt - start_dt).total_seconds() / 3600
        if span_hours > 12:
            msg = "Server error"
            raise RuntimeError(msg)
        return [raw_trip]

    mock_client = AsyncMock()
    mock_client.fetch_trips_for_device_resilient.side_effect = mock_fetch

    trips = await _fetch_trips_for_window(
        mock_client,
        token="token",
        imei="359486068397551",
        window_start=window_start,
        window_end=window_end,
        _min_window_hours=1,
        _split_chunk_hours=999,
    )

    assert len(trips) == 2
    assert call_count == 3


@pytest.mark.asyncio
async def test_fetch_trips_for_window_default_min_can_recover_hour() -> None:
    """Default minimum split (15m) can recover a failing 1-hour window."""
    window_start = datetime(2020, 3, 1, 0, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 1, 1, 0, 0, tzinfo=UTC)

    raw_trip = {
        "transactionId": "tx-1",
        "imei": "359486068397551",
        "startTime": datetime(2020, 3, 1, 0, 10, 0, tzinfo=UTC),
        "endTime": datetime(2020, 3, 1, 0, 12, 0, tzinfo=UTC),
        "gps": {
            "type": "LineString",
            "coordinates": [[-73.9, 40.7], [-73.8, 40.8]],
        },
        "distance": 1.0,
    }

    call_count = 0

    async def mock_fetch(token, imei, start_dt, end_dt):
        nonlocal call_count
        call_count += 1
        span_minutes = (end_dt - start_dt).total_seconds() / 60
        # _fetch_trips_for_window shifts starts-after back by 1 second.
        if span_minutes > 15.1:
            msg = "Server error"
            raise RuntimeError(msg)
        return [raw_trip]

    mock_client = AsyncMock()
    mock_client.fetch_trips_for_device_resilient.side_effect = mock_fetch

    trips = await _fetch_trips_for_window(
        mock_client,
        token="token",
        imei="359486068397551",
        window_start=window_start,
        window_end=window_end,
        _split_chunk_hours=999,
    )

    # 1 initial call + 2 half-window retries + 4 quarter-window successes
    assert call_count == 7
    assert len(trips) == 4
