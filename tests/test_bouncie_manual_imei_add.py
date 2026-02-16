from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from db.models import BouncieCredentials, Vehicle
from user_profile.api import BouncieVehicleCreate, add_bouncie_vehicle


@pytest.fixture
async def profile_db():
    client = AsyncMongoMockClient()
    await init_beanie(
        database=client["test_db"],
        document_models=[Vehicle, BouncieCredentials],
    )
    return client


@pytest.mark.asyncio
async def test_add_bouncie_vehicle_allows_imei_only_when_not_in_vehicle_search(
    profile_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    imei = "123456789012345"

    await BouncieCredentials(
        id="bouncie_credentials",
        client_id="client",
        client_secret="secret",
        redirect_uri="https://example.com/callback",
        authorization_code="auth-code",
        authorized_devices=[],
    ).insert()

    monkeypatch.setattr(
        "user_profile.api.get_session",
        AsyncMock(return_value=MagicMock()),
    )
    monkeypatch.setattr(
        "setup.services.bouncie_oauth.BouncieOAuth.get_access_token",
        AsyncMock(return_value="token"),
    )
    monkeypatch.setattr(
        "setup.services.bouncie_api.fetch_vehicle_by_imei",
        AsyncMock(return_value=None),
    )

    result = await add_bouncie_vehicle(
        BouncieVehicleCreate(
            imei=imei,
            custom_name="Trailer Tracker",
            authorize=True,
            sync_trips=False,
        ),
    )

    assert result["status"] == "success"
    assert "IMEI-only" in result["message"]

    vehicle = await Vehicle.find_one(Vehicle.imei == imei)
    assert vehicle is not None
    assert vehicle.imei == imei
    assert vehicle.custom_name == "Trailer Tracker"
    assert vehicle.vin is None
    assert vehicle.make is None
    assert vehicle.model is None
    assert vehicle.year is None
    assert getattr(vehicle, "bouncie_data", None) is None
    assert getattr(vehicle, "last_synced_at", None) is None

    creds = await BouncieCredentials.find_one(
        BouncieCredentials.id == "bouncie_credentials",
    )
    assert creds is not None
    assert imei in (creds.authorized_devices or [])


@pytest.mark.asyncio
async def test_add_bouncie_vehicle_uses_vehicle_metadata_when_available(
    profile_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    imei = "987654321098765"

    await BouncieCredentials(
        id="bouncie_credentials",
        client_id="client",
        client_secret="secret",
        redirect_uri="https://example.com/callback",
        authorization_code="auth-code",
        authorized_devices=[],
    ).insert()

    monkeypatch.setattr(
        "user_profile.api.get_session",
        AsyncMock(return_value=MagicMock()),
    )
    monkeypatch.setattr(
        "setup.services.bouncie_oauth.BouncieOAuth.get_access_token",
        AsyncMock(return_value="token"),
    )
    monkeypatch.setattr(
        "setup.services.bouncie_api.fetch_vehicle_by_imei",
        AsyncMock(
            return_value={
                "imei": imei,
                "vin": "VIN123",
                "model": {
                    "make": "Toyota",
                    "name": "Camry",
                    "year": 2022,
                },
                "nickName": "Car A",
                "standardEngine": "2.5L",
            },
        ),
    )

    result = await add_bouncie_vehicle(
        BouncieVehicleCreate(
            imei=imei,
            authorize=True,
            sync_trips=False,
        ),
    )

    assert result["status"] == "success"
    assert "IMEI-only" not in result["message"]

    vehicle = await Vehicle.find_one(Vehicle.imei == imei)
    assert vehicle is not None
    assert vehicle.vin == "VIN123"
    assert vehicle.make == "Toyota"
    assert vehicle.model == "Camry"
    assert vehicle.year == 2022
    assert getattr(vehicle, "bouncie_data", None) is not None
    assert getattr(vehicle, "last_synced_at", None) is not None
