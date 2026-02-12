from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from db.models import GasFillup, Job, Place, RecurringRoute, Trip, Vehicle
from recurring_routes.api import routes as recurring_routes_api
from recurring_routes.models import BuildRecurringRoutesRequest
from recurring_routes.services.builder import RecurringRoutesBuilder


@pytest.fixture
async def routes_api_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,  # type: ignore[arg-type]
        document_models=[Trip, RecurringRoute, Job, GasFillup, Vehicle, Place],
    )
    return database


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(recurring_routes_api.router)
    return app


def _gps_linestring(coords: list[list[float]]) -> dict:
    return {"type": "LineString", "coordinates": coords}


def _point(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [lon, lat]}


async def _seed_trips() -> None:
    now = datetime(2026, 2, 10, tzinfo=UTC)
    route1_coords = [[0.001, 0.001], [0.02, 0.02], [0.05, 0.05]]
    route2_coords = [[0.01, 0.001], [0.03, 0.0], [0.06, 0.02]]

    for i in range(3):
        st = now - timedelta(days=i)
        await Trip(
            transactionId=f"r1-{i}",
            imei="imei-1",
            startTime=st,
            endTime=st + timedelta(minutes=15),
            duration=900,
            distance=10.2,
            gps=_gps_linestring(route1_coords),
        ).insert()

    for i in range(2):
        st = now - timedelta(days=10 + i)
        await Trip(
            transactionId=f"r2-{i}",
            imei="imei-2",
            startTime=st,
            endTime=st + timedelta(minutes=10),
            duration=600,
            distance=5.2,
            gps=_gps_linestring(route2_coords),
        ).insert()


@pytest.mark.asyncio
async def test_list_recurring_routes_empty(routes_api_db) -> None:
    client = TestClient(_build_app())
    resp = client.get("/api/recurring_routes")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "routes": []}


@pytest.mark.asyncio
async def test_list_and_patch_routes_after_build(routes_api_db) -> None:
    await _seed_trips()
    await RecurringRoutesBuilder().run("test-job-1", BuildRecurringRoutesRequest())

    client = TestClient(_build_app())

    # Default view shows "recurring" routes (>=3 trips).
    resp = client.get("/api/recurring_routes")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert len(body["routes"]) == 1
    assert body["routes"][0]["trip_count"] == 3

    # Lowering min_trips should show both route templates.
    resp = client.get("/api/recurring_routes?min_trips=2")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert len(body["routes"]) == 2

    route_id = body["routes"][0]["id"]
    assert isinstance(route_id, str)
    assert route_id

    patch_resp = client.patch(
        f"/api/recurring_routes/{route_id}",
        json={
            "name": "Pinned Route",
            "color": "00ff00",
            "is_pinned": True,
            "is_hidden": False,
        },
    )
    assert patch_resp.status_code == 200
    patched = patch_resp.json()["route"]
    assert patched["name"] == "Pinned Route"
    assert patched["color"] == "#00ff00"
    assert patched["is_pinned"] is True
    assert patched["is_hidden"] is False

    get_resp = client.get(f"/api/recurring_routes/{route_id}")
    assert get_resp.status_code == 200
    route = get_resp.json()["route"]
    assert route["name"] == "Pinned Route"
    assert route["color"] == "#00ff00"


