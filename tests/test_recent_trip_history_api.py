from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException, status
from fastapi.testclient import TestClient

from core.trip_query_spec import TripQuerySpec
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
        response = client.get(
            "/api/trips/history"
            "?limit=5&start_date=2026-07-01&end_date=2026-07-12&imei=vehicle-1"
        )

    assert response.status_code == 200
    assert response.json() == {"trips": recent_trips}
    get_recent_trips.assert_awaited_once_with(
        5,
        start_date="2026-07-01",
        end_date="2026-07-12",
        imei="vehicle-1",
    )


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


@pytest.mark.asyncio
async def test_recent_trip_history_applies_date_range_and_vehicle_filters(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db
    # Mongomock does not implement MongoDB's timezone option for
    # $dateToString. Query-spec tests cover the production timezone expression;
    # this integration test exercises the same calendar bounds in UTC.
    monkeypatch.setattr(
        TripQuerySpec,
        "build_calendar_date_expr",
        staticmethod(
            lambda start_date, end_date, **_kwargs: {
                "$and": [
                    {
                        "$gte": [
                            {
                                "$dateToString": {
                                    "format": "%Y-%m-%d",
                                    "date": "$startTime",
                                }
                            },
                            start_date,
                        ]
                    },
                    {
                        "$lte": [
                            {
                                "$dateToString": {
                                    "format": "%Y-%m-%d",
                                    "date": "$startTime",
                                }
                            },
                            end_date,
                        ]
                    },
                ]
            }
        ),
    )
    for transaction_id, imei, start_time in (
        ("matching", "vehicle-1", datetime(2026, 7, 10, 18, tzinfo=UTC)),
        ("wrong-vehicle", "vehicle-2", datetime(2026, 7, 10, 19, tzinfo=UTC)),
        ("before-range", "vehicle-1", datetime(2026, 7, 8, 20, tzinfo=UTC)),
        ("after-range", "vehicle-1", datetime(2026, 7, 12, 21, tzinfo=UTC)),
    ):
        await Trip(
            transactionId=transaction_id,
            imei=imei,
            source="bouncie",
            startTime=start_time,
            endTime=start_time + timedelta(hours=1),
            distance=1.0,
        ).insert()

    trips = await TripQueryService.get_recent_trips(
        limit=10,
        start_date="2026-07-09",
        end_date="2026-07-11",
        imei="vehicle-1",
    )

    assert [trip["transactionId"] for trip in trips] == ["matching"]
