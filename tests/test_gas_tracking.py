from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from core.exceptions import ValidationException
from db.models import GasFillup, Trip, Vehicle
from db.schemas import GasFillupUpdateModel
from gas.services.fillup_service import FillupService
from gas.services.odometer_service import OdometerService


@pytest.mark.asyncio
async def test_create_fillup_calculates_mpg_using_previous_sorted_fillup(
    beanie_db,
) -> None:
    imei = "imei-123"
    await Vehicle(imei=imei, vin="VIN-123").insert()

    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await GasFillup(
        imei=imei,
        vin="VIN-123",
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    t2 = t1 + timedelta(days=1)
    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "price_per_gallon": 3.5,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert created.vin == "VIN-123"
    assert created.previous_odometer == pytest.approx(1000.0)
    assert created.miles_since_last_fillup == pytest.approx(100.0)
    assert created.calculated_mpg == pytest.approx(10.0)
    assert created.total_cost == pytest.approx(35.0)


@pytest.mark.asyncio
async def test_update_fillup_missed_previous_clears_mpg(beanie_db) -> None:
    imei = "imei-456"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await GasFillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    t2 = t1 + timedelta(days=1)
    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert created.calculated_mpg == pytest.approx(10.0)

    updated = await FillupService.update_fillup(
        str(created.id),
        {"missed_previous": True},
    )

    assert updated.calculated_mpg is None
    assert updated.miles_since_last_fillup is None
    assert updated.previous_odometer == pytest.approx(1000.0)


@pytest.mark.asyncio
async def test_update_fillup_rejects_null_boolean_flags(beanie_db) -> None:
    imei = "imei-null-flags"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t1,
            "gallons": 10.0,
            "odometer": 1000.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    with pytest.raises(ValidationException):
        await FillupService.update_fillup(str(created.id), {"is_full_tank": None})

    with pytest.raises(ValidationException):
        await FillupService.update_fillup(str(created.id), {"missed_previous": None})


@pytest.mark.asyncio
async def test_update_fillup_recalculates_next_fillup(beanie_db) -> None:
    imei = "imei-789"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await GasFillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    t2 = t1 + timedelta(days=1)
    b = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    t3 = t2 + timedelta(days=1)
    c = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t3,
            "gallons": 10.0,
            "odometer": 1200.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert c.previous_odometer == pytest.approx(1100.0)
    assert c.calculated_mpg == pytest.approx(10.0)

    await FillupService.update_fillup(str(b.id), {"odometer": 1120.0})

    refreshed = await GasFillup.get(c.id)
    assert refreshed is not None
    assert refreshed.previous_odometer == pytest.approx(1120.0)
    assert refreshed.calculated_mpg == pytest.approx(8.0)


@pytest.mark.asyncio
async def test_estimate_odometer_reading_uses_fillup_anchor_and_trip_distance(
    beanie_db,
) -> None:
    imei = "imei-odo"
    anchor_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await GasFillup(
        imei=imei,
        fillup_time=anchor_time,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    await Trip(
        transactionId="tx-odo-1",
        imei=imei,
        startTime=anchor_time + timedelta(hours=1),
        endTime=anchor_time + timedelta(hours=2),
        distance=50.0,
    ).insert()

    target_time = anchor_time + timedelta(hours=3)
    result = await OdometerService.estimate_odometer_reading(
        imei,
        target_time.isoformat(),
    )

    assert result["method"] == "calculated_from_prev"
    assert result["anchor_odometer"] == pytest.approx(1000.0)
    assert result["distance_diff"] == pytest.approx(50.0)
    assert result["estimated_odometer"] == pytest.approx(1050.0)


@pytest.mark.asyncio
async def test_create_fillup_requires_is_full_tank(beanie_db) -> None:
    with pytest.raises(ValidationException):
        await FillupService.create_fillup(
            {
                "imei": "imei-required-full",
                "fillup_time": datetime(2024, 1, 1, 12, 0, tzinfo=UTC),
                "gallons": 8.0,
                "odometer": 5000.0,
            },
        )


@pytest.mark.asyncio
async def test_create_fillup_rolls_up_partial_fill_chain_for_mpg(beanie_db) -> None:
    imei = "imei-partial-chain"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)
    t3 = t2 + timedelta(days=1)

    await GasFillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    partial = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 3.0,
            "odometer": 1050.0,
            "is_full_tank": False,
            "missed_previous": False,
        },
    )
    assert partial.calculated_mpg is None
    assert partial.previous_odometer == pytest.approx(1000.0)

    full = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t3,
            "gallons": 6.0,
            "odometer": 1200.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert full.previous_odometer == pytest.approx(1000.0)
    assert full.miles_since_last_fillup == pytest.approx(200.0)
    assert full.calculated_mpg == pytest.approx(200.0 / 9.0)


@pytest.mark.asyncio
async def test_create_fillup_uses_full_anchor_marked_missed_previous(beanie_db) -> None:
    imei = "imei-anchor-missed-prev"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)

    await GasFillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=True,
    ).insert()

    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert created.previous_odometer == pytest.approx(1000.0)
    assert created.miles_since_last_fillup == pytest.approx(100.0)
    assert created.calculated_mpg == pytest.approx(10.0)


@pytest.mark.asyncio
async def test_update_fillup_recalculates_same_timestamp_next_fillup(beanie_db) -> None:
    imei = "imei-same-time"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)

    await GasFillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    b = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )
    c = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1200.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert c.previous_odometer == pytest.approx(1100.0)
    assert c.calculated_mpg == pytest.approx(10.0)

    await FillupService.update_fillup(str(b.id), {"odometer": 1120.0})

    refreshed = await GasFillup.get(c.id)
    assert refreshed is not None
    assert refreshed.previous_odometer == pytest.approx(1120.0)
    assert refreshed.calculated_mpg == pytest.approx(8.0)


@pytest.mark.asyncio
async def test_recalculate_subsequent_fillup_does_not_raise_on_internal_errors(
    monkeypatch,
) -> None:
    async def boom(**_kwargs):
        msg = "simulated failure"
        raise RuntimeError(msg)

    monkeypatch.setattr(FillupService, "_get_next_fillup", boom)

    await FillupService.recalculate_subsequent_fillup(
        "imei-recalc-safe",
        datetime(2024, 1, 1, 12, 0, tzinfo=UTC),
    )


def test_gas_fillup_update_model_allows_partial_payloads() -> None:
    payload = GasFillupUpdateModel(missed_previous=True)
    assert payload.model_dump(exclude_unset=True) == {"missed_previous": True}


@pytest.mark.parametrize("field_name", ["is_full_tank", "missed_previous"])
def test_gas_fillup_update_model_rejects_null_boolean_flags(field_name: str) -> None:
    with pytest.raises(ValidationError):
        GasFillupUpdateModel(**{field_name: None})