@pytest.mark.asyncio
async def test_route_detail_and_trips_include_place_links(routes_api_db) -> None:
    now = datetime(2026, 2, 10, tzinfo=UTC)
    coords = [[-122.401, 37.790], [-122.398, 37.786], [-122.394, 37.781]]

    start_place = Place(
        name="Home",
        geometry=_point(-122.401, 37.790),
        created_at=now,
    )
    await start_place.insert()

    end_place = Place(
        name="Office",
        geometry=_point(-122.394, 37.781),
        created_at=now,
    )
    await end_place.insert()

    for i in range(3):
        st = now - timedelta(days=i)
        await Trip(
            transactionId=f"pl-{i}",
            imei="imei-place",
            startTime=st,
            endTime=st + timedelta(minutes=20),
            duration=1200,
            distance=8.3,
            gps=_gps_linestring(coords),
            startGeoPoint=_point(-122.401, 37.790),
            destinationGeoPoint=_point(-122.394, 37.781),
            startPlaceId=str(start_place.id),
            destinationPlaceId=str(end_place.id),
            startLocation={"formatted_address": "Start Label"},
            destination={"formatted_address": "Destination Label"},
            destinationPlaceName="Destination Name",
        ).insert()

    await RecurringRoutesBuilder().run(
        "test-job-place-1",
        BuildRecurringRoutesRequest(),
    )

    route = await RecurringRoute.find_one({"trip_count": 3})
    assert route is not None
    route_id = str(route.id)

    client = TestClient(_build_app())

    list_resp = client.get("/api/recurring_routes")
    assert list_resp.status_code == 200
    listed = list_resp.json()["routes"]
    assert listed
    listed_route = listed[0]
    assert listed_route["start_label"] == "Home"
    assert listed_route["end_label"] == "Office"
    assert listed_route["start_place_id"] == str(start_place.id)
    assert listed_route["end_place_id"] == str(end_place.id)
    assert listed_route["place_links"]["start"]["id"] == str(start_place.id)
    assert listed_route["place_links"]["end"]["id"] == str(end_place.id)

    detail_resp = client.get(f"/api/recurring_routes/{route_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()["route"]
    assert detail["place_links"]["start"]["id"] == str(start_place.id)
    assert detail["place_links"]["start"]["label"] == "Home"
    assert detail["place_links"]["end"]["id"] == str(end_place.id)
    assert detail["place_links"]["end"]["label"] == "Office"

    trips_resp = client.get(f"/api/recurring_routes/{route_id}/trips")
    assert trips_resp.status_code == 200
    trips = trips_resp.json()["trips"]
    assert len(trips) == 3

    first = trips[0]
    assert first["startPlaceId"] == str(start_place.id)
    assert first["destinationPlaceId"] == str(end_place.id)
    assert first["startPlaceLabel"] == "Home"
    assert first["destinationPlaceLabel"] == "Office"
    assert first["place_links"]["start"]["href"] == f"/places/{start_place.id}"
    assert first["place_links"]["end"]["href"] == f"/places/{end_place.id}"


@pytest.mark.asyncio
async def test_route_analytics_timezone_buckets_are_complete(
    routes_api_db,
    monkeypatch,
) -> None:
    monkeypatch.setattr(recurring_routes_api, "get_mongo_tz_expr", lambda: "UTC")

    class _FakeAggregateCursor:
        async def to_list(self, _limit):
            return [
                {
                    "byHour": [
                        {
                            "_id": 8,
                            "count": 3,
                            "avgDistance": 10.0,
                            "avgDuration": 1000.0,
                        },
                    ],
                    "byDayOfWeek": [
                        {
                            "_id": 2,
                            "count": 3,
                            "avgDistance": 10.0,
                            "avgDuration": 1000.0,
                        },
                    ],
                    "byMonth": [
                        {"_id": "2026-02", "count": 3, "totalDistance": 30.0},
                    ],
                    "tripTimeline": [],
                    "stats": [
                        {
                            "_id": None,
                            "totalTrips": 3,
                            "totalDistance": 30.0,
                            "totalDuration": 3000.0,
                            "firstTrip": datetime(2026, 2, 1, tzinfo=UTC),
                            "lastTrip": datetime(2026, 2, 10, tzinfo=UTC),
                        },
                    ],
                },
            ]

    class _FakeTripsCollection:
        def aggregate(self, pipeline):
            hour_tz = pipeline[1]["$project"]["hour"]["$hour"].get("timezone")
            day_tz = pipeline[1]["$project"]["dayOfWeek"]["$dayOfWeek"].get("timezone")
            assert hour_tz == "UTC"
            assert day_tz == "UTC"
            return _FakeAggregateCursor()

    monkeypatch.setattr(
        Trip,
        "get_pymongo_collection",
        classmethod(lambda _cls: _FakeTripsCollection()),
    )

    route = RecurringRoute(
        route_key="tz-route-key",
        route_signature="tz-route-signature",
        auto_name="TZ Route",
        start_label="Start",
        end_label="End",
        trip_count=3,
    )
    await route.insert()

    client = TestClient(_build_app())
    analytics_resp = client.get(f"/api/recurring_routes/{route.id!s}/analytics")
    assert analytics_resp.status_code == 200
    body = analytics_resp.json()

    assert len(body["byHour"]) == 24
    assert len(body["byDayOfWeek"]) == 7

    hour_counts = [int(entry["count"]) for entry in body["byHour"]]
    day_counts = [int(entry["count"]) for entry in body["byDayOfWeek"]]
    assert sum(hour_counts) == 3
    assert sum(day_counts) == 3
    assert body["tripsPerWeek"] == pytest.approx(1.5)


@pytest.mark.asyncio
async def test_route_analytics_trips_per_week_single_trip_not_null(
    routes_api_db,
    monkeypatch,
) -> None:
    monkeypatch.setattr(recurring_routes_api, "get_mongo_tz_expr", lambda: "UTC")
    trip_time = datetime(2026, 2, 10, 8, 0, tzinfo=UTC)

    class _FakeAggregateCursor:
        async def to_list(self, _limit):
            return [
                {
                    "byHour": [
                        {
                            "_id": 8,
                            "count": 1,
                            "avgDistance": 10.0,
                            "avgDuration": 1000.0,
                        },
                    ],
                    "byDayOfWeek": [
                        {
                            "_id": 3,
                            "count": 1,
                            "avgDistance": 10.0,
                            "avgDuration": 1000.0,
                        },
                    ],
                    "byMonth": [
                        {"_id": "2026-02", "count": 1, "totalDistance": 10.0},
                    ],
                    "tripTimeline": [],
                    "stats": [
                        {
                            "_id": None,
                            "totalTrips": 1,
                            "totalDistance": 10.0,
                            "totalDuration": 1000.0,
                            "firstTrip": trip_time,
                            "lastTrip": trip_time,
                        },
                    ],
                },
            ]

    class _FakeTripsCollection:
        def aggregate(self, _pipeline):
            return _FakeAggregateCursor()

    monkeypatch.setattr(
        Trip,
        "get_pymongo_collection",
        classmethod(lambda _cls: _FakeTripsCollection()),
    )

    route = RecurringRoute(
        route_key="single-route-key",
        route_signature="single-route-signature",
        auto_name="Single Route",
        start_label="Start",
        end_label="End",
        trip_count=1,
    )
    await route.insert()

    client = TestClient(_build_app())
    analytics_resp = client.get(f"/api/recurring_routes/{route.id!s}/analytics")
    assert analytics_resp.status_code == 200
    body = analytics_resp.json()
    assert body["tripsPerWeek"] == pytest.approx(1.0)
