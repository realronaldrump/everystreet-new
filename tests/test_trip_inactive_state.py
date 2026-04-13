from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import BackgroundTasks

from db.models import Trip
from trips.api.crud import set_trip_inactive
from trips.models import TripInactiveUpdate
from trips.services.inactive_trip_service import InactiveTripService
from trips.services.trip_query_service import TripQueryService


@pytest.mark.asyncio
async def test_trips_datatable_includes_inactive_records(beanie_db) -> None:
    await Trip(
        transactionId="active-trip",
        source="bouncie",
        startTime=datetime(2025, 1, 1, 8, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 9, tzinfo=UTC),
        distance=12.5,
        duration=3600,
    ).insert()
    await Trip(
        transactionId="inactive-trip",
        source="bouncie",
        startTime=datetime(2025, 1, 2, 8, tzinfo=UTC),
        endTime=datetime(2025, 1, 2, 9, tzinfo=UTC),
        distance=900.0,
        duration=3600,
        inactive=True,
    ).insert()

    response = await TripQueryService.get_trips_datatable(
        draw=1,
        start=0,
        length=10,
        search_value="",
        order=[],
        columns=[],
        filters={},
        start_date=None,
        end_date=None,
        price_map={},
    )

    ids = {row["transactionId"] for row in response["data"]}
    assert ids == {"active-trip", "inactive-trip"}
    inactive_row = next(
        row for row in response["data"] if row["transactionId"] == "inactive-trip"
    )
    assert inactive_row["inactive"] is True


@pytest.mark.asyncio
async def test_set_trip_inactive_updates_trip_and_queues_refreshes(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    trip = Trip(
        transactionId="trip-to-disable",
        source="bouncie",
        startTime=datetime(2025, 1, 3, 8, tzinfo=UTC),
        endTime=datetime(2025, 1, 3, 9, tzinfo=UTC),
        distance=15.0,
        duration=3600,
        mobility_synced_at=datetime(2025, 1, 4, tzinfo=UTC),
    )
    await trip.insert()

    sync_mobility = AsyncMock()
    queue_routes = AsyncMock(return_value={"status": "queued", "job_id": "routes-job"})
    queue_geo = AsyncMock(return_value={"status": "queued", "job_id": "geo-job"})
    queue_coverage = AsyncMock(
        return_value={"queued": 1, "skipped": 0, "job_ids": ["coverage-job"]}
    )

    monkeypatch.setattr(InactiveTripService, "sync_mobility_profile", sync_mobility)
    monkeypatch.setattr(
        InactiveTripService,
        "queue_recurring_routes_refresh",
        queue_routes,
    )
    monkeypatch.setattr(
        InactiveTripService,
        "queue_geo_coverage_refresh",
        queue_geo,
    )
    monkeypatch.setattr(
        InactiveTripService,
        "queue_coverage_reprocessing_for_trip",
        queue_coverage,
    )

    response = await set_trip_inactive(
        "trip-to-disable",
        TripInactiveUpdate(inactive=True),
        BackgroundTasks(),
    )

    refreshed = await Trip.find_one(Trip.transactionId == "trip-to-disable")
    assert refreshed is not None
    assert refreshed.inactive is True
    assert refreshed.inactive_at is not None
    assert refreshed.mobility_synced_at is None
    assert response["changed"] is True
    assert response["trip"]["inactive"] is True
    assert response["refresh"]["recurring_routes"]["job_id"] == "routes-job"
    assert response["refresh"]["geo_coverage"]["job_id"] == "geo-job"
    assert response["refresh"]["coverage"]["job_ids"] == ["coverage-job"]
    sync_mobility.assert_awaited_once()
    queue_routes.assert_awaited_once()
    queue_geo.assert_awaited_once()
    queue_coverage.assert_awaited_once()


@pytest.mark.asyncio
async def test_set_trip_inactive_is_noop_when_state_unchanged(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await Trip(
        transactionId="already-inactive",
        source="bouncie",
        startTime=datetime(2025, 1, 5, 8, tzinfo=UTC),
        endTime=datetime(2025, 1, 5, 9, tzinfo=UTC),
        inactive=True,
    ).insert()

    sync_mobility = AsyncMock()
    queue_routes = AsyncMock()
    queue_geo = AsyncMock()
    queue_coverage = AsyncMock()

    monkeypatch.setattr(InactiveTripService, "sync_mobility_profile", sync_mobility)
    monkeypatch.setattr(
        InactiveTripService,
        "queue_recurring_routes_refresh",
        queue_routes,
    )
    monkeypatch.setattr(
        InactiveTripService,
        "queue_geo_coverage_refresh",
        queue_geo,
    )
    monkeypatch.setattr(
        InactiveTripService,
        "queue_coverage_reprocessing_for_trip",
        queue_coverage,
    )

    response = await set_trip_inactive(
        "already-inactive",
        TripInactiveUpdate(inactive=True),
        BackgroundTasks(),
    )

    assert response["changed"] is False
    sync_mobility.assert_not_awaited()
    queue_routes.assert_not_awaited()
    queue_geo.assert_not_awaited()
    queue_coverage.assert_not_awaited()
