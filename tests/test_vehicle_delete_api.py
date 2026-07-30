import pytest
from db_helpers import init_mock_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient

from db.models import Vehicle
from gas.api import vehicles as vehicles_api


@pytest.fixture
async def vehicle_db():
    return await init_mock_beanie(Vehicle)


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(vehicles_api.router)
    return app


@pytest.mark.asyncio
async def test_update_vehicle_can_clear_odometer(vehicle_db) -> None:
    imei = "111111111111111"
    await Vehicle(
        imei=imei,
        custom_name="Test",
        is_active=True,
        odometer_reading=12345.0,
        odometer_source="manual",
        odometer_is_estimated=False,
    ).insert()

    client = TestClient(_build_app())
    resp = client.put(
        f"/api/vehicles/{imei}",
        json={"imei": imei, "odometer_reading": None},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["odometer_reading"] is None
    assert body["odometer_source"] is None
    assert body["odometer_is_estimated"] is False

    saved = await Vehicle.find_one(Vehicle.imei == imei)
    assert saved is not None
    assert saved.odometer_reading is None
    assert saved.odometer_source is None
    assert saved.odometer_is_estimated is False


@pytest.mark.asyncio
async def test_update_vehicle_stores_bouncie_override_as_untrusted(vehicle_db) -> None:
    imei = "222222222222222"
    await Vehicle(imei=imei, custom_name="Test", is_active=True).insert()

    client = TestClient(_build_app())
    resp = client.put(
        f"/api/vehicles/{imei}",
        json={
            "imei": imei,
            "odometer_reading": 12345.0,
            "odometer_source": "bouncie_untrusted",
            "odometer_is_estimated": True,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["odometer_reading"] == pytest.approx(12345.0)
    assert body["odometer_source"] == "bouncie_untrusted"
    assert body["odometer_is_estimated"] is True

    saved = await Vehicle.find_one(Vehicle.imei == imei)
    assert saved is not None
    assert saved.odometer_source == "bouncie_untrusted"
    assert saved.odometer_is_estimated is True


@pytest.mark.asyncio
async def test_delete_vehicle_deactivates_record_and_preserves_linkage(
    vehicle_db,
) -> None:
    imei = "123456789012345"

    await Vehicle(imei=imei, custom_name="Test", is_active=True).insert()

    client = TestClient(_build_app())
    resp = client.delete(f"/api/vehicles/{imei}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "success"

    saved = await Vehicle.find_one(Vehicle.imei == imei)
    assert saved is not None
    assert saved.is_active is False

    active_list = client.get("/api/vehicles?active_only=true")
    assert active_list.status_code == 200
    assert active_list.json() == []

    complete_list = client.get("/api/vehicles?active_only=false")
    assert complete_list.status_code == 200
    assert len(complete_list.json()) == 1
