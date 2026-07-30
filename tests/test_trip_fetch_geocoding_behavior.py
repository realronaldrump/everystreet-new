from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from trips.services import trip_history_import_service_core as import_runtime
from trips.services.geocoding import TripGeocoder
from trips.services.trip_batch_service import TripService


@pytest.mark.asyncio
@pytest.mark.parametrize("geocode_on_fetch", [True, False])
async def test_history_import_runtime_uses_geocode_setting(
    monkeypatch: pytest.MonkeyPatch,
    geocode_on_fetch: bool,
) -> None:
    captured: dict[str, Any] = {}

    setup = import_runtime.ImportSetup(
        credentials={},
        imeis=["imei-1"],
        devices=[{"imei": "imei-1", "name": "Device"}],
        windows=[],
        windows_total=0,
        fetch_concurrency=1,
        counters={},
        per_device={},
    )

    class _ProgressStub:
        def __init__(self) -> None:
            self.handle = None
            self.counters: dict[str, Any] = {}
            self.failure_reasons: dict[str, int] = {}
            self.start_dt = datetime(2025, 1, 1, tzinfo=UTC)
            self.end_dt = datetime(2025, 1, 2, tzinfo=UTC)

        def add_event(self, *_args: Any, **_kwargs: Any) -> None:
            return

        def record_failure_reason(self, _reason: str | None) -> None:
            return

        async def write_progress(self, **_kwargs: Any) -> None:
            return

        async def is_cancelled(self, *, force: bool = False) -> bool:
            del force
            return False

    async def fake_build_setup(**_kwargs: Any) -> import_runtime.ImportSetup:
        return setup

    async def fake_build_progress_context(**_kwargs: Any) -> _ProgressStub:
        return _ProgressStub()

    async def fake_authenticate_import(**_kwargs: Any) -> str:
        return "token"

    async def fake_run_windows(*, runtime: Any, **_kwargs: Any) -> tuple[bool, int]:
        captured["do_geocode"] = runtime.do_geocode
        return True, 0

    async def fake_cancelled_progress(**_kwargs: Any) -> dict[str, str]:
        return {"status": "cancelled", "message": "Cancelled"}

    async def fake_get_session() -> Any:
        return object()

    monkeypatch.setattr(import_runtime, "_build_import_setup", fake_build_setup)
    monkeypatch.setattr(
        import_runtime,
        "_build_progress_context",
        fake_build_progress_context,
    )
    monkeypatch.setattr(import_runtime, "IMPORT_DO_GEOCODE", geocode_on_fetch)
    monkeypatch.setattr(
        import_runtime,
        "_authenticate_import",
        fake_authenticate_import,
    )
    monkeypatch.setattr(import_runtime, "_run_import_windows", fake_run_windows)
    monkeypatch.setattr(
        import_runtime,
        "_write_cancelled_progress",
        fake_cancelled_progress,
    )
    monkeypatch.setattr(import_runtime, "get_session", fake_get_session)

    result = await import_runtime.run_import(
        progress_job_id=None,
        start_dt=datetime(2025, 1, 1, tzinfo=UTC),
        end_dt=datetime(2025, 1, 2, tzinfo=UTC),
    )

    assert result["status"] == "cancelled"
    assert captured["do_geocode"] is geocode_on_fetch


@pytest.mark.asyncio
async def test_geocoding_progress_reports_only_after_trip_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = TripService()
    processing_started = asyncio.Event()
    allow_completion = asyncio.Event()
    progress: list[tuple[int, int, str]] = []
    trip = SimpleNamespace(
        source="bouncie",
        startLocation=None,
        destination=None,
        model_dump=lambda: {"transactionId": "tx-progress"},
    )

    async def fake_get_trip(_trip_id: str):
        return trip

    async def fake_process(*_args: Any, **_kwargs: Any):
        processing_started.set()
        await allow_completion.wait()
        return {"status": "success"}

    async def on_progress(current: int, total: int, trip_id: str) -> None:
        progress.append((current, total, trip_id))

    monkeypatch.setattr(service, "get_trip_by_id", fake_get_trip)
    monkeypatch.setattr(service, "process_single_trip", fake_process)

    task = asyncio.create_task(
        service.refresh_geocoding(
            ["tx-progress"],
            progress_callback=on_progress,
        )
    )
    await processing_started.wait()
    assert progress == []

    allow_completion.set()
    result = await task

    assert result["updated"] == 1
    assert progress == [(1, 1, "tx-progress")]


