from __future__ import annotations

import pytest
from db_helpers import init_mock_beanie

from db.models import Vehicle
from fleet.registry import (
    FleetRegistry,
    normalize_bouncie_vehicle,
)


@pytest.fixture
async def fleet_db():
    return await init_mock_beanie(Vehicle, database_name="test_fleet_writes_db")


def test_normalize_reads_nested_bouncie_model_shape() -> None:
    meta = normalize_bouncie_vehicle(
        {
            "imei": "111111111111111",
            "vin": "VIN1",
            "nickName": "Truck",
            "standardEngine": "5.0L",
            "model": {"make": "Ford", "name": "F150", "year": 2020},
        },
    )
    assert meta is not None
    assert (meta.make, meta.model, meta.year) == ("Ford", "F150", 2020)
    assert meta.default_name == "Truck"


def test_normalize_reads_flat_bouncie_shape_and_derives_a_name() -> None:
    meta = normalize_bouncie_vehicle(
        {"imei": "222222222222222", "make": "Ford", "model": "F150", "year": 2020},
    )
    assert meta is not None
    assert meta.default_name == "2020 Ford F150"


def test_normalize_rejects_entries_without_an_imei() -> None:
    assert normalize_bouncie_vehicle({"vin": "VIN1"}) is None
    assert normalize_bouncie_vehicle({"imei": "  "}) is None
    assert normalize_bouncie_vehicle("nope") is None


def test_default_name_falls_back_to_the_imei() -> None:
    meta = normalize_bouncie_vehicle({"imei": "333333333333333"})
    assert meta is not None
    assert meta.default_name == "Vehicle 333333333333333"


@pytest.mark.asyncio
async def test_register_device_creates_then_reactivates(fleet_db) -> None:
    del fleet_db
    imei = "444444444444444"

    created = await FleetRegistry.register_device(imei, custom_name="My car")
    assert created.is_active is True
    assert created.custom_name == "My car"

    await FleetRegistry.deactivate_device(imei)
    reactivated = await FleetRegistry.register_device(imei)

    assert reactivated.is_active is True
    assert reactivated.custom_name == "My car"
    assert await Vehicle.find(Vehicle.imei == imei).count() == 1


@pytest.mark.asyncio
async def test_bouncie_metadata_releases_a_vin_from_a_pre_existing_device(
    fleet_db,
) -> None:
    """The replacement tracker may already be registered with no VIN."""
    del fleet_db
    await Vehicle(imei="111111111111111", vin="SHARED", custom_name="Old").insert()
    await Vehicle(imei="222222222222222", vin=None, custom_name="New").insert()

    meta = normalize_bouncie_vehicle({"imei": "222222222222222", "vin": "SHARED"})
    assert meta is not None
    await FleetRegistry.apply_bouncie_metadata(meta)

    previous = await FleetRegistry.get_device("111111111111111")
    replacement = await FleetRegistry.get_device("222222222222222")
    assert previous is not None
    assert previous.vin is None
    assert replacement is not None
    assert replacement.vin == "SHARED"


@pytest.mark.asyncio
async def test_bouncie_metadata_leaves_a_retired_device_deactivated(fleet_db) -> None:
    del fleet_db
    imei = "555555555555555"
    await Vehicle(imei=imei, custom_name="Retired", is_active=False).insert()

    meta = normalize_bouncie_vehicle({"imei": imei, "nickName": "Bouncie name"})
    assert meta is not None
    await FleetRegistry.apply_bouncie_metadata(meta)

    saved = await FleetRegistry.get_device(imei)
    assert saved is not None
    assert saved.is_active is False
    assert saved.custom_name == "Retired"
    assert saved.bouncie_nickname == "Bouncie name"


@pytest.mark.asyncio
async def test_trip_recovery_never_overwrites_a_known_vin(fleet_db) -> None:
    del fleet_db
    imei = "666666666666666"
    await Vehicle(imei=imei, vin="AUTHORITATIVE", custom_name="Known").insert()

    vehicle, created = await FleetRegistry.recover_device_from_trips(
        imei,
        vin="FROM-TRIP",
    )

    assert created is False
    assert vehicle is not None
    assert vehicle.vin == "AUTHORITATIVE"
    assert vehicle.custom_name == "Known"


@pytest.mark.asyncio
async def test_trip_recovery_discovers_a_device_missing_from_bouncie(
    fleet_db,
) -> None:
    del fleet_db
    vehicle, created = await FleetRegistry.recover_device_from_trips(
        "777777777777777",
        vin="VIN-NEW",
    )

    assert created is True
    assert vehicle is not None
    assert vehicle.is_active is True
    assert vehicle.vin == "VIN-NEW"


@pytest.mark.asyncio
async def test_trip_recovery_fills_only_a_blank_vin(fleet_db) -> None:
    del fleet_db
    imei = "888888888888888"
    await Vehicle(imei=imei, vin=None, custom_name="Known").insert()

    vehicle, created = await FleetRegistry.recover_device_from_trips(
        imei,
        vin="FROM-TRIP",
    )

    assert created is False
    assert vehicle is not None
    assert vehicle.vin == "FROM-TRIP"


@pytest.mark.asyncio
async def test_assign_vin_releases_the_previous_holder(fleet_db) -> None:
    del fleet_db
    await Vehicle(imei="111111111111111", vin="SHARED").insert()
    await Vehicle(imei="222222222222222").insert()

    await FleetRegistry.assign_vin("222222222222222", "SHARED")

    previous = await FleetRegistry.get_device("111111111111111")
    assert previous is not None
    assert previous.vin is None
    holders = await Vehicle.find(Vehicle.vin == "SHARED").to_list()
    assert [v.imei for v in holders] == ["222222222222222"]


@pytest.mark.asyncio
async def test_deactivate_preserves_the_record(fleet_db) -> None:
    del fleet_db
    imei = "999999999999999"
    await Vehicle(imei=imei, vin="KEEP", custom_name="Keep me").insert()

    await FleetRegistry.deactivate_device(imei)

    saved = await FleetRegistry.get_device(imei)
    assert saved is not None
    assert saved.is_active is False
    assert saved.vin == "KEEP"
    assert await FleetRegistry.list_active_imeis() == []


@pytest.mark.asyncio
async def test_user_update_changes_owned_fields_without_touching_bouncie_metadata(
    fleet_db,
) -> None:
    del fleet_db
    imei = "121212121212121"
    await Vehicle(
        imei=imei,
        custom_name="Old name",
        make="Ford",
        model="F-150",
        year=2024,
        bouncie_nickname="Bouncie truck",
        standard_engine="5.0L",
        bouncie_data={"source": "bouncie"},
    ).insert()

    updated = await FleetRegistry.update_user_device(
        imei,
        custom_name="My truck",
        is_active=False,
        odometer_reading=1234.5,
        odometer_source="manual",
        odometer_is_estimated=False,
    )

    assert updated is not None
    assert updated.custom_name == "My truck"
    assert updated.is_active is False
    assert updated.odometer_reading == pytest.approx(1234.5)
    assert updated.odometer_source == "manual"
    assert updated.make == "Ford"
    assert updated.model == "F-150"
    assert updated.year == 2024
    assert updated.bouncie_nickname == "Bouncie truck"
    assert updated.standard_engine == "5.0L"
    assert updated.bouncie_data == {"source": "bouncie"}
