from datetime import UTC, datetime

import pytest
from beanie import init_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from db.models import Place, Trip
from visits.api import places as places_api


@pytest.fixture
async def destination_bloom_places_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,  # type: ignore[arg-type]
        document_models=[Trip, Place],
    )
    return database


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(places_api.router)
    return app


def _point(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [lon, lat]}


def _linestring(coords: list[list[float]]) -> dict:
    return {"type": "LineString", "coordinates": coords}


@pytest.mark.asyncio
async def test_create_place_from_destination_bloom_backfills_boundary_and_seed_trips(
    destination_bloom_places_db,
) -> None:
    end_time = datetime(2026, 3, 10, 18, 0, tzinfo=UTC)

    await Trip(
        transactionId="trip-a",
        endTime=end_time,
        gps=_linestring([[-97.75, 30.25], [-97.7100, 30.2900]]),
        destinationGeoPoint=_point(-97.7100, 30.2900),
    ).insert()
    await Trip(
        transactionId="trip-b",
        endTime=end_time,
        gps=_linestring([[-97.73, 30.24], [-97.71004, 30.29003]]),
    ).insert()
    await Trip(
        transactionId="trip-c",
        endTime=end_time,
        gps=_linestring([[-97.76, 30.26], [-97.71002, 30.29002]]),
        destinationGeoPoint=_point(-97.71002, 30.29002),
    ).insert()
    await Trip(
        transactionId="trip-d",
        endTime=end_time,
        gps=_linestring([[-97.76, 30.26], [-97.7000, 30.3000]]),
        destinationGeoPoint=_point(-97.7000, 30.3000),
    ).insert()

    client = TestClient(_build_app())
    response = client.post(
        "/api/places/from_destination_bloom",
        json={
            "name": "Coffee Shop",
            "transactionIds": ["trip-a", "trip-b"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["place"]["name"] == "Coffee Shop"
    assert body["seedTrips"] == 2
    assert body["linkedTrips"] == 3

    place = await Place.find_one(Place.name == "Coffee Shop")
    assert place is not None
    assert place.geometry is not None

    trip_a = await Trip.find_one(Trip.transactionId == "trip-a")
    trip_b = await Trip.find_one(Trip.transactionId == "trip-b")
    trip_c = await Trip.find_one(Trip.transactionId == "trip-c")
    trip_d = await Trip.find_one(Trip.transactionId == "trip-d")

    assert trip_a is not None and trip_a.destinationPlaceName == "Coffee Shop"
    assert trip_b is not None and trip_b.destinationPlaceName == "Coffee Shop"
    assert trip_c is not None and trip_c.destinationPlaceName == "Coffee Shop"
    assert trip_d is not None and trip_d.destinationPlaceName is None

    expected_place_id = str(place.id)
    assert trip_a.destinationPlaceId == expected_place_id
    assert trip_b.destinationPlaceId == expected_place_id
    assert trip_c.destinationPlaceId == expected_place_id
    assert trip_d.destinationPlaceId is None


@pytest.mark.asyncio
async def test_create_place_from_destination_bloom_rejects_empty_transaction_ids(
    destination_bloom_places_db,
) -> None:
    client = TestClient(_build_app())
    response = client.post(
        "/api/places/from_destination_bloom",
        json={
            "name": "Coffee Shop",
            "transactionIds": [],
        },
    )

    assert response.status_code == 400
    assert "transactionId" in response.json()["detail"]


@pytest.mark.asyncio
async def test_create_place_from_destination_bloom_rejects_unknown_transaction_ids(
    destination_bloom_places_db,
) -> None:
    client = TestClient(_build_app())
    response = client.post(
        "/api/places/from_destination_bloom",
        json={
            "name": "Coffee Shop",
            "transactionIds": ["missing-trip"],
        },
    )

    assert response.status_code == 400
    assert "No persisted trips found" in response.json()["detail"]
