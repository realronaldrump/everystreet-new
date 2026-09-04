from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from db.models import Trip
from tracking.services import tracking_service


def _complete_trip_metrics(
    *,
    timestamp: str,
    distance: float,
    duration: float,
    idle: float = 0.0,
    max_speed: float = 65.0,
    avg_speed: float = 30.0,
    braking: int = 0,
    acceleration: int = 0,
) -> dict[str, object]:
    return {
        "timestamp": timestamp,
        "tripDistance": distance,
        "tripTime": duration,
        "totalIdlingTime": idle,
        "maxSpeed": max_speed,
        "averageDriveSpeed": avg_speed,
        "hardBrakingCounts": braking,
        "hardAccelerationCounts": acceleration,
    }


@pytest.fixture
def live_store_state(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    monkeypatch.setattr(
        tracking_service, "enqueue_completed_trip_sync", AsyncMock(return_value=True)
    )
    state: dict[str, object] = {
        "snapshots": {},
        "active_tx": None,
        "closed": set(),
        "clear_calls": [],
    }

    async def save_trip_snapshot(trip: dict[str, object]) -> None:
        tx = str(trip.get("transactionId") or "").strip()
        if not tx:
            return
        snapshots = state["snapshots"]
        assert isinstance(snapshots, dict)
        snapshots[tx] = dict(trip)
        state["active_tx"] = tx

    async def get_trip_snapshot(transaction_id: str) -> dict[str, object] | None:
        snapshots = state["snapshots"]
        assert isinstance(snapshots, dict)
        trip = snapshots.get(transaction_id)
        return dict(trip) if isinstance(trip, dict) else None

    async def get_active_trip_snapshot() -> dict[str, object] | None:
        tx = state.get("active_tx")
        if not isinstance(tx, str) or not tx:
            return None
        snapshots = state["snapshots"]
        assert isinstance(snapshots, dict)
        trip = snapshots.get(tx)
        return dict(trip) if isinstance(trip, dict) else None

    async def clear_trip_snapshot(
        transaction_id: str,
        *,
        mark_closed: bool = False,
    ) -> None:
        snapshots = state["snapshots"]
        assert isinstance(snapshots, dict)
        snapshots.pop(transaction_id, None)
        if state.get("active_tx") == transaction_id:
            state["active_tx"] = None
        clear_calls = state["clear_calls"]
        assert isinstance(clear_calls, list)
        clear_calls.append((transaction_id, mark_closed))
        if mark_closed:
            closed = state["closed"]
            assert isinstance(closed, set)
            closed.add(transaction_id)

    async def is_trip_marked_closed(transaction_id: str) -> bool:
        closed = state["closed"]
        assert isinstance(closed, set)
        return transaction_id in closed

    monkeypatch.setattr(tracking_service, "save_trip_snapshot", save_trip_snapshot)
    monkeypatch.setattr(tracking_service, "get_trip_snapshot", get_trip_snapshot)
    monkeypatch.setattr(
        tracking_service,
        "get_active_trip_snapshot",
        get_active_trip_snapshot,
    )
    monkeypatch.setattr(tracking_service, "clear_trip_snapshot", clear_trip_snapshot)
    monkeypatch.setattr(
        tracking_service,
        "is_trip_marked_closed",
        is_trip_marked_closed,
    )
    monkeypatch.setattr(tracking_service, "live_trip_is_stale", lambda _trip: False)

    return state


@pytest.mark.asyncio
async def test_live_trip_lifecycle_is_ephemeral_and_never_persists(
    live_store_state: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del live_store_state

    publish_mock = AsyncMock()
    monkeypatch.setattr(tracking_service, "publish_trip_state", publish_mock)

    trip_find = MagicMock()
    trip_find_one = AsyncMock()
    monkeypatch.setattr(Trip, "find", trip_find)
    monkeypatch.setattr(Trip, "find_one", trip_find_one)

    await tracking_service.process_trip_start(
        {
            "eventType": "tripStart",
            "transactionId": "tx-live-1",
            "vin": "VIN-1",
            "imei": "imei-1",
            "start": {
                "timestamp": "2026-02-21T12:00:00Z",
                "timeZone": "UTC",
                "odometer": 1234.5,
            },
        },
    )
    await tracking_service.process_trip_data(
        {
            "eventType": "tripData",
            "transactionId": "tx-live-1",
            "data": [
                {
                    "timestamp": "2026-02-21T12:01:00Z",
                    "gps": {"lat": 32.0, "lon": -97.0},
                    "speed": 12.0,
                },
                {
                    "timestamp": "2026-02-21T12:02:00Z",
                    "gps": {"lat": 32.01, "lon": -97.01},
                    "speed": 20.0,
                },
            ],
        },
    )
    await tracking_service.process_trip_end(
        {
            "eventType": "tripEnd",
            "transactionId": "tx-live-1",
            "end": {
                "timestamp": "2026-02-21T12:03:00Z",
                "timeZone": "UTC",
                "odometer": 1235.0,
                "fuelConsumed": 0.2,
            },
        },
    )

    assert await tracking_service.get_active_trip() is None

    statuses = [call.kwargs.get("status") for call in publish_mock.await_args_list]
    assert statuses[-1] == "completed"

    trip_find.assert_not_called()
    trip_find_one.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_active_trip_auto_completes_stale_state(
    live_store_state: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshots = live_store_state["snapshots"]
    assert isinstance(snapshots, dict)
    snapshots["tx-stale-1"] = {
        "transactionId": "tx-stale-1",
        "status": "active",
        "startTime": datetime(2026, 2, 21, 10, 0, tzinfo=UTC),
        "lastUpdate": datetime(2026, 2, 21, 10, 15, tzinfo=UTC),
        "coordinates": [
            {
                "timestamp": datetime(2026, 2, 21, 10, 5, tzinfo=UTC),
                "lat": 32.1,
                "lon": -97.1,
            },
            {
                "timestamp": datetime(2026, 2, 21, 10, 10, tzinfo=UTC),
                "lat": 32.2,
                "lon": -97.2,
            },
        ],
    }
    live_store_state["active_tx"] = "tx-stale-1"

    publish_mock = AsyncMock()
    monkeypatch.setattr(tracking_service, "publish_trip_state", publish_mock)
    monkeypatch.setattr(tracking_service, "live_trip_is_stale", lambda _trip: True)

    result = await tracking_service.get_active_trip()
    assert result is None

    clear_calls = live_store_state["clear_calls"]
    assert isinstance(clear_calls, list)
    assert clear_calls[-1] == ("tx-stale-1", True)

    statuses = [call.kwargs.get("status") for call in publish_mock.await_args_list]
    assert statuses == ["completed"]

    await tracking_service.process_trip_data(
        {
            "eventType": "tripData",
            "transactionId": "tx-stale-1",
            "data": [
                {
                    "timestamp": "2026-02-21T10:16:00Z",
                    "gps": {"lat": 32.3, "lon": -97.3},
                    "speed": 18.0,
                },
            ],
        },
    )

    snapshots = live_store_state["snapshots"]
    assert isinstance(snapshots, dict)
    assert "tx-stale-1" not in snapshots


@pytest.mark.asyncio
async def test_trip_end_without_snapshot_marks_trip_closed_and_blocks_late_trip_data(
    live_store_state: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    publish_mock = AsyncMock()
    monkeypatch.setattr(tracking_service, "publish_trip_state", publish_mock)

    await tracking_service.process_trip_end(
        {
            "eventType": "tripEnd",
            "transactionId": "tx-late-1",
            "end": {
                "timestamp": "2026-02-21T12:03:00Z",
                "timeZone": "UTC",
                "odometer": 1235.0,
                "fuelConsumed": 0.2,
            },
        },
    )

    clear_calls = live_store_state["clear_calls"]
    assert isinstance(clear_calls, list)
    assert clear_calls == [("tx-late-1", True)]

    await tracking_service.process_trip_data(
        {
            "eventType": "tripData",
            "transactionId": "tx-late-1",
            "data": [
                {
                    "timestamp": "2026-02-21T12:04:00Z",
                    "gps": {"lat": 32.0, "lon": -97.0},
                    "speed": 20.0,
                },
            ],
        },
    )

    snapshots = live_store_state["snapshots"]
    assert isinstance(snapshots, dict)
    assert "tx-late-1" not in snapshots
    publish_mock.assert_not_awaited()


def test_calculate_trip_metrics_includes_provider_point_speed_in_maximum() -> None:
    start = datetime(2026, 2, 21, 12, 0, tzinfo=UTC)
    metrics = tracking_service._calculate_trip_metrics(
        [
            {"timestamp": start, "lat": 32.0, "lon": -97.0, "speed": 60.0},
            {
                "timestamp": start + timedelta(minutes=1),
                "lat": 32.001,
                "lon": -97.001,
                "speed": 20.0,
            },
        ],
        start,
    )

    assert metrics["maxSpeed"] == pytest.approx(60.0)


@pytest.mark.asyncio
async def test_trip_metrics_ignores_older_provider_snapshot(
    live_store_state: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshots = live_store_state["snapshots"]
    assert isinstance(snapshots, dict)
    snapshots["tx-metrics-order"] = tracking_service._new_live_trip_snapshot(
        "tx-metrics-order",
        vin="VIN-1",
        imei="imei-1",
        start_time=datetime(2026, 2, 21, 12, 0, tzinfo=UTC),
    )
    live_store_state["active_tx"] = "tx-metrics-order"
    monkeypatch.setattr(tracking_service, "publish_trip_state", AsyncMock())

    await tracking_service.process_trip_metrics(
        {
            "transactionId": "tx-metrics-order",
            "metrics": _complete_trip_metrics(
                timestamp="2026-02-21T12:10:00Z",
                distance=10.0,
                duration=600.0,
            ),
        },
    )
    await tracking_service.process_trip_metrics(
        {
            "transactionId": "tx-metrics-order",
            "metrics": _complete_trip_metrics(
                timestamp="2026-02-21T12:05:00Z",
                distance=8.0,
                duration=300.0,
            ),
        },
    )

    saved = snapshots["tx-metrics-order"]
    assert saved["distance"] == pytest.approx(10.0)
    assert saved["duration"] == pytest.approx(600.0)
    assert saved["providerMetricsTimestamp"] == datetime(
        2026, 2, 21, 12, 10, tzinfo=UTC
    )


@pytest.mark.asyncio
async def test_trip_data_does_not_add_gps_delta_to_provider_metrics(
    live_store_state: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start = datetime(2026, 2, 21, 12, 0, tzinfo=UTC)
    snapshots = live_store_state["snapshots"]
    assert isinstance(snapshots, dict)
    snapshots["tx-metric-basis"] = {
        **tracking_service._new_live_trip_snapshot(
            "tx-metric-basis",
            vin="VIN-1",
            imei="imei-1",
            start_time=start,
        ),
        "coordinates": [
            {"timestamp": start, "lat": 32.0, "lon": -97.0},
            {
                "timestamp": start + timedelta(minutes=1),
                "lat": 32.001,
                "lon": -97.001,
            },
        ],
        "pointsRecorded": 2,
        "distance": 100.0,
        "maxSpeed": 65.0,
        "metricsSource": "provider",
        "providerMetricsTimestamp": start + timedelta(minutes=1),
        "lastUpdate": start + timedelta(minutes=1),
    }
    live_store_state["active_tx"] = "tx-metric-basis"
    monkeypatch.setattr(tracking_service, "publish_trip_state", AsyncMock())

    await tracking_service.process_trip_data(
        {
            "transactionId": "tx-metric-basis",
            "data": [
                {
                    "timestamp": "2026-02-21T12:02:00Z",
                    "gps": {"lat": 32.002, "lon": -97.002},
                    "speed": 25.0,
                },
            ],
        },
    )

    saved = snapshots["tx-metric-basis"]
    assert saved["metricsSource"] == "provider"
    assert saved["pointsRecorded"] == 3
    assert saved["distance"] == pytest.approx(100.0)
    assert saved["maxSpeed"] == pytest.approx(65.0)
    assert saved["currentSpeed"] == pytest.approx(25.0)


@pytest.mark.asyncio
async def test_provider_snapshot_replaces_gps_estimates_without_mixing_bases(
    live_store_state: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshots = live_store_state["snapshots"]
    assert isinstance(snapshots, dict)
    snapshots["tx-provider-switch"] = {
        **tracking_service._new_live_trip_snapshot(
            "tx-provider-switch",
            vin="VIN-1",
            imei="imei-1",
            start_time=datetime(2026, 2, 21, 12, 0, tzinfo=UTC),
        ),
        "distance": 10.0,
        "duration": 600.0,
        "maxSpeed": 500.0,
    }
    live_store_state["active_tx"] = "tx-provider-switch"
    monkeypatch.setattr(tracking_service, "publish_trip_state", AsyncMock())

    await tracking_service.process_trip_metrics(
        {
            "transactionId": "tx-provider-switch",
            "metrics": _complete_trip_metrics(
                timestamp="2026-02-21T12:05:00Z",
                distance=8.0,
                duration=300.0,
                idle=12.0,
                max_speed=65.0,
                avg_speed=24.0,
                braking=2,
                acceleration=1,
            ),
        },
    )

    saved = snapshots["tx-provider-switch"]
    assert saved["metricsSource"] == "provider"
    assert saved["distance"] == pytest.approx(8.0)
    assert saved["duration"] == pytest.approx(300.0)
    assert saved["totalIdleDuration"] == pytest.approx(12.0)
    assert saved["maxSpeed"] == pytest.approx(65.0)
    assert saved["avgSpeed"] == pytest.approx(24.0)
    assert saved["hardBrakingCounts"] == 2
    assert saved["hardAccelerationCounts"] == 1
