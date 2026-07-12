from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException, status
from fastapi.testclient import TestClient

from db.models import Trip
from trips.api import crud, query
from trips.services.trip_query_service import TripQueryService


def test_recent_trip_history_route_wins_over_dynamic_trip_id_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recent_trips = [
        {
            "transactionId": "recent-trip",
            "source": "bouncie",
            "startTime": "2026-07-12T20:05:31+00:00",
            "endTime": "2026-07-12T20:11:11+00:00",
            "distance": 0.6,
            "destination": {"formatted_address": "Home"},
        }
    ]
    get_recent_trips = AsyncMock(return_value=recent_trips)
    monkeypatch.setattr(TripQueryService, "get_recent_trips", get_recent_trips)
    monkeypatch.setattr(
        crud,
        "_get_trip_or_404",
        AsyncMock(
            side_effect=HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )
        ),
    )

    app = FastAPI()
    app.include_router(query.router)
    app.include_router(crud.router)

    with TestClient(app) as client:
        response = client.get("/api/trips/history?limit=5")

    assert response.status_code == 200
    assert response.json() == {"trips": recent_trips}
    get_recent_trips.assert_awaited_once_with(5)


@pytest.mark.asyncio
async def test_recent_trip_history_returns_only_visible_bouncie_trips(
    beanie_db,
) -> None:
    del beanie_db
    await Trip(
        transactionId="older-visible",
        source="bouncie",
        startTime=datetime(2026, 7, 12, 18, tzinfo=UTC),
        endTime=datetime(2026, 7, 12, 19, tzinfo=UTC),
        distance=3.2,
    ).insert()
    await Trip(
        transactionId="newer-visible",
        source="bouncie",
        startTime=datetime(2026, 7, 12, 20, tzinfo=UTC),
        endTime=datetime(2026, 7, 12, 21, tzinfo=UTC),
        distance=4.8,
        destination={"formatted_address": "Home"},
        destinationGeoPoint={"type": "Point", "coordinates": [-97.1, 32.1]},
    ).insert()
    await Trip(
        transactionId="invalid-trip",
        source="bouncie",
        endTime=datetime(2026, 7, 12, 22, tzinfo=UTC),
        invalid=True,
    ).insert()
    await Trip(
        transactionId="inactive-trip",
        source="bouncie",
        endTime=datetime(2026, 7, 12, 23, tzinfo=UTC),
        inactive=True,
    ).insert()
    await Trip(
        transactionId="non-bouncie-trip",
        source="webhook",
        endTime=datetime(2026, 7, 13, 0, tzinfo=UTC),
    ).insert()

    trips = await TripQueryService.get_recent_trips(limit=10)

    assert [trip["transactionId"] for trip in trips] == [
        "newer-visible",
        "older-visible",
    ]
    assert trips[0]["endTime"] == "2026-07-12T21:00:00+00:00"
    assert trips[0]["destinationGeoPoint"] == {
        "type": "Point",
        "coordinates": [-97.1, 32.1],
    }
