from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from db.models import Trip
from trips.services import bouncie_ingest_runtime
from trips.services.bouncie_ingest_runtime import process_bouncie_trips


class _PipelineStub:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def validate_raw_trip_with_basic(
        self,
        trip: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "success": True,
            "processed_data": dict(trip),
            "processing_status": {
                "history": [],
                "state": "validated",
                "errors": {},
            },
        }

    async def process_raw_trip(
        self,
        trip: dict[str, Any],
        *,
        source: str,
        do_map_match: bool,
        do_geocode: bool,
        do_coverage: bool,
        prevalidated_data: dict[str, Any] | None = None,
        prevalidated_history: list[dict[str, Any]] | None = None,
        prevalidated_state: str | None = None,
        sync_mobility: bool = True,
    ) -> Any:
        del (
            prevalidated_data,
            prevalidated_history,
            prevalidated_state,
            sync_mobility,
        )
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
async def test_process_bouncie_trips_insert_only_skips_existing_bouncie(
    beanie_db,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-existing",
        source="bouncie",
        status="processed",
        processing_state="completed",
        startTime=datetime(2025, 1, 1, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 12, 30, tzinfo=UTC),
    ).insert()

    pipeline = _PipelineStub()
    result = await process_bouncie_trips(
        [
            {
                "transactionId": "tx-existing",
                "imei": "imei-1",
                "startTime": "2025-01-01T12:00:00Z",
                "endTime": "2025-01-01T12:30:00Z",
            },
        ],
        pipeline=pipeline,
        mode="insert_only",
        do_map_match=False,
        do_geocode=False,
        do_coverage=False,
        sync_mobility=False,
    )

    assert result["processed_transaction_ids"] == []
    assert result["counters"]["skipped_existing"] == 1
    assert pipeline.calls == []


@pytest.mark.asyncio
async def test_process_bouncie_trips_upsert_reprocesses_when_match_missing(
    beanie_db,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-reprocess",
        source="bouncie",
        status="processed",
        processing_state="completed",
        matchedGps=None,
        startTime=datetime(2025, 1, 2, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 2, 12, 30, tzinfo=UTC),
    ).insert()

    pipeline = _PipelineStub()
    result = await process_bouncie_trips(
        [
            {
                "transactionId": "tx-reprocess",
                "imei": "imei-1",
                "startTime": "2025-01-02T12:00:00Z",
                "endTime": "2025-01-02T12:30:00Z",
            },
        ],
        pipeline=pipeline,
        mode="upsert_bouncie",
        do_map_match=True,
        do_geocode=False,
        do_coverage=False,
        sync_mobility=False,
    )

    assert result["processed_transaction_ids"] == ["tx-reprocess"]
    assert result["counters"]["updated"] == 1
    assert len(pipeline.calls) == 1


@pytest.mark.asyncio
async def test_process_bouncie_trips_upsert_reprocesses_for_geocode_repair(
    beanie_db,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-geocode-repair",
        source="bouncie",
        status="processed",
        processing_state="completed",
        startLocation="Unknown",
        destination="Unknown",
        startTime=datetime(2025, 1, 2, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 2, 12, 30, tzinfo=UTC),
    ).insert()

    pipeline = _PipelineStub()
    result = await process_bouncie_trips(
        [
            {
                "transactionId": "tx-geocode-repair",
                "imei": "imei-1",
                "startTime": "2025-01-02T12:00:00Z",
                "endTime": "2025-01-02T12:30:00Z",
            },
        ],
        pipeline=pipeline,
        mode="upsert_bouncie",
        do_map_match=False,
        do_geocode=True,
        do_coverage=False,
        sync_mobility=False,
    )

    assert result["processed_transaction_ids"] == ["tx-geocode-repair"]
    assert result["counters"]["updated"] == 1
    assert len(pipeline.calls) == 1
    assert pipeline.calls[0]["do_geocode"] is True


@pytest.mark.asyncio
async def test_process_bouncie_trips_skips_conflicting_non_bouncie_source(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-conflict",
        source="webhook",
        status="processed",
        processing_state="completed",
        startTime=datetime(2025, 1, 3, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 3, 12, 30, tzinfo=UTC),
    ).insert()

    recorded_issues: list[dict[str, Any]] = []

    async def fake_record_issue(**kwargs: Any) -> None:
        recorded_issues.append(kwargs)

    monkeypatch.setattr(
        bouncie_ingest_runtime.TripIngestIssueService,
        "record_issue",
        fake_record_issue,
    )

    pipeline = _PipelineStub()
    result = await process_bouncie_trips(
        [
            {
                "transactionId": "tx-conflict",
                "imei": "imei-1",
                "startTime": "2025-01-03T12:00:00Z",
                "endTime": "2025-01-03T12:30:00Z",
            },
        ],
        pipeline=pipeline,
        mode="upsert_bouncie",
        do_map_match=False,
        do_geocode=False,
        do_coverage=False,
        sync_mobility=False,
    )

    assert result["processed_transaction_ids"] == []
    assert result["counters"]["skipped_conflicting_source"] == 1
    assert pipeline.calls == []
    assert len(recorded_issues) == 1
    assert recorded_issues[0]["issue_type"] == "conflicting_existing_source"
