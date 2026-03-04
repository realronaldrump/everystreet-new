from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from unittest.mock import AsyncMock

from trips.services import trip_history_import_service_core as import_runtime
from trips.services.geocoding import TripGeocoder


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
        first_result["startLocation"]["formatted_address"]
        == "First St, Test City, TX"
    )
    assert (
        second_result["startLocation"]["formatted_address"]
        == "Second St, Test City, TX"
    )
    assert get_geocoder_mock.await_count == 2
