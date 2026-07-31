from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from db_helpers import init_mock_beanie

from db.models import Vehicle
from setup.services import bouncie_sync


@pytest.fixture
async def fleet_db():
    return await init_mock_beanie(Vehicle)


@pytest.mark.asyncio
async def test_bouncie_refresh_preserves_local_name_and_enriches_metadata(
    fleet_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del fleet_db
    imei = "123456789012345"
    await Vehicle(
        imei=imei,
        custom_name="My local name",
        is_active=True,
    ).insert()
    monkeypatch.setattr(
        bouncie_sync,
        "_fetch_vehicles",
        AsyncMock(
            return_value=[
                {
                    "imei": imei,
                    "vin": "VIN123",
                    "nickName": "Bouncie name",
                    "standardEngine": "2.5L",
                    "model": {
                        "make": "Toyota",
                        "name": "Camry",
                        "year": 2022,
                    },
                },
            ],
        ),
    )

    result = await bouncie_sync.sync_bouncie_vehicles(
        session=object(),
        token="token",
        credentials={"client_id": "client"},
    )

    assert result["imeis"] == [imei]
    saved = await Vehicle.find_one(Vehicle.imei == imei)
    assert saved is not None
    assert saved.custom_name == "My local name"
    assert saved.bouncie_nickname == "Bouncie name"
    assert saved.standard_engine == "2.5L"
    assert saved.bouncie_data is not None
    assert saved.last_synced_at is not None


@pytest.mark.asyncio
async def test_bouncie_refresh_never_reassigns_an_existing_device_by_vin(
    fleet_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del fleet_db
    shared_vin = "VIN123"
    old_imei = "111111111111111"
    new_imei = "222222222222222"
    await Vehicle(
        imei=old_imei,
        vin=shared_vin,
        custom_name="Original device",
        is_active=False,
    ).insert()
    monkeypatch.setattr(
        bouncie_sync,
        "_fetch_vehicles",
        AsyncMock(
            return_value=[
                {
                    "imei": new_imei,
                    "vin": shared_vin,
                    "nickName": "Replacement device",
                    "model": {"make": "Toyota", "name": "Camry", "year": 2022},
                },
            ],
        ),
    )

    await bouncie_sync.sync_bouncie_vehicles(
        session=object(),
        token="token",
        credentials={"client_id": "client"},
    )

    assert await Vehicle.find_one(Vehicle.imei == old_imei) is not None
    replacement = await Vehicle.find_one(Vehicle.imei == new_imei)
    assert replacement is not None
    assert replacement.vin == shared_vin


@pytest.mark.asyncio
async def test_bouncie_refresh_releases_vin_when_replacement_device_already_exists(
    fleet_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del fleet_db
    shared_vin = "VIN123"
    old_imei = "111111111111111"
    new_imei = "222222222222222"
    await Vehicle(imei=old_imei, vin=shared_vin, custom_name="Original").insert()
    await Vehicle(imei=new_imei, vin=None, custom_name="Replacement").insert()
    monkeypatch.setattr(
        bouncie_sync,
        "_fetch_vehicles",
        AsyncMock(
            return_value=[
                {
                    "imei": new_imei,
                    "vin": shared_vin,
                    "nickName": "Replacement device",
                },
            ],
        ),
    )

    await bouncie_sync.sync_bouncie_vehicles(
        session=object(),
        token="token",
        credentials={"client_id": "client"},
    )

    previous = await Vehicle.find_one(Vehicle.imei == old_imei)
    replacement = await Vehicle.find_one(Vehicle.imei == new_imei)
    assert previous is not None
    assert previous.vin is None
    assert replacement is not None
    assert replacement.vin == shared_vin


@pytest.mark.asyncio
async def test_bouncie_refresh_keeps_vin_when_same_device_resyncs(
    fleet_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del fleet_db
    imei = "444444444444444"
    vin = "VIN456"
    await Vehicle(imei=imei, vin=vin, custom_name="Unchanged").insert()
    monkeypatch.setattr(
        bouncie_sync,
        "_fetch_vehicles",
        AsyncMock(return_value=[{"imei": imei, "vin": vin}]),
    )

    await bouncie_sync.sync_bouncie_vehicles(
        session=object(),
        token="token",
        credentials={"client_id": "client"},
    )

    saved = await Vehicle.find_one(Vehicle.imei == imei)
    assert saved is not None
    assert saved.vin == vin


@pytest.mark.asyncio
async def test_bouncie_refresh_preserves_local_device_deactivation(
    fleet_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del fleet_db
    imei = "333333333333333"
    await Vehicle(imei=imei, custom_name="Retired tracker", is_active=False).insert()
    monkeypatch.setattr(
        bouncie_sync,
        "_fetch_vehicles",
        AsyncMock(return_value=[{"imei": imei, "nickName": "Bouncie name"}]),
    )

    await bouncie_sync.sync_bouncie_vehicles(
        session=object(),
        token="token",
        credentials={"client_id": "client"},
    )

    saved = await Vehicle.find_one(Vehicle.imei == imei)
    assert saved is not None
    assert saved.is_active is False
