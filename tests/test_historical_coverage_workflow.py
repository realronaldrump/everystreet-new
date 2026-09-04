from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from db.models import Trip
from trips.pipeline import TripPipeline, TripProcessingRequest


@pytest.mark.asyncio
async def test_saved_trip_keeps_failed_coverage_pending_and_retries(
    beanie_db, monkeypatch
):
    from trips.services import coverage_processing

    monkeypatch.setattr(coverage_processing, "notify_coverage_updated", AsyncMock())
    coverage = AsyncMock(side_effect=[RuntimeError("temporary coverage outage"), 1])
    pipeline = TripPipeline(coverage_service=coverage)
    monkeypatch.setattr(pipeline, "_enqueue_geo_coverage_sync_for_ingest", AsyncMock())
    trip = await pipeline.process_trip(
        TripProcessingRequest.bouncie_ingest(
            {
                "transactionId": "coverage-retry",
                "startTime": "2026-09-01T12:00:00Z",
                "endTime": "2026-09-01T12:10:00Z",
                "gps": {
                    "type": "LineString",
                    "coordinates": [[-107.3, 39.5], [-107.2, 39.6]],
                },
            },
            do_map_match=False,
            do_geocode=False,
            do_coverage=True,
            sync_mobility=False,
            bump_revision=False,
        )
    )
    assert trip is not None
    saved = await Trip.get(trip.id)
    assert saved.coverage_status == "retry"
    assert saved.coverage_emitted_at is None
    assert saved.coverage_attempts == 1
    await saved.set(
        {"coverage_next_attempt_at": datetime.now(UTC) - timedelta(seconds=1)}
    )
    assert await coverage_processing.process_pending_trip_coverage(
        trip.id, coverage_service=coverage
    )
    saved = await Trip.get(trip.id)
    assert saved.coverage_status == "complete"
    assert saved.coverage_emitted_at is not None
    assert not await coverage_processing.process_pending_trip_coverage(
        trip.id, coverage_service=coverage
    )
    assert coverage.await_count == 2


@pytest.mark.asyncio
async def test_expired_lease_recovers_but_active_lease_cannot_run_twice(
    beanie_db, monkeypatch
):
    from trips.services import coverage_processing

    monkeypatch.setattr(coverage_processing, "notify_coverage_updated", AsyncMock())
    trip = Trip(
        transactionId="lease-recovery",
        coverage_status="running",
        coverage_lease_until=datetime.now(UTC) + timedelta(minutes=5),
        coverage_attempts=1,
    )
    await trip.insert()
    coverage = AsyncMock(return_value=1)
    assert not await coverage_processing.process_pending_trip_coverage(
        trip.id, coverage_service=coverage
    )
    await trip.set({"coverage_lease_until": datetime.now(UTC) - timedelta(seconds=1)})
    assert await coverage_processing.process_pending_trip_coverage(
        trip.id, coverage_service=coverage
    )
    coverage.assert_awaited_once()


@pytest.mark.asyncio
async def test_exhausted_coverage_retries_are_visible_and_bounded(beanie_db):
    from trips.services import coverage_processing

    trip = Trip(
        transactionId="exhausted",
        coverage_status="pending",
        coverage_attempts=coverage_processing.MAX_ATTEMPTS - 1,
    )
    await trip.insert()
    coverage = AsyncMock(side_effect=RuntimeError("still unavailable"))
    assert not await coverage_processing.process_pending_trip_coverage(
        trip.id, coverage_service=coverage
    )
    saved = await Trip.get(trip.id)
    assert saved.coverage_status == "failed"
    assert saved.coverage_error == "still unavailable"
    assert not await coverage_processing.process_pending_trip_coverage(
        trip.id, coverage_service=coverage
    )
    coverage.assert_awaited_once()
