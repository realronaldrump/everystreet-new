import pytest
from beanie import init_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from db.models import BouncieCredentials, Vehicle
from gas.api import vehicles as vehicles_api


@pytest.fixture
async def vehicle_db():
    client = AsyncMongoMockClient()
    await init_beanie(
        database=client["test_db"],
        document_models=[Vehicle, BouncieCredentials],
    )
    return client


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(vehicles_api.router)
    return app


@pytest.mark.asyncio
async def test_delete_vehicle_removes_record_and_deauthorizes(vehicle_db) -> None:
    imei = "123456789012345"

    await BouncieCredentials(
        id="bouncie_credentials",
        authorized_devices=[imei, "other"],
    ).insert()
    await Vehicle(imei=imei, custom_name="Test", is_active=True).insert()

    client = TestClient(_build_app())
    resp = client.delete(f"/api/vehicles/{imei}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "success"

    assert await Vehicle.find_one(Vehicle.imei == imei) is None
    creds = await BouncieCredentials.find_one(
        BouncieCredentials.id == "bouncie_credentials",
    )
    assert creds is not None
    assert imei not in (creds.authorized_devices or [])

    # Also ensure the list endpoint doesn't return the deleted vehicle.
    list_resp = client.get("/api/vehicles?active_only=false")
    assert list_resp.status_code == 200
    assert list_resp.json() == []


@pytest.mark.asyncio
async def test_delete_vehicle_fails_if_deauth_update_fails(
    monkeypatch,
    vehicle_db,
) -> None:
    imei = "987654321098765"
    await BouncieCredentials(
        id="bouncie_credentials",
        authorized_devices=[imei],
    ).insert()
    await Vehicle(imei=imei, custom_name="Test", is_active=True).insert()

    async def _fail_update(_payload) -> bool:
        return False

    monkeypatch.setattr(
        "setup.services.bouncie_credentials.update_bouncie_credentials",
        _fail_update,
    )

    client = TestClient(_build_app())
    resp = client.delete(f"/api/vehicles/{imei}")
    assert resp.status_code == 500

    # Vehicle should still exist (we don't want to "succeed" only partially).
    assert await Vehicle.find_one(Vehicle.imei == imei) is not None
