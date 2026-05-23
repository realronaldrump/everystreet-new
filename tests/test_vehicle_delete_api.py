import pytest
from db_helpers import init_mock_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient

from db.models import BouncieCredentials, Vehicle
from gas.api import vehicles as vehicles_api


@pytest.fixture
async def vehicle_db():
    return await init_mock_beanie(Vehicle, BouncieCredentials)


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
