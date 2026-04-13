from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from api.concierge import router as concierge_router
from db.models import (
    AppSettings,
    BouncieCredentials,
    CoverageArea,
    GasFillup,
    Job,
    TaskConfig,
    TaskHistory,
    Trip,
    Vehicle,
)
from map_data.models import MapServiceConfig
from street_coverage.api.atlas import router as atlas_router


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(concierge_router)
    app.include_router(atlas_router)
    return app


@pytest.fixture
async def concierge_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,
        document_models=[
            AppSettings,
            BouncieCredentials,
            CoverageArea,
            GasFillup,
            Job,
            MapServiceConfig,
            TaskConfig,
            TaskHistory,
            Trip,
            Vehicle,
        ],
    )
    return database


async def _seed_concierge_state() -> None:
    now = datetime.now(UTC)
    await BouncieCredentials(
        client_id="client",
        client_secret="secret",
        redirect_uri="https://example.com/callback",
        authorization_code="auth-code",
        authorized_devices=["device-1"],
        access_token="token",
        expires_at=(now + timedelta(hours=1)).timestamp(),
    ).insert()
    await TaskConfig(
        task_id="periodic_fetch_trips",
        enabled=True,
        interval_minutes=15,
        config={"last_success_time": now.isoformat()},
    ).insert()
    map_config = MapServiceConfig(
        status=MapServiceConfig.STATUS_READY,
        geocoding_ready=True,
        routing_ready=True,
        message="Map services are ready.",
        last_updated=now,
    )
    await map_config.insert()
    await Vehicle(
        imei="device-1",
        custom_name="Grand Tourer",
        is_active=True,
        odometer_reading=12345.6,
        odometer_source="bouncie",
        odometer_updated_at=now,
    ).insert()
    await Trip(
        transactionId="trip-1",
        imei="device-1",
        source="bouncie",
        startTime=now - timedelta(hours=1),
        endTime=now,
        distance=24.5,
        duration=1800,
        gps={"type": "LineString", "coordinates": [[-97.0, 31.0], [-97.1, 31.1]]},
    ).insert()
    await CoverageArea(
        display_name="Waco",
        area_type="city",
        status="ready",
        health="healthy",
        total_length_miles=100,
        driveable_length_miles=90,
        driven_length_miles=45,
        coverage_percentage=50,
        total_segments=1000,
        driven_segments=500,
        last_synced=now,
        road_filter_version="public-v1",
    ).insert()
    await GasFillup(
        imei="device-1",
        fillup_time=now - timedelta(days=2),
        gallons=10,
        total_cost=34,
        odometer=12300,
    ).insert()


@pytest.mark.asyncio
async def test_concierge_status_composes_primary_state(concierge_db) -> None:
    await _seed_concierge_state()
    client = TestClient(_build_app())

    response = client.get("/api/concierge/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["overall"]["state"] == "ready"
    assert payload["vehicle"]["label"] == "Grand Tourer"
    assert payload["coverage"]["territory_count"] == 1
    assert payload["maps"]["state"] == "ready"


@pytest.mark.asyncio
async def test_coverage_atlas_returns_selected_territory(concierge_db) -> None:
    await _seed_concierge_state()
    client = TestClient(_build_app())

    response = client.get("/api/coverage/atlas")

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["territory_count"] == 1
    assert payload["selected_territory"]["name"] == "Waco"
    assert payload["recommended_next_action"]["kind"] == "next_drive"


@pytest.mark.asyncio
async def test_journey_garage_and_fuel_endpoints_degrade_cleanly(concierge_db) -> None:
    client = TestClient(_build_app())

    journey = client.get("/api/journey/feed")
    garage = client.get("/api/garage/summary")
    fuel = client.get("/api/fuel/suggestions")

    assert journey.status_code == 200
    assert journey.json()["summary"]["total_trips"] == 0
    assert garage.status_code == 200
    assert garage.json()["summary"]["vehicle_count"] == 0
    assert fuel.status_code == 200
    assert fuel.json()["summary"]["suggestion_count"] == 1
