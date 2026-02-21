from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from db.models import Trip
from trips.services import (
    trip_batch_service,
    trip_history_import_service_runtime as import_runtime,
)
from trips.services.geocoding import TripGeocoder
from trips.services.trip_batch_service import TripService


class _SettingsStub:
    def __init__(self, geocode_on_fetch: bool) -> None:
        self._geocode_on_fetch = geocode_on_fetch

    def model_dump(self) -> dict[str, Any]:
        return {"geocodeTripsOnFetch": self._geocode_on_fetch}


class _PipelineStub:
    def __init__(self) -> None:
        self.process_calls: list[dict[str, Any]] = []

    async def validate_raw_trip_with_basic(self, _trip: dict[str, Any]) -> dict[str, Any]:
        return {"success": True}

    async def process_raw_trip(
        self,
        trip: dict[str, Any],
        *,
        source: str,
        do_map_match: bool,
        do_geocode: bool,
        do_coverage: bool,
    ) -> Any:
        self.process_calls.append(
            {
                "transactionId": trip.get("transactionId"),
                "source": source,
                "do_map_match": do_map_match,
                "do_geocode": do_geocode,
                "do_coverage": do_coverage,
            },
        )
        return SimpleNamespace(id="saved-id")


@pytest.mark.asyncio
async def test_process_bouncie_trips_reprocesses_existing_unknown_locations(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    existing = Trip(
        transactionId="tx-existing",
        status="processed",
        processing_state="completed",
        startTime=datetime(2025, 1, 1, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 12, 30, tzinfo=UTC),
        gps={
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
        startLocation="Unknown",
        destination="Unknown",
    )
    await existing.insert()

    async def fake_get_settings() -> _SettingsStub:
        return _SettingsStub(geocode_on_fetch=True)

    monkeypatch.setattr(
        trip_batch_service.AdminService,
        "get_persisted_app_settings",
        fake_get_settings,
    )

    service = TripService()
    pipeline_stub = _PipelineStub()
    service._pipeline = pipeline_stub

    incoming = {
        "transactionId": "tx-existing",
        "imei": "imei-1",
        "startTime": "2025-01-01T12:00:00Z",
        "endTime": "2025-01-01T12:30:00Z",
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
    }

    processed_ids = await service.process_bouncie_trips([incoming], do_map_match=False)

    assert processed_ids == ["tx-existing"]
    assert len(pipeline_stub.process_calls) == 1
    assert pipeline_stub.process_calls[0]["do_geocode"] is True


@pytest.mark.asyncio
async def test_process_bouncie_trips_reconciles_existing_non_bouncie_source(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    existing = Trip(
        transactionId="tx-webhook-existing",
        source="webhook",
        status="processed",
        processing_state="completed",
        startTime=datetime(2025, 1, 1, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 12, 30, tzinfo=UTC),
        gps={
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
        startLocation={"formatted_address": "Start"},
        destination={"formatted_address": "End"},
    )
    await existing.insert()

    async def fake_get_settings() -> _SettingsStub:
        return _SettingsStub(geocode_on_fetch=False)

    monkeypatch.setattr(
        trip_batch_service.AdminService,
        "get_persisted_app_settings",
        fake_get_settings,
    )

    service = TripService()
    pipeline_stub = _PipelineStub()
    service._pipeline = pipeline_stub

    incoming = {
        "transactionId": "tx-webhook-existing",
        "imei": "imei-1",
        "startTime": "2025-01-01T12:00:00Z",
        "endTime": "2025-01-01T12:30:00Z",
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
    }

    processed_ids = await service.process_bouncie_trips([incoming], do_map_match=False)

    assert processed_ids == ["tx-webhook-existing"]
    assert len(pipeline_stub.process_calls) == 1
    assert pipeline_stub.process_calls[0]["source"] == "bouncie"


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

    async def fake_get_settings() -> Any:
        return SimpleNamespace(geocodeTripsOnFetch=geocode_on_fetch)

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
    monkeypatch.setattr(
        import_runtime.AdminService,
        "get_persisted_app_settings",
        fake_get_settings,
    )
    monkeypatch.setattr(import_runtime, "_authenticate_import", fake_authenticate_import)
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

        async def reverse_geocode(self, _lat: float, _lon: float) -> dict[str, Any]:
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

        def parse_geocode_response(
            self,
            response: dict[str, Any],
            coordinates: list[float],
        ) -> dict[str, Any]:
            return {
                "formatted_address": response.get("display_name", ""),
                "address_components": {},
                "coordinates": {"lat": coordinates[1], "lng": coordinates[0]},
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

    geocoder = TripGeocoder(geocoding_service=_GeocodingServiceStub())
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
