from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from db_helpers import init_mock_beanie

from db.models import Vehicle
from trips.services import trip_history_import_service_config as import_config


@pytest.fixture
async def fleet_db():
    return await init_mock_beanie(Vehicle)


@pytest.mark.asyncio
async def test_history_import_plan_uses_every_active_fleet_device(
    fleet_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del fleet_db
    await Vehicle(
        imei="111111111111111",
        custom_name="Known vehicle",
        is_active=True,
    ).insert()
    await Vehicle(
        imei="864486065781342",
        custom_name="VIN-less Bouncie device",
        vin=None,
        is_active=True,
    ).insert()
    await Vehicle(
        imei="999999999999999",
        custom_name="Retired device",
        is_active=False,
    ).insert()
    monkeypatch.setattr(
        import_config,
        "get_bouncie_config",
        AsyncMock(return_value={"fetch_concurrency": 50}),
    )

    plan = await import_config.build_import_plan(
        start_dt=datetime(2026, 1, 1, tzinfo=UTC),
        end_dt=datetime(2026, 1, 2, tzinfo=UTC),
    )

    assert [device["imei"] for device in plan["devices"]] == [
        "111111111111111",
        "864486065781342",
    ]
    assert plan["estimated_requests"] == 2
