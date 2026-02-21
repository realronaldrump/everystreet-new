from __future__ import annotations

from datetime import UTC, datetime

import pytest

from analytics.services.trip_analytics_service import TripAnalyticsService
from db.models import Trip
from trips.services.trip_query_service import TripQueryService


@pytest.mark.asyncio
async def test_invalid_trip_query_excludes_non_bouncie_sources(beanie_db) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-invalid-bouncie",
        source="bouncie",
        invalid=True,
        validated_at=datetime(2025, 1, 2, tzinfo=UTC),
        startTime=datetime(2025, 1, 2, 10, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 2, 10, 15, tzinfo=UTC),
    ).insert()
    await Trip(
        transactionId="tx-invalid-webhook",
        source="webhook",
        invalid=True,
        validated_at=datetime(2025, 1, 3, tzinfo=UTC),
        startTime=datetime(2025, 1, 3, 10, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 3, 10, 15, tzinfo=UTC),
    ).insert()

    payload = await TripQueryService.get_invalid_trips()
    ids = {trip["transaction_id"] for trip in payload["trips"]}

    assert "tx-invalid-bouncie" in ids
    assert "tx-invalid-webhook" not in ids


@pytest.mark.asyncio
async def test_recent_trip_analytics_excludes_non_bouncie_sources(beanie_db) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-recent-bouncie",
        source="bouncie",
        invalid=False,
        startTime=datetime(2025, 1, 4, 8, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 4, 8, 30, tzinfo=UTC),
        distance=3.2,
    ).insert()
    await Trip(
        transactionId="tx-recent-webhook",
        source="webhook",
        invalid=False,
        startTime=datetime(2025, 1, 5, 8, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 5, 8, 30, tzinfo=UTC),
        distance=9.1,
    ).insert()

    trips = await TripAnalyticsService.get_recent_trips(limit=10)
    ids = {trip.get("transactionId") for trip in trips}

    assert "tx-recent-bouncie" in ids
    assert "tx-recent-webhook" not in ids
