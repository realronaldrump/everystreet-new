from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from db.models import Trip
from tracking.services import tracking_service


@pytest.fixture
def live_store_state(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
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


@pytest.mark.asyncio
async def test_trip_end_without_snapshot_marks_closed_and_ignores_late_events(
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
    assert clear_calls[-1] == ("tx-late-1", True)

    closed = live_store_state["closed"]
    assert isinstance(closed, set)
    assert "tx-late-1" in closed

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
