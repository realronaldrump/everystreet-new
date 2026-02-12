from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from db.models import GasFillup, Job, RecurringRoute, Trip, Vehicle
from recurring_routes.models import BuildRecurringRoutesRequest
from recurring_routes.services.builder import RecurringRoutesBuilder


@pytest.fixture
async def routes_beanie_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,  # type: ignore[arg-type]
        document_models=[Trip, RecurringRoute, Job, GasFillup, Vehicle],
    )
    return database


def _gps_linestring(coords: list[list[float]]) -> dict:
    return {"type": "LineString", "coordinates": coords}


async def _insert_trip(
    *,
    transaction_id: str,
    start_time: datetime,
    coords: list[list[float]],
    distance_miles: float,
    duration_sec: float,
    imei: str = "imei-1",
    invalid: bool | None = None,
) -> None:
    trip = Trip(
        transactionId=transaction_id,
        imei=imei,
        startTime=start_time,
        endTime=start_time + timedelta(seconds=int(duration_sec)),
        duration=duration_sec,
        distance=distance_miles,
        gps=_gps_linestring(coords),
        invalid=invalid,
    )
    await trip.insert()


@pytest.mark.asyncio
async def test_builder_creates_routes_and_assigns_trips(routes_beanie_db) -> None:
    now = datetime(2026, 2, 10, tzinfo=UTC)

    route1_coords = [[0.001, 0.001], [0.02, 0.02], [0.05, 0.05]]
    route2_coords = [[0.01, 0.001], [0.03, 0.0], [0.06, 0.02]]

    for i in range(3):
        await _insert_trip(
            transaction_id=f"r1-{i}",
            start_time=now - timedelta(days=i),
            coords=route1_coords,
            distance_miles=10.2,
            duration_sec=900,
            imei="imei-1",
        )

    for i in range(2):
        await _insert_trip(
            transaction_id=f"r2-{i}",
            start_time=now - timedelta(days=10 + i),
            coords=route2_coords,
            distance_miles=5.2,
            duration_sec=600,
            imei="imei-2",
        )

    # Invalid trips should be excluded from clustering + assignment.
    await _insert_trip(
        transaction_id="invalid-0",
        start_time=now - timedelta(days=2),
        coords=route1_coords,
        distance_miles=10.2,
        duration_sec=900,
        imei="imei-1",
        invalid=True,
    )

    builder = RecurringRoutesBuilder()
    result = await builder.run(
        job_id="test-job-1",
        request=BuildRecurringRoutesRequest(),
    )
    assert result["status"] == "success"

    routes = await RecurringRoute.find({}).to_list()
    assert len(routes) == 2

    route1 = next(r for r in routes if r.trip_count == 3)
    route2 = next(r for r in routes if r.trip_count == 2)

    assert route1.is_recurring is True
    assert route2.is_recurring is False

    trip = await Trip.find_one(Trip.transactionId == "r1-0")
    assert trip is not None
    assert trip.recurringRouteId == route1.id

    trip = await Trip.find_one(Trip.transactionId == "r2-0")
    assert trip is not None
    assert trip.recurringRouteId == route2.id

    invalid_trip = await Trip.find_one(Trip.transactionId == "invalid-0")
    assert invalid_trip is not None
    assert invalid_trip.recurringRouteId is None


@pytest.mark.asyncio
async def test_builder_preserves_user_fields_across_rebuild(routes_beanie_db) -> None:
    now = datetime(2026, 2, 10, tzinfo=UTC)
    coords = [[0.001, 0.001], [0.02, 0.02], [0.05, 0.05]]

    for i in range(3):
        await _insert_trip(
            transaction_id=f"r1-{i}",
            start_time=now - timedelta(days=i),
            coords=coords,
            distance_miles=10.2,
            duration_sec=900,
            imei="imei-1",
        )

    builder = RecurringRoutesBuilder()
    await builder.run(job_id="test-job-1", request=BuildRecurringRoutesRequest())

    route = await RecurringRoute.find_one({})
    assert route is not None

    route.name = "My commute"
    route.color = "#ff0000"
    route.is_pinned = True
    route.is_hidden = True
    await route.save()

    await builder.run(job_id="test-job-2", request=BuildRecurringRoutesRequest())

    refreshed = await RecurringRoute.get(route.id)
    assert refreshed is not None
    assert refreshed.name == "My commute"
    assert refreshed.color == "#ff0000"
    assert refreshed.is_pinned is True
    assert refreshed.is_hidden is True


@pytest.mark.asyncio
async def test_builder_unsets_recurring_route_id_for_ineligible_trips(
    routes_beanie_db,
) -> None:
    now = datetime(2026, 2, 10, tzinfo=UTC)
    coords = [[0.001, 0.001], [0.02, 0.02], [0.05, 0.05]]

    for i in range(3):
        await _insert_trip(
            transaction_id=f"r1-{i}",
            start_time=now - timedelta(days=i),
            coords=coords,
            distance_miles=10.2,
            duration_sec=900,
            imei="imei-1",
        )

    builder = RecurringRoutesBuilder()
    await builder.run(job_id="test-job-1", request=BuildRecurringRoutesRequest())

    trips_coll = Trip.get_pymongo_collection()
    raw_before = await trips_coll.find_one({"transactionId": "r1-0"})
    assert raw_before is not None
    assert "recurringRouteId" in raw_before

    trip = await Trip.find_one(Trip.transactionId == "r1-0")
    assert trip is not None
    trip.invalid = True
    await trip.save()

    await builder.run(job_id="test-job-2", request=BuildRecurringRoutesRequest())

    raw_after = await trips_coll.find_one({"transactionId": "r1-0"})
    assert raw_after is not None
    assert "recurringRouteId" not in raw_after