@pytest.mark.asyncio
async def test_cancelled_geocoding_trip_is_not_reported_as_finished(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = TripService()
    processing_started = asyncio.Event()
    progress: list[tuple[int, int, str]] = []
    trip = SimpleNamespace(
        source="bouncie",
        startLocation=None,
        destination=None,
        model_dump=lambda: {"transactionId": "tx-cancelled-progress"},
    )

    async def fake_process(*_args: Any, **_kwargs: Any) -> None:
        processing_started.set()
        await asyncio.Event().wait()

    async def on_progress(current: int, total: int, trip_id: str) -> None:
        progress.append((current, total, trip_id))

    monkeypatch.setattr(service, "get_trip_by_id", AsyncMock(return_value=trip))
    monkeypatch.setattr(service, "process_single_trip", fake_process)

    task = asyncio.create_task(
        service.refresh_geocoding(
            ["tx-cancelled-progress"],
            progress_callback=on_progress,
        )
    )
    await processing_started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert progress == []


@pytest.mark.asyncio
async def test_cancelled_waiting_import_window_is_not_counted_completed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancelled = False
    progress_updates: list[dict[str, Any]] = []

    async def is_cancelled(*, force: bool = False) -> bool:
        del force
        return cancelled

    async def fake_fetch(*_args: Any, **_kwargs: Any):
        nonlocal cancelled
        await asyncio.sleep(0)
        cancelled = True
        return SimpleNamespace(trips=[], failed_windows=[])

    async def fake_process(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "processed_transaction_ids": [],
            "counters": import_runtime.build_ingest_counters(),
        }

    async def write_progress(**kwargs: Any) -> None:
        progress_updates.append(kwargs)

    monkeypatch.setattr(import_runtime, "fetch_trips_for_window_runtime", fake_fetch)
    monkeypatch.setattr(import_runtime, "process_bouncie_trips_runtime", fake_process)

    runtime = import_runtime.ImportRuntime(
        client=object(),
        imeis=["imei-1"],
        windows_total=2,
        semaphore=asyncio.Semaphore(1),
        lock=asyncio.Lock(),
        counters=import_runtime.build_ingest_counters(),
        per_device={"imei-1": import_runtime.build_ingest_device_counters()},
        pipeline=SimpleNamespace(),
        do_geocode=False,
        do_coverage=False,
        add_event=lambda *_args, **_kwargs: None,
        write_progress=write_progress,
        is_cancelled=is_cancelled,
        record_failure_reason=lambda _reason: None,
    )
    start = datetime(2025, 1, 1, tzinfo=UTC)

    was_cancelled, windows_completed = await import_runtime._run_import_windows(
        runtime=runtime,
        windows=[
            (start, start.replace(day=2)),
            (start.replace(day=2), start.replace(day=3)),
        ],
        progress_ctx=SimpleNamespace(is_cancelled=is_cancelled),
    )

    assert was_cancelled is True
    assert windows_completed == 1
    assert runtime.per_device["imei-1"]["windows_completed"] == 1
    assert len(progress_updates) == 1


@pytest.mark.asyncio
async def test_geocoder_handles_start_reverse_failure_without_skipping_destination(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _GeocodingServiceStub:
        def __init__(self) -> None:
            self.calls = 0

        async def reverse(self, _lat: float, _lon: float) -> dict[str, Any]:
            self.calls += 1
            if self.calls == 1:
                msg = "temporary failure"
                raise RuntimeError(msg)
            return {
                "display_name": "Destination St, Test City, TX",
                "address": {
                    "road": "Destination St",
                    "city": "Test City",
                    "state": "TX",
                    "postcode": "75000",
                    "country": "United States",
                },
            }

    async def fake_health() -> Any:
        return SimpleNamespace(nominatim_healthy=True)

    async def fake_place_lookup(_point: Any) -> None:
        return None

    monkeypatch.setattr(
        "trips.services.geocoding.GeoServiceHealth.get_or_create",
        fake_health,
    )
    monkeypatch.setattr(
        TripGeocoder,
        "get_place_at_point",
        staticmethod(fake_place_lookup),
    )

    geocoder = TripGeocoder(geocoder=_GeocodingServiceStub())
    payload = {
        "transactionId": "tx-geo-retry",
        "startLocation": "Unknown",
        "destination": "Unknown",
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
    }

    result = await geocoder.geocode(payload)

    assert result.get("startLocation") == "Unknown"
    assert isinstance(result.get("destination"), dict)
    assert result["destination"]["formatted_address"] == "Destination St, Test City, TX"
    assert result.get("geocoded_at") is not None


@pytest.mark.asyncio
async def test_trip_geocoder_re_resolves_provider_per_geocode_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Provider:
        def __init__(self, label: str) -> None:
            self.label = label

        async def reverse(self, _lat: float, _lon: float) -> dict[str, Any]:
            return {
                "display_name": f"{self.label} St, Test City, TX",
                "address": {
                    "road": f"{self.label} St",
                    "city": "Test City",
                    "state": "TX",
                    "postcode": "75000",
                    "country": "United States",
                },
            }

    async def fake_health() -> Any:
        return SimpleNamespace(nominatim_healthy=True)

    async def fake_place_lookup(_point: Any) -> None:
        return None

    get_geocoder_mock = AsyncMock(
        side_effect=[_Provider("First"), _Provider("Second")],
    )
    monkeypatch.setattr(
        "trips.services.geocoding.get_geocoder",
        get_geocoder_mock,
    )
    monkeypatch.setattr(
        "trips.services.geocoding.GeoServiceHealth.get_or_create",
        fake_health,
    )
    monkeypatch.setattr(
        TripGeocoder,
        "get_place_at_point",
        staticmethod(fake_place_lookup),
    )

    geocoder = TripGeocoder()

    payload_a = {
        "transactionId": "tx-geo-a",
        "startLocation": "Unknown",
        "destination": "Unknown",
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
    }
    payload_b = {
        "transactionId": "tx-geo-b",
        "startLocation": "Unknown",
        "destination": "Unknown",
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
    }

    first_result = await geocoder.geocode(payload_a)
    second_result = await geocoder.geocode(payload_b)

    assert (
        first_result["startLocation"]["formatted_address"] == "First St, Test City, TX"
    )
    assert (
        second_result["startLocation"]["formatted_address"]
        == "Second St, Test City, TX"
    )
    assert get_geocoder_mock.await_count == 2
