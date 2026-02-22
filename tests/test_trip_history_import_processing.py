from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from db.models import Trip
from trips.services.trip_history_import_service_processing import (
    _collect_new_trips,
    _load_existing_transaction_ids,
    _process_new_trips_batch,
)


@pytest.mark.asyncio
async def test_load_existing_transaction_ids_only_treats_bouncie_as_authoritative(
    beanie_db,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-bouncie",
        source="bouncie",
        startTime=datetime(2025, 1, 1, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 12, 30, tzinfo=UTC),
    ).insert()
    await Trip(
        transactionId="tx-webhook",
        source="webhook",
        startTime=datetime(2025, 1, 2, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 2, 12, 30, tzinfo=UTC),
    ).insert()

    unique_trips = [
        {
            "transactionId": "tx-bouncie",
            "imei": "imei-1",
            "endTime": "2025-01-01T12:30:00Z",
        },
        {
            "transactionId": "tx-webhook",
            "imei": "imei-1",
            "endTime": "2025-01-02T12:30:00Z",
        },
        {
            "transactionId": "tx-new",
            "imei": "imei-1",
            "endTime": "2025-01-03T12:30:00Z",
        },
    ]

    existing_ids = await _load_existing_transaction_ids(unique_trips)
    assert existing_ids == {"tx-bouncie"}

    counters = {"skipped_existing": 0, "new_candidates": 0}
    per_device = {
        "imei-1": {"skipped_existing": 0, "new_candidates": 0},
    }
    new_trips = _collect_new_trips(
        unique_trips=unique_trips,
        existing_ids=existing_ids,
        counters=counters,
        per_device=per_device,
    )
    assert [t["transactionId"] for t in new_trips] == ["tx-webhook", "tx-new"]


class _PipelineStub:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def validate_raw_trip_with_basic(
        self,
        _trip: dict[str, Any],
    ) -> dict[str, Any]:
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
        self.calls.append(
            {
                "transactionId": trip.get("transactionId"),
                "source": source,
                "do_map_match": do_map_match,
                "do_geocode": do_geocode,
                "do_coverage": do_coverage,
            },
        )
        return SimpleNamespace(id="trip-id")


@pytest.mark.asyncio
async def test_process_new_trips_batch_uses_reconciliation_path() -> None:
    pipeline = _PipelineStub()
    counters = {
        "inserted": 0,
        "skipped_existing": 0,
        "validation_failed": 0,
        "process_errors": 0,
    }
    per_device = {
        "imei-1": {
            "inserted": 0,
            "skipped_existing": 0,
            "validation_failed": 0,
            "errors": 0,
        },
    }

    async def _write_progress(**_kwargs: Any) -> None:
        return

    async def _is_cancelled() -> bool:
        return False

    runtime = SimpleNamespace(
        pipeline=pipeline,
        counters=counters,
        per_device=per_device,
        windows_total=1,
        do_geocode=False,
        do_coverage=False,
        add_event=lambda *_args, **_kwargs: None,
        record_failure_reason=lambda _reason: None,
        write_progress=_write_progress,
        is_cancelled=_is_cancelled,
    )

    cancelled = await _process_new_trips_batch(
        runtime=runtime,
        new_trips=[
            {
                "transactionId": "tx-reconcile-1",
                "imei": "imei-1",
                "endTime": "2025-01-01T12:30:00Z",
            },
        ],
        window_index=1,
        windows_completed=0,
        current_window={},
    )

    assert cancelled is False
    assert len(pipeline.calls) == 1
    assert pipeline.calls[0]["transactionId"] == "tx-reconcile-1"
    assert pipeline.calls[0]["source"] == "bouncie"
    assert counters["inserted"] == 1
