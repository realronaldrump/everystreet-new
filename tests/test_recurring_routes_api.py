from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from db.models import GasFillup, Job, RecurringRoute, Trip, Vehicle
from recurring_routes.api import routes as recurring_routes_api
from recurring_routes.models import BuildRecurringRoutesRequest
from recurring_routes.services.builder import RecurringRoutesBuilder


@pytest.fixture
async def routes_api_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,  # type: ignore[arg-type]
        document_models=[Trip, RecurringRoute, Job, GasFillup, Vehicle],
    )
    return database


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(recurring_routes_api.router)
    return app


def _gps_linestring(coords: list[list[float]]) -> dict:
    return {"type": "LineString", "coordinates": coords}


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
        json={"name": "Pinned Route", "color": "00ff00", "is_pinned": True, "is_hidden": False},
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

